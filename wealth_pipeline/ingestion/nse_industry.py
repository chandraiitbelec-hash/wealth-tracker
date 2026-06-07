"""
NSE Industry Classification via getIndexList API
-------------------------------------------------
For each symbol in equity_master, calls NSE's getIndexList API to discover
which Nifty indices the stock belongs to, then derives:
  - sector / industry   (from thematic index membership)
  - market_cap_category (from size index membership)

This is a ONE-TIME enrichment script — run it once to populate sectors for
ALL symbols, not just the 500 in the major index CSVs.

Usage:
    python -m ingestion.nse_industry            # all symbols missing sector
    python -m ingestion.nse_industry --all      # refresh every symbol
    python -m ingestion.nse_industry --symbols HDFCBANK INFY TCS

Delays: randomised 2–5 s between requests to avoid detection.
Session is bootstrapped via nseindia.com homepage (required for cookies).
"""

import sys
import time
import random
import argparse
import requests
from utils.logger import get_logger
from db.connection import Database
from config import NSE_HEADERS

log = get_logger("nse_industry")

BASE_URL = "https://www.nseindia.com/api/NextApi/apiClient/GetQuoteApi"

# ── Index → (sector, industry) mapping ───────────────────────────────────────
# Thematic indices take priority; more specific = listed first
THEMATIC_MAP = {
    "NIFTY BANK":                        ("Banking & Finance",        "Banks"),
    "NIFTY PRIVATE BANK":                ("Banking & Finance",        "Private Sector Banks"),
    "NIFTY PSU BANK":                    ("Banking & Finance",        "Public Sector Banks"),
    "NIFTY FINANCIAL SERVICES":          ("Banking & Finance",        "Financial Services"),
    "NIFTY FINANCIAL SERVICES 25/50":    ("Banking & Finance",        "Financial Services"),
    "NIFTY CAPITAL MARKETS":             ("Banking & Finance",        "Capital Markets"),
    "NIFTY IT":                          ("Information Technology",   "IT Services"),
    "NIFTY INDIA DIGITAL":               ("Information Technology",   "Digital Services"),
    "NIFTY INDIA INTERNET":              ("Information Technology",   "Internet Services"),
    "NIFTY PHARMA":                      ("Pharmaceuticals",          "Pharmaceuticals"),
    "NIFTY HEALTHCARE INDEX":            ("Pharmaceuticals",          "Healthcare"),
    "NIFTY AUTO":                        ("Automobile",               "Automobiles"),
    "NIFTY FMCG":                        ("FMCG",                     "FMCG"),
    "NIFTY INDIA CONSUMPTION":           ("FMCG",                     "Consumer Goods"),
    "NIFTY INDIA NEW AGE CONSUMPTION":   ("Consumer Discretionary",   "New Age Consumer"),
    "NIFTY METAL":                       ("Metals & Mining",          "Metals & Mining"),
    "NIFTY COMMODITIES":                 ("Metals & Mining",          "Commodities"),
    "NIFTY ENERGY":                      ("Energy & Oil",             "Energy"),
    "NIFTY OIL AND GAS":                 ("Energy & Oil",             "Oil & Gas"),
    "NIFTY REALTY":                      ("Real Estate",              "Real Estate"),
    "NIFTY MEDIA":                       ("Media & Entertainment",    "Media & Entertainment"),
    "NIFTY INFRASTRUCTURE":              ("Infrastructure",           "Infrastructure"),
    "NIFTY INDIA MANUFACTURING":         ("Manufacturing",            "Manufacturing"),
    "NIFTY CPSE":                        ("Public Sector",            "Public Sector"),
    "NIFTY INDIA DEFENCE":               ("Defence",                  "Defence"),
    "NIFTY TRANSPORTATION":              ("Infrastructure",           "Transportation"),
    "NIFTY SERVICES SECTOR":             ("Services",                 "Services"),
    "NIFTY IPO":                         (None, None),   # too generic — skip
}

# Size index → market cap category (first match wins, so order matters)
SIZE_MAP = [
    ("NIFTY 50",            "LARGECAP"),
    ("NIFTY NEXT 50",       "LARGECAP"),
    ("NIFTY 100",           "LARGECAP"),
    ("NIFTY MIDCAP 50",     "MIDCAP"),
    ("NIFTY MIDCAP 100",    "MIDCAP"),
    ("NIFTY MIDCAP 150",    "MIDCAP"),
    ("NIFTY SMALLCAP 50",   "SMALLCAP"),
    ("NIFTY SMALLCAP 100",  "SMALLCAP"),
    ("NIFTY SMALLCAP 250",  "SMALLCAP"),
    ("NIFTY MICROCAP 250",  "MICROCAP"),
    ("NIFTY LARGEMIDCAP 250", "LARGECAP"),   # conservative — large + mid
    ("NIFTY MIDSMALLCAP 400", "MIDCAP"),
]


