"""
NSE Corporate Disclosure Ingestion + LLM Parsing
-------------------------------------------------
Companies are legally required to file material events with NSE/BSE before
talking to the press. These filings are the purest, unfiltered signal —
no editorial spin, no lag. This module:

1. Fetches the last 7 days of corporate announcements for each equity
   symbol via the NSE public API.

2. For each NEW announcement (not previously scored), sends the raw
   disclosure text to Claude claude-haiku-4-5 with a financial-analyst
   prompt and stores the score (-5 to +5) in corporate_disclosures.

NSE Announcements API:
  GET https://www.nseindia.com/api/corp-info?symbol=RELIANCE&corpType=announcements&market=equities

Response: JSON array of announcement objects with keys:
  bcastDte, subject, attchmntText, attchmntFile, desc, comp

Schedule: Daily at 8:00 PM IST (after market close, before sentiment_engine runs).
Rate limit: 1 req/symbol/day; LLM calls batched, max 30 per run.
"""

import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
import requests
import anthropic
from datetime import date, datetime, timedelta
from typing import Optional, List, Dict, Tuple
from psycopg2.extras import execute_values

from db.connection import get_connection
from utils.logger import get_logger
from config import NSE_HEADERS, NSE_HOME_URL

# ── Module-level constants ─────────────────────────────────────────────────────

log = get_logger("nse_disclosures")

_ANNOUNCEMENTS_URL = (
    "https://www.nseindia.com/api/corp-info"
    "?symbol={symbol}&corpType=announcements&market=equities"
)

# LLM budget: at most this many unscored disclosures processed per run
# (keeps Claude API costs bounded — adjust upward as you scale)
MAX_LLM_CALLS_PER_RUN = 30

# Parallel Haiku calls. Haiku is stateless and the API allows concurrent requests.
# 5 workers ≈ 5× throughput; staying conservative to avoid rate-limit errors.
LLM_WORKERS = 5

# ── NSE session ───────────────────────────────────────────────────────────────

def _get_session() -> requests.Session:
    s = requests.Session()
    s.headers.update(NSE_HEADERS)
    s.get(NSE_HOME_URL, timeout=15)
    time.sleep(1)
    return s


# ── Fetch announcements ───────────────────────────────────────────────────────

def _fetch_announcements(session: requests.Session, symbol: str) -> List[Dict]:
    url = _ANNOUNCEMENTS_URL.format(symbol=symbol)
    try:
        r = session.get(url, timeout=20)
        r.raise_for_status()
        data = r.json()
        # NSE wraps results in different keys depending on corpType
        if isinstance(data, list):
            return data
        for key in ("Corp_Announcements", "announcements", "data"):
            if key in data and isinstance(data[key], list):
                return data[key]
        return []
    except Exception as exc:
        log.debug("Announcements fetch failed for %s: %s", symbol, exc)
        return []


