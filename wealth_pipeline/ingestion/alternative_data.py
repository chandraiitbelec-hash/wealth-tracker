"""
Alternative Data Ingestion — Delivery Stats & Options Chain
------------------------------------------------------------
Two distinct data streams, both sourced from NSE public endpoints.

Signal A: Delivery-to-Traded Quantity (MTO file)
-------------------------------------------------
NSE publishes a daily Market-Turnover Delivery (MTO) file after market close.
  URL: https://nsearchives.nseindia.com/archives/equities/mto/MTO_DDMMYYYY.DAT
  Format (pipe-separated):
    RecordType|SrNo|SYMBOL|SERIES|QTY_TRADED|DELIVERABLE_QTY|PCT_DELIV_TO_TRADED

Delivery% = deliverable shares / total traded shares.
High delivery% → institutional holding conviction; low → speculative day-trading.

Signal D: Options Chain — PCR & IV Skew
----------------------------------------
NSE live option chain: https://www.nseindia.com/api/option-chain-equities?symbol=X
Near-month expiry aggregated metrics:
  · PCR (Put-Call Ratio by OI)  < 1 → bullish; > 1 → bearish positioning
  · IV Skew (ATM put IV − call IV)  positive → market pricing in downside risk

Schedule: Run after EOD (~7:30 PM IST) for delivery; intraday before close for options.
"""

import time
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
import requests
from datetime import date, datetime
from typing import Optional, List, Dict, Tuple

from utils.logger import get_logger
from utils.holidays import is_trading_day
from db.connection import get_connection
from config import NSE_HEADERS, NSE_HOME_URL

log = get_logger("alternative_data")

# ── Module-level constants ─────────────────────────────────────────────────────

# Seconds to sleep between consecutive NSE option-chain requests to avoid 429s.
# The old sequential approach slept RATE_LIMIT_SLEEP between every request:
#   200 symbols × (0.8s sleep + ~0.5s fetch) ≈ 4.5 minutes total.
#
# Instead we use a token-bucket rate limiter shared across N worker threads.
# Workers fetch in parallel but collectively are capped to MAX_OPTIONS_RPS
# requests per second — same politeness, much better wall-clock time.
#   4 workers, 1 req/sec → ~50s for 200 symbols vs 4.5 minutes.
RATE_LIMIT_SLEEP  = 0.8           # kept for delivery stats (sequential, single worker)
MAX_OPTIONS_RPS   = 1.0           # max requests/sec to NSE option-chain endpoint
OPTIONS_WORKERS   = 4             # parallel fetch threads

_MTO_URL_TEMPLATE = (
    "https://nsearchives.nseindia.com/archives/equities/mto/MTO_{date_str}.DAT"
)
_OPTIONS_URL = "https://www.nseindia.com/api/option-chain-equities?symbol={symbol}"

# ── NSE session (reuses the same cookie-based approach as nse_live.py) ────────

def _get_nse_session() -> requests.Session:
    session = requests.Session()
    session.headers.update(NSE_HEADERS)
    session.get(NSE_HOME_URL, timeout=15)
    time.sleep(1)
    return session


# ══════════════════════════════════════════════════════════════════════════════
# Signal A: Delivery stats (NSE MTO file)
# ══════════════════════════════════════════════════════════════════════════════

def _fetch_mto(session: requests.Session, trade_date: date) -> Optional[bytes]:
    date_str = trade_date.strftime("%d%m%Y")
    url = _MTO_URL_TEMPLATE.format(date_str=date_str)
    log.info("Fetching NSE MTO: %s", url)
    try:
        r = session.get(url, timeout=30)
        r.raise_for_status()
        return r.content
    except Exception as exc:
        log.warning("MTO fetch failed: %s", exc)
        return None


