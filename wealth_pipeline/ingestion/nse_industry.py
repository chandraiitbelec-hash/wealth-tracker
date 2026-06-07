"""
NSE Industry Classification via getSymbolData API
--------------------------------------------------
For each symbol in equity_master, calls NSE's getSymbolData API which returns
secInfo.basicIndustry, secInfo.sector, secInfo.industryInfo, and secInfo.indexList.

This gives us:
  - industry            (basicIndustry — granular, e.g. "Stockbroking & Allied")
  - sector              (sector field — broad, e.g. "Financial Services")
  - market_cap_category (derived from indexList membership)

Works for ALL listed stocks, not just Nifty index constituents.

Usage:
    python -m ingestion.nse_industry                      # only symbols missing sector
    python -m ingestion.nse_industry --all                # refresh everything
    python -m ingestion.nse_industry --symbols HDFCBANK INFY TCS

Delays: randomised 2–4 s between requests, 10–20 s pause every 50 calls.
"""

import time
import random
import argparse
import requests
from utils.logger import get_logger
from db.connection import Database
from config import NSE_HEADERS

log = get_logger("nse_industry")

SYMBOL_DATA_URL = (
    "https://www.nseindia.com/api/NextApi/apiClient/GetQuoteApi"
    "?functionName=getSymbolData&marketType=N&series=EQ&symbol={symbol}"
)

# Size index → market cap category (first match wins)
SIZE_CAP_MAP = [
    ("NIFTY 50",              "LARGECAP"),
    ("NIFTY NEXT 50",         "LARGECAP"),
    ("NIFTY 100",             "LARGECAP"),
    ("NIFTY LARGEMIDCAP 250", "LARGECAP"),
    ("NIFTY MIDCAP 50",       "MIDCAP"),
    ("NIFTY MIDCAP 100",      "MIDCAP"),
    ("NIFTY MIDCAP 150",      "MIDCAP"),
    ("NIFTY MIDSMALLCAP 400", "MIDCAP"),
    ("NIFTY SMALLCAP 50",     "SMALLCAP"),
    ("NIFTY SMALLCAP 100",    "SMALLCAP"),
    ("NIFTY SMALLCAP 250",    "SMALLCAP"),
    ("NIFTY MICROCAP 250",    "SMALLCAP"),  # mapped to SMALLCAP — constraint allows only LARGECAP/MIDCAP/SMALLCAP/UNKNOWN
]


def _get_session() -> requests.Session:
    session = requests.Session()
    session.headers.update(NSE_HEADERS)
    log.info("Bootstrapping NSE session...")
    session.get("https://www.nseindia.com", timeout=15)
    time.sleep(random.uniform(2.0, 3.0))
    return session


def _market_cap_from_indices(index_list: list) -> str:
    index_set = {i.upper() for i in (index_list or [])}
    for name, cap in SIZE_CAP_MAP:
        if name.upper() in index_set:
            return cap
    return None


def _fetch_symbol_data(session: requests.Session, symbol: str) -> dict:
    """
    Returns dict with keys: sector, industry, market_cap_category
    or empty dict on failure.
    """
    url = SYMBOL_DATA_URL.format(symbol=symbol)
    try:
        resp = session.get(url, timeout=15)

        # Re-bootstrap on auth errors
        if resp.status_code in (401, 403):
            log.warning("Session expired — re-bootstrapping")
            session.get("https://www.nseindia.com", timeout=15)
            time.sleep(random.uniform(3.0, 5.0))
            resp = session.get(url, timeout=15)

        resp.raise_for_status()
        data = resp.json()

        equity_response = data.get("equityResponse", [])
        if not equity_response:
            return {}

        sec_info = equity_response[0].get("secInfo", {})
        if not sec_info:
            return {}

        sector        = sec_info.get("sector") or sec_info.get("macro") or None
        industry      = sec_info.get("basicIndustry") or sec_info.get("industryInfo") or None
        index_list    = sec_info.get("indexList", [])
        market_cap    = _market_cap_from_indices(index_list)

        # Clean up "-" placeholders NSE uses for missing values
        if sector == "-":    sector = None
        if industry == "-":  industry = None

        return {
            "sector":              sector,
            "industry":            industry,
            "market_cap_category": market_cap,
        }

    except Exception as exc:
        log.warning("Failed to fetch data for %s: %s", symbol, exc)
        return {}


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
                # Only symbols missing sector OR market_cap_category
                cur.execute(
                    """
                    SELECT security_id, symbol FROM equity_master
                    WHERE sector IS NULL OR market_cap_category IS NULL
                    ORDER BY symbol
                    """
                )
            rows = cur.fetchall()

        total = len(rows)
        log.info("Enriching %d symbols with NSE industry data...", total)
        updated = skipped = failed = 0

        for i, (security_id, symbol) in enumerate(rows):
            result = _fetch_symbol_data(session, symbol)

            if not result:
                failed += 1
                log.debug("[%d/%d] %s — no data returned", i + 1, total, symbol)
            elif not result.get("sector") and not result.get("market_cap_category"):
                skipped += 1
                log.debug("[%d/%d] %s — sector/cap both null", i + 1, total, symbol)
            else:
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
                        (
                            result["sector"],
                            result["industry"],
                            result["market_cap_category"],
                            security_id,
                        )
                    )
                db.conn.commit()
                updated += 1
                log.info(
                    "[%d/%d] %-15s sector=%-30s industry=%-30s cap=%s",
                    i + 1, total, symbol,
                    result["sector"] or "-",
                    result["industry"] or "-",
                    result["market_cap_category"] or "-",
                )

            # Randomised delay: 2–4 s normally, longer pause every 50 requests
            if (i + 1) % 50 == 0:
                pause = random.uniform(15.0, 25.0)
                log.info("--- Pausing %.1fs after %d requests ---", pause, i + 1)
                time.sleep(pause)
            else:
                time.sleep(random.uniform(2.0, 4.0))

        log.info("Complete — updated=%d  skipped=%d  failed=%d / total=%d",
                 updated, skipped, failed, total)

    finally:
        db.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="NSE industry classification enrichment")
    parser.add_argument("--all",     action="store_true", help="Refresh all symbols")
    parser.add_argument("--symbols", nargs="+",           help="Specific symbols to enrich")
    args = parser.parse_args()

    run(symbols=args.symbols, refresh_all=args.all)
