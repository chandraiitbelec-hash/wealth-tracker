"""
News Feed Ingestion — RSS → PostgreSQL
---------------------------------------
Fetches articles from curated Indian financial RSS feeds, categorises them,
tags any NSE symbols mentioned in the headline, and stores in news_articles.

Three zoom levels (stored as `category`):
  economy  — macro: RBI, GDP, inflation, budget, trade, policy
  market   — indices, FII/DII flows, sector rotation, F&O activity
  stocks   — company-specific news, results, management changes
  mf       — mutual fund flows, NAV, AMFI, SIP data

Portfolio tagging:
  After inserting, the article title + summary are scanned for any company
  name or NSE symbol from equity_master. Matches are stored in
  tagged_symbols[]. The web API then uses this to surface relevant articles
  for a user's specific holdings.

Schedule:
  Every 15 minutes during market hours (9:00 AM – 4:00 PM IST)
  Every 60 minutes off-hours
  → Wired in scheduler.py with two separate triggers.

Source selection rationale:
  - Economic Times / Mint / Business Standard: broad coverage, fast update
  - Moneycontrol: best market microstructure news
  - RBI / SEBI: primary source, zero editorial lag on policy
  - NSE circulars: directly from exchange, ahead of any media
"""

import re
import html
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone, timedelta
from typing import Optional, List, Dict, Tuple
from email.utils import parsedate_to_datetime

import feedparser
import requests
from psycopg2.extras import execute_values

from db.connection import get_connection
from utils.logger import get_logger

# ── Module-level constants ─────────────────────────────────────────────────────

# Discard articles older than this — keeps ingestion tight and prevents backfill
# of stale articles when a feed is unavailable for a period.
ARTICLE_MAX_AGE_HOURS = 48

# Rows older than this are pruned by _prune_old_articles() to cap table growth.
ARTICLE_RETENTION_DAYS = 7

log = get_logger("news_feed")

# ── Feed registry ─────────────────────────────────────────────────────────────
# (name, url, default_category)
# Category is a starting point — article-level keywords can override it.

FEEDS: List[Tuple[str, str, str]] = [
    # Economy / Macro
    ("rbi",           "https://www.rbi.org.in/scripts/rss.aspx",                           "economy"),
    ("sebi",          "https://www.sebi.gov.in/sebi_data/rss/rss.xml",                     "economy"),
    ("et_economy",    "https://economictimes.indiatimes.com/news/economy/rss.cms",          "economy"),
    ("mint_economy",  "https://www.livemint.com/rss/economy",                               "economy"),
    ("bs_economy",    "https://www.business-standard.com/rss/economy-policy-10601.rss",     "economy"),

    # Market / Indices
    ("et_markets",    "https://economictimes.indiatimes.com/markets/rss.cms",               "market"),
    ("mc_markets",    "https://www.moneycontrol.com/rss/marketreports.xml",                 "market"),
    ("mc_top",        "https://www.moneycontrol.com/rss/MCtopnews.xml",                    "market"),
    ("bs_markets",    "https://www.business-standard.com/rss/markets-106.rss",              "market"),
    ("ft_india",      "https://feeds.ft.com/ft/indiacoverage",                              "market"),

    # Stocks / Companies
    ("et_stocks",     "https://economictimes.indiatimes.com/markets/stocks/rss.cms",        "stocks"),
    ("mc_stocks",     "https://www.moneycontrol.com/rss/results.xml",                       "stocks"),
    ("bs_companies",  "https://www.business-standard.com/rss/companies-101.rss",            "stocks"),

    # Mutual Funds
    ("et_mf",         "https://economictimes.indiatimes.com/mf/rss.cms",                   "mf"),
    ("mc_mf",         "https://www.moneycontrol.com/rss/mutualfunds.xml",                  "mf"),
    ("mint_mf",       "https://www.livemint.com/rss/mutual-fund",                           "mf"),
]

# ── Category keyword overrides ────────────────────────────────────────────────
# If the title/summary contains any of these phrases, override the feed default.

ECONOMY_KWORDS = {
    "rbi", "reserve bank", "repo rate", "gdp", "inflation", "cpi", "wpi",
    "fiscal deficit", "budget", "trade deficit", "current account", "imf",
    "world bank", "export", "import", "monsoon", "gst", "sebi", "irdai",
    "forex", "rupee", "dollar", "oil price", "crude",
}
MARKET_KWORDS = {
    "nifty", "sensex", "bse", "nse", "fii", "dii", "fpi", "index",
    "options", "futures", "derivative", "open interest", "put call",
    "circuit breaker", "bull run", "bear market", "correction",
    "sector rotation", "breadth", "advance decline",
}
MF_KWORDS = {
    "mutual fund", "sip", "nav", "amfi", "aum", "elss", "debt fund",
    "equity fund", "folio", "redemption", "scheme", "fund manager",
}