def _parse_mto(content: bytes) -> List[Dict]:
    """
    Parse the NSE MTO DAT file.
    Returns list of {symbol, series, traded_qty, deliverable_qty, delivery_pct}
    for EQ/BE series rows.
    """
    records = []
    for raw_line in content.decode("latin-1").splitlines():
        line = raw_line.strip()
        # Field separator is comma in older files, sometimes pipe — handle both
        if "," in line:
            parts = [p.strip() for p in line.split(",")]
        elif "|" in line:
            parts = [p.strip() for p in line.split("|")]
        else:
            continue

        # Record type 10 = equity delivery data
        if len(parts) < 7 or parts[0] != "10":
            continue

        # [0]=RecType [1]=SrNo [2]=SYMBOL [3]=SERIES [4]=QtyTraded [5]=DelivQty [6]=DelivPct
        symbol = parts[2].strip()
        series = parts[3].strip()
        if series not in ("EQ", "BE"):
            continue

        try:
            traded_qty      = int(parts[4].replace(",", ""))
            deliverable_qty = int(parts[5].replace(",", ""))
            delivery_pct    = float(parts[6].replace(",", ""))
        except (ValueError, IndexError):
            continue

        records.append({
            "symbol":          symbol,
            "traded_qty":      traded_qty,
            "deliverable_qty": deliverable_qty,
            "delivery_pct":    delivery_pct,
        })

    log.info("Parsed %d EQ delivery records", len(records))
    return records


def _upsert_delivery_stats(conn, records: List[Dict], trade_date: date) -> int:
    if not records:
        return 0
    from psycopg2.extras import execute_values
    rows = [
        (r["symbol"], trade_date, r["traded_qty"], r["deliverable_qty"], r["delivery_pct"])
        for r in records
    ]
    sql = """
        INSERT INTO stock_delivery_stats
            (symbol, trade_date, traded_qty, deliverable_qty, delivery_pct)
        VALUES %s
        ON CONFLICT (symbol, trade_date) DO UPDATE SET
            traded_qty      = EXCLUDED.traded_qty,
            deliverable_qty = EXCLUDED.deliverable_qty,
            delivery_pct    = EXCLUDED.delivery_pct
    """
    with conn.cursor() as cur:
        execute_values(cur, sql, rows)
    conn.commit()
    return len(rows)


def run_delivery(trade_date: date = None):
    """
    Download and store NSE MTO delivery statistics for `trade_date` (defaults to today).

    Fetches the daily MTO DAT file from NSE, parses EQ/BE-series delivery records,
    and upserts into stock_delivery_stats. Skips execution if the date is not a
    valid trading day. Called by run() and can be invoked standalone for backfills.
    """
    if trade_date is None:
        trade_date = date.today()
    if not is_trading_day(trade_date):
        log.info("%s is not a trading day — skipping delivery ingestion", trade_date)
        return

    session = _get_nse_session()
    content = _fetch_mto(session, trade_date)
    if not content:
        return

    records = _parse_mto(content)
    if not records:
        return

    conn = get_connection()
    try:
        n = _upsert_delivery_stats(conn, records, trade_date)
        log.info("Delivery stats: %d rows upserted for %s", n, trade_date)
    finally:
        conn.close()


# ══════════════════════════════════════════════════════════════════════════════
# Signal D: Options chain — PCR and IV Skew
# ══════════════════════════════════════════════════════════════════════════════

def _fetch_option_chain(session: requests.Session, symbol: str) -> Optional[dict]:
    url = _OPTIONS_URL.format(symbol=symbol)
    try:
        r = session.get(url, timeout=20)
        r.raise_for_status()
        return r.json()
    except Exception as exc:
        log.warning("Options chain fetch failed for %s: %s", symbol, exc)
        return None


