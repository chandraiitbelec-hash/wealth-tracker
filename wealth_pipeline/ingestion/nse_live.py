"""
NSE 5-Minute Intraday Feed
---------------------------
Pulls the public delayed snapshot from NSE's market data API
and overwrites the intraday_live_feed table.

Schedule: Every 5 minutes between 9:15 AM and 3:30 PM IST on trading days.

NSE blocks plain HTTP requests — we bootstrap a session with cookies
on first use and reuse it across ticks to avoid repeated handshakes.
"""

import time
import requests
from datetime import datetime, time as dtime
import pytz
from utils.logger import get_logger
from utils.holidays import is_trading_day
from db.connection import Database
from config import NSE_LIVE_URL, NSE_HOME_URL, NSE_HEADERS

log = get_logger("nse_live")

IST = pytz.timezone("Asia/Kolkata")
MARKET_OPEN = dtime(9, 15)
MARKET_CLOSE = dtime(15, 30)

# Module-level session reuse across scheduler ticks
_session: requests.Session | None = None


def _get_session() -> requests.Session:
    global _session
    if _session is None:
        log.info("Bootstrapping NSE session (fetching cookies)...")
        _session = requests.Session()
        _session.headers.update(NSE_HEADERS)
        _session.get(NSE_HOME_URL, timeout=15)
        time.sleep(1)  # polite pause before actual API call
    return _session


def _reset_session():
    """Force a fresh session on next call (used after errors)."""
    global _session
    _session = None


def is_market_open() -> bool:
    """Return True if current IST time is within market hours on a trading day."""
    now_ist = datetime.now(IST)
    if not is_trading_day(now_ist.date()):
        return False
    current_time = now_ist.time().replace(second=0, microsecond=0)
    return MARKET_OPEN <= current_time <= MARKET_CLOSE


def fetch_live_snapshot() -> list:
    """
    Fetch NSE's public F&O securities snapshot (covers most liquid names).
    Returns list of {symbol, last_price}.

    NSE's public API returns a JSON with a 'data' array. Each element has:
      - 'symbol'     : NSE ticker
      - 'lastPrice'  : last traded price (string with commas stripped)
    """
    session = _get_session()
    try:
        resp = session.get(NSE_LIVE_URL, timeout=15)
        resp.raise_for_status()
        payload = resp.json()
    except Exception as exc:
        log.error("Failed to fetch NSE live snapshot: %s", exc)
        _reset_session()
        return []

    records = []
    for item in payload.get("data", []):
        symbol = item.get("symbol", "").strip()
        raw_price = str(item.get("lastPrice", "")).replace(",", "").strip()
        try:
            price = float(raw_price)
        except ValueError:
            continue
        if symbol and price > 0:
            records.append({"symbol": symbol, "last_price": price})

    log.info("Live snapshot: %d symbols fetched", len(records))
    return records


def run():
    """One tick of the intraday ingestion. Called by the scheduler every 5 min."""
    if not is_market_open():
        log.info("Market closed — skipping live tick")
        return

    records = fetch_live_snapshot()
    if not records:
        return

    now = datetime.now(IST).replace(tzinfo=None)  # store as naive UTC equivalent
    db = Database()
    try:
        intraday_rows = []
        for rec in records:
            sec_id = db.get_security_id(asset_type="EQUITY", code=rec["symbol"])
            if sec_id is None:
                # Symbol not yet in master — skip (EOD job will add it tonight)
                continue
            intraday_rows.append((sec_id, rec["last_price"], now))  # is_delayed_feed defaults to TRUE

        if intraday_rows:
            db.bulk_upsert_intraday(intraday_rows)
            log.info("Intraday cache updated — %d symbols", len(intraday_rows))
    finally:
        db.close()


def clear_cache():
    """Called once at 9:15 AM to wipe previous day's stale intraday data."""
    db = Database()
    try:
        db.clear_intraday_cache()
        log.info("Intraday cache cleared for new trading day")
    finally:
        db.close()


if __name__ == "__main__":
    run()