# ── HTML stripping ─────────────────────────────────────────────────────────────

_TAG_RE = re.compile(r"<[^>]+>")

def _clean(text: str) -> str:
    if not text:
        return ""
    text = _TAG_RE.sub(" ", html.unescape(text))
    return " ".join(text.split())[:1000]


# ── Date parsing ──────────────────────────────────────────────────────────────

def _parse_date(entry) -> datetime:
    """Parse feedparser entry date; fall back to now if unparseable."""
    for attr in ("published_parsed", "updated_parsed", "created_parsed"):
        val = getattr(entry, attr, None)
        if val:
            try:
                return datetime(*val[:6], tzinfo=timezone.utc)
            except Exception:
                pass
    # Try string parse
    for attr in ("published", "updated"):
        raw = getattr(entry, attr, None)
        if raw:
            try:
                return parsedate_to_datetime(raw).astimezone(timezone.utc).replace(tzinfo=None)
            except Exception:
                pass
    return datetime.utcnow()


# ── Category inference ────────────────────────────────────────────────────────

def _infer_category(title: str, summary: str, default: str) -> str:
    combined = (title + " " + summary).lower()
    # Check overrides in priority order
    if any(kw in combined for kw in MF_KWORDS):
        return "mf"
    if any(kw in combined for kw in ECONOMY_KWORDS):
        return "economy"
    if any(kw in combined for kw in MARKET_KWORDS):
        return "market"
    return default


# ── Symbol tagger ─────────────────────────────────────────────────────────────

# Module-level cache: {symbol: [name_tokens], company_name: symbol}
_SYMBOL_INDEX: Optional[Dict] = None


def _load_symbol_index(conn) -> Dict:
    """
    Build a fast lookup structure from equity_master.
    Returns {lowercase_token: symbol} for both NSE symbols and company name words.
    """
    global _SYMBOL_INDEX
    if _SYMBOL_INDEX is not None:
        return _SYMBOL_INDEX

    with conn.cursor() as cur:
        cur.execute("SELECT symbol, company_name FROM equity_master WHERE symbol IS NOT NULL")
        rows = cur.fetchall()

    index: Dict[str, str] = {}
    for symbol, company_name in rows:
        # Index the symbol itself (exact match, uppercase)
        index[symbol.upper()] = symbol

        # Index significant words from company name (length > 3, not generic)
        if company_name:
            skip = {"ltd", "limited", "india", "corp", "industries", "and", "the",
                    "group", "holdings", "services", "solutions", "technologies",
                    "enterprise", "finance", "bank", "capital", "funds"}
            for word in re.findall(r"[a-zA-Z]+", company_name):
                if len(word) > 3 and word.lower() not in skip:
                    # Only index if this word is reasonably unique (not too short)
                    if len(word) >= 5:
                        index[word.upper()] = symbol

    _SYMBOL_INDEX = index
    log.info("Symbol index built: %d tokens for %d symbols", len(index), len(rows))
    return index


def _tag_symbols(title: str, summary: str, index: Dict[str, str]) -> List[str]:
    """
    Extract all NSE symbols mentioned in title + summary.
    Uses word-boundary matching to avoid false positives.
    """
    combined = (title + " " + summary).upper()
    # Extract all word tokens from the article text
    words = set(re.findall(r"\b[A-Z][A-Z0-9&]{1,19}\b", combined))

    matched = set()
    for word in words:
        if word in index:
            matched.add(index[word])

    return sorted(matched)


# ── DB helpers ────────────────────────────────────────────────────────────────

def _upsert_articles(conn, articles: List[Dict]) -> int:
    if not articles:
        return 0
    rows = [
        (
            a["source"],
            a["category"],
            a["title"],
            a["summary"],
            a["url"],
            a["published_at"],
            a["tagged_symbols"],
        )
        for a in articles
    ]
    sql = """
        INSERT INTO news_articles
            (source, category, title, summary, url, published_at, tagged_symbols)
        VALUES %s
        ON CONFLICT (url) DO UPDATE SET
            tagged_symbols = EXCLUDED.tagged_symbols
    """
    with conn.cursor() as cur:
        execute_values(cur, sql, rows, template="(%s,%s,%s,%s,%s,%s,%s::text[])")
    conn.commit()
    return len(rows)