def _parse_option_chain(data: dict, symbol: str) -> Optional[Dict]:
    """
    Extract near-month PCR and ATM IV skew from the NSE option chain response.

    NSE response structure:
      data.filtered.data[] → list of strike records
        each record has:
          .strikePrice, .expiryDate
          .CE → {openInterest, impliedVolatility, ...}
          .PE → {openInterest, impliedVolatility, ...}
    """
    try:
        records = data.get("filtered", {}).get("data", [])
        if not records:
            records = data.get("records", {}).get("data", [])
        if not records:
            return None

        # Group by expiry, take the nearest one
        expiry_groups: Dict[str, list] = {}
        for r in records:
            exp = r.get("expiryDate", "")
            if exp not in expiry_groups:
                expiry_groups[exp] = []
            expiry_groups[exp].append(r)

        if not expiry_groups:
            return None

        # Parse expiry dates and pick the nearest future expiry
        def _parse_exp(s: str) -> date:
            for fmt in ("%d-%b-%Y", "%Y-%m-%d", "%d-%m-%Y"):
                try:
                    return datetime.strptime(s, fmt).date()
                except ValueError:
                    pass
            return date.max

        today = date.today()
        expiry_str = min(
            expiry_groups.keys(),
            key=lambda s: abs((_parse_exp(s) - today).days)
        )
        expiry_date = _parse_exp(expiry_str)
        strikes = expiry_groups[expiry_str]

        # Aggregate OI across all strikes
        total_put_oi  = sum(r.get("PE", {}).get("openInterest", 0) or 0 for r in strikes)
        total_call_oi = sum(r.get("CE", {}).get("openInterest", 0) or 0 for r in strikes)
        pcr = (total_put_oi / total_call_oi) if total_call_oi > 0 else None

        # Find ATM strike (closest to underlying)
        underlying = data.get("records", {}).get("underlyingValue") or \
                     data.get("filtered", {}).get("CE", {}).get("underlyingValue") or 0
        if not underlying:
            # estimate from mid-point of strikes
            all_strikes = [r.get("strikePrice", 0) for r in strikes]
            underlying = sum(all_strikes) / len(all_strikes) if all_strikes else 0

        atm = min(strikes, key=lambda r: abs((r.get("strikePrice") or 0) - underlying))
        atm_call_iv = (atm.get("CE") or {}).get("impliedVolatility") or None
        atm_put_iv  = (atm.get("PE") or {}).get("impliedVolatility") or None

        iv_skew = None
        if atm_call_iv is not None and atm_put_iv is not None:
            iv_skew = float(atm_put_iv) - float(atm_call_iv)

        return {
            "symbol":           symbol,
            "expiry_date":      expiry_date,
            "total_put_oi":     total_put_oi,
            "total_call_oi":    total_call_oi,
            "pcr":              round(pcr, 4) if pcr else None,
            "atm_call_iv":      float(atm_call_iv) if atm_call_iv else None,
            "atm_put_iv":       float(atm_put_iv)  if atm_put_iv  else None,
            "iv_skew":          round(iv_skew, 4)  if iv_skew is not None else None,
            "underlying_price": float(underlying)  if underlying else None,
        }
    except Exception as exc:
        log.warning("Options chain parse failed for %s: %s", symbol, exc)
        return None


