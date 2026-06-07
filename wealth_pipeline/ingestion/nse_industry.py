"""
NSE Industry Classification via getSymbolData API
--------------------------------------------------
Fetches secInfo.sector, secInfo.basicIndustry, secInfo.indexList per symbol
and updates equity_master with sector, industry, market_cap_category.

Works for ALL listed stocks (not just Nifty index constituents).

Uses a thread pool (default 5 workers) — each worker has its own NSE session
so cookies don't collide. Per-worker delay is 1–2s (randomised) which keeps
total throughput at ~3–5 req/s — fast enough but below NSE's rate limits.

Usage:
    python -m ingestion.nse_industry                  # only symbols missing data
    python -m ingestion.nse_industry --all            # refresh everything
    python -m ingestion.nse_industry --workers 3      # fewer workers (safer)
    python -m ingestion.nse_industry --symbols HDFCBANK INFY
"""

import time
import random
import argparse
import threading
import requests
from urllib.parse import quote
from queue import Queue, Empty
from utils.logger import get_logger
from db.connection import Database
from config import NSE_HEADERS

log = get_logger("nse_industry")

SYMBOL_DATA_URL = (
    "https://www.nseindia.com/api/NextApi/apiClient/GetQuoteApi"
    "?functionName=getSymbolData&marketType=N&series=EQ&symbol={symbol}"
)
QUOTE_EQUITY_URL = "https://www.nseindia.com/api/quote-equity?symbol={symbol}"

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
    ("NIFTY MICROCAP 250",    "SMALLCAP"),
]

# Thread-safe counters
_lock = threading.Lock()
_counters = {"updated": 0, "skipped": 0, "failed": 0, "done": 0}


def _make_session() -> requests.Session:
    """Create a fresh NSE session with its own cookies."""
    session = requests.Session()
    session.headers.update(NSE_HEADERS)
    session.get("https://www.nseindia.com", timeout=15)
    time.sleep(random.uniform(1.0, 2.0))
    return session


def _market_cap_from_indices(index_list: list) -> str:
    index_set = {i.upper() for i in (index_list or [])}
    for name, cap in SIZE_CAP_MAP:
        if name.upper() in index_set:
            return cap
    return None


def _fetch_one(session: requests.Session, symbol: str) -> dict:
    url = SYMBOL_DATA_URL.format(symbol=quote(symbol, safe=''))
    try:
        resp = session.get(url, timeout=15)
        if resp.status_code in (401, 403, 429):
            log.warning("HTTP %s for %s — re-bootstrapping session", resp.status_code, symbol)
            session.get("https://www.nseindia.com", timeout=15)
            time.sleep(random.uniform(3.0, 6.0))
            resp = session.get(url, timeout=15)

        if not resp.ok:
            log.warning("HTTP %s for %s — body: %s", resp.status_code, symbol, resp.text[:200])
            return {}

        data = resp.json()

        equity_response = data.get("equityResponse", [])
        if not equity_response:
            log.debug("Empty equityResponse for %s — raw: %s", symbol, str(data)[:300])
            return {}
        sec_info = equity_response[0].get("secInfo", {})
        if not sec_info:
            log.debug("No secInfo for %s — equityResponse[0]: %s", symbol, str(equity_response[0])[:300])
            return {}

        sector   = sec_info.get("sector") or sec_info.get("macro") or None
        industry = sec_info.get("basicIndustry") or sec_info.get("industryInfo") or None
        cap      = _market_cap_from_indices(sec_info.get("indexList", []))

        if sector == "-":   sector = None
        if industry == "-": industry = None

        return {"sector": sector, "industry": industry, "market_cap_category": cap}
    except Exception as exc:
        log.warning("Exception for %s: %s", symbol, exc)
        return {}


def _worker(worker_id: int, queue: Queue, total: int, db_url: str):
    """Worker thread: pops (security_id, symbol) from queue, fetches, writes to DB."""
    session = _make_session()
    db = Database()

    try:
        request_count = 0
        while True:
            try:
                security_id, symbol = queue.get_nowait()
            except Empty:
                break

            result = _fetch_one(session, symbol)
            request_count += 1

            with _lock:
                _counters["done"] += 1
                done = _counters["done"]

            if not result or (not result.get("sector") and not result.get("market_cap_category")):
                with _lock:
                    _counters["skipped" if result else "failed"] += 1
                log.debug("[W%d][%d/%d] %s — no data", worker_id, done, total, symbol)
            else:
                try:
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
                            (result["sector"], result["industry"],
                             result["market_cap_category"], security_id)
                        )
                    db.conn.commit()
                    with _lock:
                        _counters["updated"] += 1
                    log.info("[W%d][%d/%d] %-14s sector=%-28s industry=%-28s cap=%s",
                             worker_id, done, total, symbol,
                             result["sector"] or "-", result["industry"] or "-",
                             result["market_cap_category"] or "-")
                except Exception as exc:
                    db.conn.rollback()
                    log.error("[W%d] DB write failed for %s: %s", worker_id, symbol, exc)
                    with _lock:
                        _counters["failed"] += 1

            queue.task_done()

            # Per-worker delay — randomised 1–2s; longer pause every 100 requests
            if request_count % 100 == 0:
                pause = random.uniform(8.0, 15.0)
                log.info("[W%d] Pausing %.1fs after 100 requests", worker_id, pause)
                time.sleep(pause)
            else:
                time.sleep(random.uniform(1.0, 2.0))

    finally:
        db.close()


def run(symbols: list = None, refresh_all: bool = False, workers: int = 5):
    db = Database()
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
                cur.execute(
                    """
                    SELECT security_id, symbol FROM equity_master
                    WHERE sector IS NULL OR market_cap_category IS NULL
                    ORDER BY symbol
                    """
                )
            rows = cur.fetchall()
    finally:
        db.close()

    total = len(rows)
    if total == 0:
        log.info("All symbols already have sector + market_cap data. Nothing to do.")
        return

    log.info("Enriching %d symbols using %d workers...", total, workers)

    # Fill the queue
    queue = Queue()
    for row in rows:
        queue.put(row)

    # Stagger worker start times so they don't all hit NSE simultaneously
    threads = []
    for i in range(min(workers, total)):
        t = threading.Thread(target=_worker, args=(i + 1, queue, total, None), daemon=True)
        threads.append(t)
        t.start()
        time.sleep(random.uniform(2.0, 4.0))  # stagger startup

    for t in threads:
        t.join()

    log.info("Complete — updated=%d  skipped=%d  failed=%d / total=%d",
             _counters["updated"], _counters["skipped"], _counters["failed"], total)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="NSE industry classification enrichment")
    parser.add_argument("--all",     action="store_true", help="Refresh all symbols")
    parser.add_argument("--workers", type=int, default=5, help="Number of parallel workers (default: 5)")
    parser.add_argument("--symbols", nargs="+",           help="Specific symbols to enrich")
    args = parser.parse_args()

    run(symbols=args.symbols, refresh_all=args.all, workers=args.workers)