def _parse_announcement(symbol: str, item: Dict) -> Optional[Dict]:
    """Normalise a single NSE announcement object."""
    # Try multiple date field names
    date_str = (
        item.get("bcastDte") or
        item.get("broadCastDate") or
        item.get("an_dt") or
        item.get("date", "")
    )
    if not date_str:
        return None

    for fmt in ("%d-%b-%Y %H:%M:%S", "%d-%b-%Y", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            dt = datetime.strptime(str(date_str).strip(), fmt)
            break
        except ValueError:
            continue
    else:
        return None

    subject = (
        item.get("subject") or
        item.get("desc") or
        item.get("anDt", "")
    ).strip()[:512]

    body = (
        item.get("attchmntText") or
        item.get("details") or
        item.get("body", "")
    ).strip()

    return {
        "symbol":       symbol,
        "disclosed_at": dt,
        "subject":      subject,
        "body":         body[:8000],   # cap to avoid enormous filings
    }


# ── DB helpers ────────────────────────────────────────────────────────────────

def _insert_new_disclosures(conn, rows: List[Dict]) -> List[int]:
    """
    Insert new disclosures, ignoring duplicates.
    Returns list of newly-inserted row IDs (for LLM scoring).
    """
    if not rows:
        return []
    sql = """
        INSERT INTO corporate_disclosures (symbol, disclosed_at, subject, body)
        VALUES %s
        ON CONFLICT (symbol, disclosed_at, subject) DO NOTHING
        RETURNING id
    """
    data = [
        (r["symbol"], r["disclosed_at"], r["subject"], r["body"])
        for r in rows
    ]
    with conn.cursor() as cur:
        execute_values(cur, sql, data)
        inserted = [row[0] for row in (cur.fetchall() or [])]
    conn.commit()
    return inserted


def _fetch_unscored(conn, limit: int) -> List[Dict]:
    """Fetch up to `limit` disclosures that haven't been LLM-scored yet."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, symbol, subject, body
            FROM corporate_disclosures
            WHERE llm_score IS NULL
            ORDER BY disclosed_at DESC
            LIMIT %s
            """,
            (limit,),
        )
        rows = cur.fetchall()
    return [{"id": r[0], "symbol": r[1], "subject": r[2], "body": r[3]} for r in rows]


def _batch_update_llm_scores(conn, results: List[Tuple[int, int, str]]):
    """
    Write all LLM scores in a single transaction instead of one UPDATE per call.
    results: list of (disc_id, score, rationale)
    """
    if not results:
        return
    with conn.cursor() as cur:
        cur.executemany(
            "UPDATE corporate_disclosures SET llm_score=%s, llm_rationale=%s WHERE id=%s",
            [(score, rationale[:1000], disc_id) for disc_id, score, rationale in results],
        )
    conn.commit()


# ── LLM scoring ───────────────────────────────────────────────────────────────

_SYSTEM_PROMPT = """You are a senior equity analyst at a top Indian investment bank.
You read raw regulatory filings submitted directly to NSE/BSE before the press sees them.
Your job: assess the filing for underlying corporate risk, operational momentum, or structural pivots.

Respond in EXACTLY this JSON format (no markdown, no extra text):
{"score": <integer -5 to +5>, "rationale": "<one concise sentence explaining the score>"}

Scoring guide:
  +5: Major positive pivot (large capex expansion, profitable divestiture, debt elimination)
  +3: Moderately positive (board-level optimism, new order wins, management buyback)
  +1: Mildly positive or neutral positive
   0: Procedural/routine (AGM notices, record dates, dividend announcements)
  -1: Mildly concerning (minor litigation, small management change)
  -3: Moderately negative (profit warning, regulatory inquiry, key-man departure)
  -5: Severely negative (fraud disclosure, major legal loss, going-concern doubt)

Be decisive. If a disclosure is ambiguous, lean toward 0 rather than extreme scores."""

_CLIENT: Optional[anthropic.Anthropic] = None


def _get_client() -> anthropic.Anthropic:
    global _CLIENT
    if _CLIENT is None:
        key = os.getenv("ANTHROPIC_API_KEY")
        if not key:
            raise EnvironmentError("ANTHROPIC_API_KEY not set — LLM scoring unavailable.")
        _CLIENT = anthropic.Anthropic(api_key=key)
    return _CLIENT


def _llm_score(symbol: str, subject: str, body: str) -> tuple[int, str]:
    """
    Ask Claude claude-haiku-4-5 to score a disclosure.
    Returns (score: int, rationale: str).
    Falls back to 0/empty on any error.
    """
    import json

    text = f"Company: {symbol}\nSubject: {subject}\n\nFiling text:\n{body or '(no body text)'}"
    try:
        client = _get_client()
        resp = client.messages.create(
            model="claude-haiku-4-5",
            max_tokens=200,
            system=_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": text}],
        )
        raw = resp.content[0].text.strip()
        # Handle JSON wrapped in markdown code fences
        if raw.startswith("```"):
            raw = raw.strip("`").strip()
            if raw.startswith("json"):
                raw = raw[4:].strip()
        parsed = json.loads(raw)
        score    = max(-5, min(5, int(parsed.get("score", 0))))
        rationale = str(parsed.get("rationale", ""))
        return score, rationale
    except Exception as exc:
        log.warning("LLM scoring failed for %s / %s: %s", symbol, subject[:40], exc)
        return 0, ""