def _upsert_options_data(conn, row: Dict, snapshot_date: date):
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO stock_options_data
                (symbol, snapshot_date, expiry_date, total_put_oi, total_call_oi,
                 pcr, atm_call_iv, atm_put_iv, iv_skew, underlying_price)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (symbol, snapshot_date, expiry_date) DO UPDATE SET
                total_put_oi    = EXCLUDED.total_put_oi,
                total_call_oi   = EXCLUDED.total_call_oi,
                pcr             = EXCLUDED.pcr,
                atm_call_iv     = EXCLUDED.atm_call_iv,
                atm_put_iv      = EXCLUDED.atm_put_iv,
                iv_skew         = EXCLUDED.iv_skew,
                underlying_price= EXCLUDED.underlying_price
            """,
            (
                row["symbol"],
                snapshot_date,
                row["expiry_date"],
                row["total_put_oi"],
                row["total_call_oi"],
                row["pcr"],
                row["atm_call_iv"],
                row["atm_put_iv"],
                row["iv_skew"],
                row["underlying_price"],
            ),
        )
    conn.commit()


# ── Token-bucket rate limiter ─────────────────────────────────────────────────

class _TokenBucket:
    """
    Thread-safe token bucket — allows at most `rate` tokens per second.
    Each call to acquire() blocks until a token is available.
    This lets multiple worker threads share a single rate limit without
    a fixed sleep that wastes time when requests finish early.
    """
    def __init__(self, rate: float):
        self._rate      = rate          # tokens per second
        self._tokens    = rate          # start full
        self._last      = time.monotonic()
        self._lock      = threading.Lock()

    def acquire(self):
        with self._lock:
            now    = time.monotonic()
            self._tokens = min(self._rate, self._tokens + (now - self._last) * self._rate)
            self._last   = now
            if self._tokens >= 1:
                self._tokens -= 1
                return
            # Not enough tokens — sleep for exactly the deficit
            wait = (1 - self._tokens) / self._rate
        time.sleep(wait)
        with self._lock:
            self._tokens = max(0, self._tokens - 1)


def run_options(symbols: List[str], snapshot_date: date = None):
    """
    Fetch and store option chain data for the given symbols.

    Uses OPTIONS_WORKERS parallel threads with a shared token-bucket rate
    limiter (MAX_OPTIONS_RPS req/sec) to be polite to NSE while finishing
    much faster than a sequential sleep loop. Results are collected from all
    futures, then written to the DB.  Call with a list of the user's stock
    holdings or the Nifty 50 universe.
    """
    if snapshot_date is None:
        snapshot_date = date.today()
    if not is_trading_day(snapshot_date):
        log.info("%s is not a trading day — skipping options ingestion", snapshot_date)
        return

    session = _get_nse_session()
    bucket  = _TokenBucket(rate=MAX_OPTIONS_RPS)

    def _fetch_one(symbol: str) -> Tuple[str, Optional[Dict]]:
        """Rate-limited fetch + parse for a single symbol. Returns (symbol, parsed|None)."""
        bucket.acquire()
        raw = _fetch_option_chain(session, symbol)
        if raw is None:
            return symbol, None
        return symbol, _parse_option_chain(raw, symbol)

    # Fan out across workers; collect all results before writing to DB
    results: List[Dict] = []
    fail = 0
    with ThreadPoolExecutor(max_workers=OPTIONS_WORKERS) as pool:
        futures = {pool.submit(_fetch_one, s): s for s in symbols}
        for future in as_completed(futures):
            symbol = futures[future]
            try:
                _, parsed = future.result()
                if parsed:
                    results.append(parsed)
                else:
                    fail += 1
            except Exception as exc:
                log.warning("Options worker failed for %s: %s", symbol, exc)
                fail += 1

    # Single DB connection for all writes
    conn = get_connection()
    try:
        for parsed in results:
            _upsert_options_data(conn, parsed, snapshot_date)
        log.info("Options data: %d ok / %d failed for %s", len(results), fail, snapshot_date)
    finally:
        conn.close()


def run(trade_date: date = None):
    """
    Full alternative-data run: delivery stats + options chain for all equity symbols.

    Calls run_delivery() first to ingest MTO delivery statistics, then fetches
    NSE option-chain data for up to 200 symbols from equity_master and stores
    PCR/IV-skew metrics in stock_options_data. Called by the scheduler every
    Mon–Fri at 7:30 PM IST, after EOD Bhavcopy prices have been ingested.
    """
    run_delivery(trade_date)

    # Fetch options for all symbols that have F&O contracts (>500 on NSE)
    # Pull distinct symbols from equity_master rather than hardcoding
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT DISTINCT symbol FROM equity_master WHERE symbol IS NOT NULL LIMIT 200")
            symbols = [r[0] for r in cur.fetchall()]
    finally:
        conn.close()

    if symbols:
        log.info("Fetching options chain for %d symbols", len(symbols))
        run_options(symbols, trade_date)


if __name__ == "__main__":
    run()