def _prune_old_articles(conn, keep_days: int = ARTICLE_RETENTION_DAYS):
    """Remove articles older than keep_days to prevent unbounded growth."""
    with conn.cursor() as cur:
        cur.execute(
            "DELETE FROM news_articles WHERE published_at < NOW() - INTERVAL '%s days'",
            (keep_days,),
        )
        deleted = cur.rowcount
    conn.commit()
    if deleted:
        log.info("Pruned %d articles older than %d days", deleted, keep_days)


# ── Per-feed fetch ────────────────────────────────────────────────────────────

# Each worker thread gets its own requests.Session (sessions are not thread-safe).
# Using threading.local() avoids the overhead of creating a new session per call
# while keeping threads safely isolated.
import threading
_thread_local = threading.local()

def _get_session() -> requests.Session:
    """Return a thread-local requests.Session, creating one on first use."""
    if not hasattr(_thread_local, "session"):
        s = requests.Session()
        s.headers.update({
            "User-Agent": "Mozilla/5.0 (compatible; WealthTracker/1.0; +https://github.com)"
        })
        _thread_local.session = s
    return _thread_local.session


def _fetch_feed(source: str, url: str, default_category: str, symbol_index: Dict) -> List[Dict]:
    try:
        resp = _get_session().get(url, timeout=15)
        resp.raise_for_status()
        feed = feedparser.parse(resp.content)
    except Exception as exc:
        log.warning("[%s] Fetch failed: %s", source, exc)
        return []

    articles = []
    for entry in feed.entries:
        title   = _clean(getattr(entry, "title",   "") or "")
        summary = _clean(getattr(entry, "summary", "") or
                         getattr(entry, "description", "") or "")
        url_val = getattr(entry, "link", "") or getattr(entry, "id", "")

        if not title or not url_val:
            continue

        published_at = _parse_date(entry)

        # Discard very old articles — keeps ingestion tight (see ARTICLE_MAX_AGE_HOURS)
        age = datetime.utcnow() - published_at.replace(tzinfo=None)
        if age > timedelta(hours=ARTICLE_MAX_AGE_HOURS):
            continue

        category = _infer_category(title, summary, default_category)
        tagged   = _tag_symbols(title, summary, symbol_index)

        articles.append({
            "source":         source,
            "category":       category,
            "title":          title,
            "summary":        summary[:500],
            "url":            url_val[:1000],
            "published_at":   published_at.replace(tzinfo=None),
            "tagged_symbols": tagged,
        })

    return articles


# ── Main ──────────────────────────────────────────────────────────────────────

# Max concurrent feed fetches. Kept conservative: these are external news servers
# and we don't want to hammer them, but 15 sequential fetches × ~2s each = ~30s,
# whereas 8 parallel workers completes the same work in ~4s (bottlenecked by the
# two or three slowest feeds).
_FEED_WORKERS = 8


def run():
    """
    Fetch articles from all registered RSS feeds and store them in news_articles.

    All 15 feeds are fetched concurrently (up to _FEED_WORKERS at a time) using
    a thread pool. Each thread has its own requests.Session. Parsed articles are
    collected from all feeds, then upserted into the DB in a single batch per run.
    Articles older than ARTICLE_MAX_AGE_HOURS are discarded at parse time; rows
    older than ARTICLE_RETENTION_DAYS are pruned from the DB at the end of each run.

    Called by the scheduler every 15 minutes during market hours and hourly
    off-hours/weekends, to ensure continuous coverage of policy and corporate news.
    """
    log.info("=== News Feed Ingestion starting (%d feeds, %d workers) ===",
             len(FEEDS), _FEED_WORKERS)
    conn = get_connection()
    try:
        # Build symbol index once — shared read-only across threads (safe)
        symbol_index = _load_symbol_index(conn)

        # Fan out: fetch all feeds concurrently
        all_articles: List[Dict] = []
        with ThreadPoolExecutor(max_workers=_FEED_WORKERS) as pool:
            futures = {
                pool.submit(_fetch_feed, source, url, cat, symbol_index): source
                for source, url, cat in FEEDS
            }
            for future in as_completed(futures):
                source = futures[future]
                try:
                    articles = future.result()
                    all_articles.extend(articles)
                    log.debug("[%s] %d articles fetched", source, len(articles))
                except Exception as exc:
                    log.warning("[%s] Worker raised: %s", source, exc)

        # Single DB write for all feeds (one round trip)
        total_new = _upsert_articles(conn, all_articles)
        _prune_old_articles(conn)
        log.info("=== Complete — %d articles upserted from %d feeds ===",
                 total_new, len(FEEDS))
    finally:
        conn.close()


if __name__ == "__main__":
    run()
