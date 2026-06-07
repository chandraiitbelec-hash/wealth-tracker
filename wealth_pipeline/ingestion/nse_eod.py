"""
NSE EOD Bhavcopy Ingestion
--------------------------
Downloads the daily Bhavcopy ZIP from NSE, filters to EQ/BE series,
and writes to:
  - security_master   (anchor row per symbol)
  - equity_master     (symbol, ISIN, series — enriched further by nse_master.py)
  - daily_prices      (closing price per symbol per date)

Schedule: Daily at 7:00 PM IST (NSE publishes after 6:30 PM).
"""

import io
import zipfile
import requests
import pandas as pd
from datetime import date
from utils.logger import get_logger
from utils.holidays import is_trading_day
from db.connection import Database
from config import NSE_BHAVCOPY_URL_TEMPLATE, NSE_EQUITY_SERIES, NSE_HEADERS

log = get_logger("nse_eod")


def _get_nse_session() -> requests.Session:
    session = requests.Session()
    session.headers.update(NSE_HEADERS)
    session.get("https://www.nseindia.com", timeout=15)
    return session


def _build_url(trade_date: date) -> str:
    date_str = trade_date.strftime("%Y%m%d")
    return NSE_BHAVCOPY_URL_TEMPLATE.format(date_str=date_str)


def fetch_and_parse_bhavcopy(trade_date: date = None) -> pd.DataFrame:
    """
    Download and parse the NSE Bhavcopy for the given date.
    Returns DataFrame with: SYMBOL, ISIN, SERIES, CLOSE, trade_date
    """
    if trade_date is None:
        trade_date = date.today()

    if not is_trading_day(trade_date):
        log.info("%s is not a trading day — skipping NSE EOD fetch", trade_date)
        return pd.DataFrame()

    url = _build_url(trade_date)
    log.info("Fetching NSE Bhavcopy: %s", url)

    session = _get_nse_session()
    resp = session.get(url, timeout=30)
    resp.raise_for_status()

    with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
        csv_name = next(n for n in zf.namelist() if n.endswith(".csv"))
        with zf.open(csv_name) as f:
            df = pd.read_csv(f, dtype=str)

    df.columns = [c.strip() for c in df.columns]

    # NSE switched to UDiFF format — detect and normalise column names
    # Old format: SYMBOL, SERIES, ISIN, CLOSE
    # New UDiFF:  TckrSymb, SctySrs, ISIN, ClsPric
    if "TckrSymb" in df.columns:
        df = df.rename(columns={
            "TckrSymb": "SYMBOL",
            "SctySrs":  "SERIES",
            "ClsPric":  "CLOSE",
        })
        log.info("Detected UDiFF format — columns normalised")
    else:
        df.columns = [c.upper() for c in df.columns]

    # Keep only equity series (EQ, BE)
    df = df[df["SERIES"].str.strip().isin(NSE_EQUITY_SERIES)].copy()

    df["SYMBOL"] = df["SYMBOL"].str.strip()
    df["SERIES"] = df["SERIES"].str.strip()
    df["ISIN"]   = df["ISIN"].str.strip() if "ISIN" in df.columns else None
    df["CLOSE"]  = pd.to_numeric(df["CLOSE"], errors="coerce")
    df = df.dropna(subset=["CLOSE"])

    log.info("Parsed %d equity rows for %s", len(df), trade_date)
    return df[["SYMBOL", "ISIN", "SERIES", "CLOSE"]].assign(trade_date=trade_date)


def run(trade_date: date = None):
    """Full ingestion run: fetch → parse → upsert to DB."""
    df = fetch_and_parse_bhavcopy(trade_date)
    if df.empty:
        return

    db = Database()
    try:
        # Bulk upsert security_master in one round trip
        security_tuples = [("EQUITY", row["SYMBOL"]) for _, row in df.iterrows()]
        code_to_id = db.bulk_upsert_securities(security_tuples)

        equity_rows = []
        price_rows  = []
        for _, row in df.iterrows():
            sec_id = code_to_id.get(row["SYMBOL"])
            if sec_id is None:
                continue
            isin = row["ISIN"] if pd.notna(row["ISIN"]) and len(str(row["ISIN"])) == 12 else None
            equity_rows.append(
                {
                    "security_id":         sec_id,
                    "symbol":              row["SYMBOL"],
                    "company_name":        row["SYMBOL"],  # placeholder; nse_master.py enriches this
                    "isin":                isin,
                    "series":              row["SERIES"],
                    "market_cap_category": None,           # preserve whatever nse_sectors.py set
                }
            )
            price_rows.append((sec_id, row["trade_date"], float(row["CLOSE"])))

        db.bulk_upsert_equity_master(equity_rows)
        db.bulk_insert_daily_prices(price_rows)
        log.info(
            "NSE EOD ingestion complete — %d symbols, %d prices written",
            len(equity_rows), len(price_rows),
        )
    finally:
        db.close()


if __name__ == "__main__":
    run()