def _get_session() -> requests.Session:
    session = requests.Session()
    session.headers.update(NSE_HEADERS)
    log.info("Bootstrapping NSE session...")
    session.get("https://www.nseindia.com", timeout=15)
    time.sleep(random.uniform(1.5, 3.0))
    return session


def _fetch_index_list(session: requests.Session, symbol: str) -> list:
    """Fetch the list of indices a symbol belongs to."""
    url = f"{BASE_URL}?functionName=getIndexList&symbol={symbol}"
    try:
        resp = session.get(url, timeout=15)
        if resp.status_code == 401 or resp.status_code == 403:
            log.warning("Session expired for %s — re-bootstrapping", symbol)
            session.get("https://www.nseindia.com", timeout=15)
            time.sleep(random.uniform(2, 4))
            resp = session.get(url, timeout=15)
        resp.raise_for_status()
        data = resp.json()
        return data if isinstance(data, list) else []
    except Exception as exc:
        log.warning("Failed to fetch index list for %s: %s", symbol, exc)
        return []


def _derive_sector_cap(indices: list) -> tuple:
    """
    Returns (sector, industry, market_cap_category) from index list.
    sector/industry: first matching thematic index.
    market_cap: first matching size index.
    """
    sector = industry = market_cap = None

    index_set = {i.upper() for i in indices}

    # Thematic → sector
    for index_name, (sec, ind) in THEMATIC_MAP.items():
        if index_name.upper() in index_set and sec:
            sector = sec
            industry = ind
            break

    # Size → market cap
    for index_name, cap in SIZE_MAP:
        if index_name.upper() in index_set:
            market_cap = cap
            break

    return sector, industry, market_cap


def run(symbols: list = None, refresh_all: bool = False):
    db = Database()
    session = _get_session()

    try:
        with db.conn.cursor() as cur:
            if symbols:
                cur.execute(
                    "SELECT security_id, symbol FROM equity_master WHERE symbol = ANY(%s)",
                    (symbols,)
                )
            elif refresh_all:
                cur.execute("SELECT security_id, symbol FROM equity_master ORDER BY symbol")
            else:
                # Only symbols missing sector data
                cur.execute(
                    "SELECT security_id, symbol FROM equity_master WHERE sector IS NULL ORDER BY symbol"
                )
            rows = cur.fetchall()

        log.info("Enriching %d symbols with NSE index classification...", len(rows))
        updated = skipped = failed = 0

        for i, (security_id, symbol) in enumerate(rows):
            indices = _fetch_index_list(session, symbol)

            if not indices:
                failed += 1
                log.debug("No index data for %s", symbol)
            else:
                sector, industry, market_cap = _derive_sector_cap(indices)

                if sector or market_cap:
                    with db.conn.cursor() as cur:
                        cur.execute(
                            """
                            UPDATE equity_master SET
                                sector              = COALESCE(%s, sector),
                                industry            = COALESCE(%s, industry),
                                market_cap_category = COALESCE(%s, market_cap_category),
                                updated_at          = CURRENT_TIMESTAMP
                            WHERE security_id = %s
                            """,
                            (sector, industry, market_cap, security_id)
                        )
                    db.conn.commit()
                    updated += 1
                    log.info("[%d/%d] %s → sector=%s, cap=%s", i + 1, len(rows), symbol, sector, market_cap)
                else:
                    skipped += 1
                    log.debug("[%d/%d] %s — no matching thematic index", i + 1, len(rows), symbol)

            # Randomised delay: 2–5 s, longer every 50 requests to let NSE breathe
            delay = random.uniform(2.0, 5.0)
            if (i + 1) % 50 == 0:
                delay = random.uniform(10.0, 20.0)
                log.info("Pausing %0.1fs after 50 requests...", delay)
            time.sleep(delay)

        log.info("Done — updated=%d  skipped=%d  failed=%d", updated, skipped, failed)

    finally:
        db.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="NSE industry classification enrichment")
    parser.add_argument("--all",     action="store_true", help="Refresh all symbols, not just missing ones")
    parser.add_argument("--symbols", nargs="+",           help="Specific symbols to enrich")
    args = parser.parse_args()

    run(symbols=args.symbols, refresh_all=args.all)