# ── Main ──────────────────────────────────────────────────────────────────────

def run(symbols: Optional[List[str]] = None, lookback_days: int = 7):
    """
    Ingest NSE corporate disclosures and LLM-score new ones.

    Phase 1 — Fetch: pulls the last `lookback_days` of announcements for every
    symbol in equity_master (or the supplied `symbols` list) via the NSE
    corp-info API and inserts rows not already present in corporate_disclosures.

    Phase 2 — Score: fetches up to MAX_LLM_CALLS_PER_RUN unscored disclosures
    and asks Claude Haiku to rate them on a -5 to +5 scale. Scores feed into
    sentiment_engine.py's disclosure sub-signal. Called by the scheduler every
    Mon–Fri at 8:00 PM IST, before sentiment blending runs at 9:00 PM.
    """
    log.info("=== NSE Disclosures Ingestion starting ===")

    conn = get_connection()
    try:
        # If no symbols passed, pull all from equity_master
        if symbols is None:
            with conn.cursor() as cur:
                cur.execute("SELECT DISTINCT symbol FROM equity_master WHERE symbol IS NOT NULL")
                symbols = [r[0] for r in cur.fetchall()]

        log.info("Fetching announcements for %d symbols (last %d days)", len(symbols), lookback_days)
        session = _get_session()
        cutoff  = datetime.now() - timedelta(days=lookback_days)

        total_new = 0
        for i, symbol in enumerate(symbols):
            items = _fetch_announcements(session, symbol)
            new_rows = []
            for item in items:
                parsed = _parse_announcement(symbol, item)
                if parsed and parsed["disclosed_at"] >= cutoff:
                    new_rows.append(parsed)

            if new_rows:
                inserted_ids = _insert_new_disclosures(conn, new_rows)
                total_new   += len(inserted_ids)

            if i > 0 and i % 50 == 0:
                log.info("  … %d/%d symbols fetched, %d new disclosures so far", i, len(symbols), total_new)
            time.sleep(0.5)

        log.info("Fetch phase complete — %d new disclosures inserted", total_new)

        # LLM scoring phase — fan out to LLM_WORKERS parallel Haiku calls.
        # Each call is independent (no shared state), so parallelism is safe.
        # Results are collected, then written to the DB in a single batch.
        unscored = _fetch_unscored(conn, MAX_LLM_CALLS_PER_RUN)
        log.info("LLM scoring %d disclosures with %d workers", len(unscored), LLM_WORKERS)

        def _score_one(disc: Dict) -> Tuple[int, int, str]:
            """Returns (disc_id, score, rationale) — safe to call from a thread."""
            score, rationale = _llm_score(disc["symbol"], disc["subject"], disc["body"] or "")
            log.debug("  [%+d] %s — %s", score, disc["symbol"], disc["subject"][:60])
            return disc["id"], score, rationale

        scored_results: List[Tuple[int, int, str]] = []
        with ThreadPoolExecutor(max_workers=LLM_WORKERS) as pool:
            futures = {pool.submit(_score_one, d): d for d in unscored}
            for future in as_completed(futures):
                try:
                    scored_results.append(future.result())
                except Exception as exc:
                    disc = futures[future]
                    log.warning("LLM worker failed for disc %d: %s", disc["id"], exc)

        _batch_update_llm_scores(conn, scored_results)
        log.info("=== Complete — %d new disclosures, %d LLM-scored ===",
                 total_new, len(scored_results))
    finally:
        conn.close()


if __name__ == "__main__":
    run()
