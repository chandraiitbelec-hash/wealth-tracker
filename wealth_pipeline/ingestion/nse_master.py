"""
NSE Equity Master Enrichment
-----------------------------
Fetches NSE's EQUITY_L.csv — a full listing of all equities with:
  company name, ISIN, series, face value, listing date, market lot

This enriches equity_master rows that nse_eod.py created with only
symbol + ISIN + series from Bhavcopy.

Source: https://archives.nseindia.com/content/equities/EQUITY_L.csv
Format: CSV (no auth required)

Sector / industry data comes from a separate NSE API endpoint and is
fetched in a second pass (see fetch_sector_data).

Schedule: Weekly (Sunday midnight IST) — this data changes rarely.
Can also be run once on setup to seed the full equity master.
"""

import requests
import pandas as pd
from io import StringIO
from datetime import date, datetime
from utils.logger import get_logger
from db.connection import Database
from config import NSE_HEADERS

log = get_logger("nse_master")

EQUITY_LIST_URL = "https://archives.nseindia.com/content/equities/EQUITY_L.csv"

# NSE's industry classification API (returns JSON with symbol → industry/sector)
NSE_INDUSTRY_URL = "https://www.nseindia.com/api/equity-master"


def _get_nse_session() -> requests.Session:
    session = requests.Session()
    session.headers.update(NSE_HEADERS)
    session.get("https://www.nseindia.com", timeout=15)
    return session


def fetch_equity_list() -> pd.DataFrame:
    """
    Download EQUITY_L.csv and return a cleaned DataFrame with columns:
        symbol, company_name, series, listing_date, face_value, isin
    """
    log.info("Fetching NSE equity master list from %s", EQUITY_LIST_URL)
    session = _get_nse_session()
    resp = session.get(EQUITY_LIST_URL, timeout=30)
    resp.raise_for_status()

    df = pd.read_csv(StringIO(resp.text), dtype=str)
    df.columns = [c.strip().upper().replace(" ", "_") for c in df.columns]

    # NSE column names in EQUITY_L.csv:
    #   SYMBOL, NAME_OF_COMPANY, SERIES, DATE_OF_LISTING, PAID_UP_VALUE,
    #   MARKET_LOT, ISIN_NUMBER, FACE_VALUE
    rename_map = {
        "SYMBOL":          "symbol",
        "NAME_OF_COMPANY": "company_name",
        "SERIES":          "series",
        "DATE_OF_LISTING": "listing_date",
        "FACE_VALUE":      "face_value",
        "ISIN_NUMBER":     "isin",
    }
    df = df.rename(columns={k: v for k, v in rename_map.items() if k in df.columns})

    # Keep only columns we care about
    keep = [c for c in ["symbol", "company_name", "series", "listing_date", "face_value", "isin"] if c in df.columns]
    df = df[keep].copy()

    df["symbol"]       = df["symbol"].str.strip()
    df["company_name"] = df["company_name"].str.strip()
    df["series"]       = df["series"].str.strip() if "series" in df.columns else "EQ"

    if "listing_date" in df.columns:
        df["listing_date"] = pd.to_datetime(df["listing_date"], format="%d-%b-%Y", errors="coerce").dt.date

    if "face_value" in df.columns:
        df["face_value"] = pd.to_numeric(df["face_value"], errors="coerce")

    df = df[df["symbol"].str.len() > 0]
    log.info("Fetched %d equity records from NSE master list", len(df))
    return df


def fetch_sector_data() -> dict:
    """
    Fetch NSE industry/sector classification for all securities.
    Returns dict: {symbol -> {"industry": ..., "sector": ...}}
    """
    log.info("Fetching NSE sector/industry classification")
    session = _get_nse_session()
    try:
        resp = session.get(NSE_INDUSTRY_URL, timeout=30)
        resp.raise_for_status()
        data = resp.json()
    except Exception as exc:
        log.warning("Could not fetch sector data: %s", exc)
        return {}

    # Response is a list of {symbol, industry, macro} or similar
    # Structure varies — handle gracefully
    result = {}
    try:
        if isinstance(data, list):
            for item in data:
                if not isinstance(item, dict):
                    continue
                sym = item.get("symbol", "").strip()
                if sym:
                    result[sym] = {
                        "industry": (item.get("industry") or "").strip() or None,
                        "sector":   (item.get("macro") or "").strip() or None,
                    }
        elif isinstance(data, dict):
            for sym, details in data.items():
                if not isinstance(details, dict):
                    continue
                result[sym.strip()] = {
                    "industry": (details.get("industry") or "").strip() or None,
                    "sector":   (details.get("macro") or "").strip() or None,
                }
    except Exception as exc:
        log.warning("Error parsing sector data structure: %s — continuing without sector info", exc)

    log.info("Fetched sector data for %d symbols", len(result))
    return result


def run():
    """
    Full master enrichment run:
      1. Fetch EQUITY_L.csv
      2. Fetch sector/industry data
      3. Merge and upsert into security_master + equity_master
    """
    equity_df  = fetch_equity_list()
    sector_map = fetch_sector_data()

    if equity_df.empty:
        log.warning("No equity master data fetched — aborting")
        return

    db = Database()
    try:
        # Bulk upsert security_master in one round trip
        security_tuples = [("EQUITY", row["symbol"]) for _, row in equity_df.iterrows()]
        code_to_id = db.bulk_upsert_securities(security_tuples)

        equity_rows = []
        for _, row in equity_df.iterrows():
            symbol  = row["symbol"]
            sec_id  = code_to_id.get(symbol)
            if sec_id is None:
                continue
            sectors = sector_map.get(symbol, {})

            equity_rows.append(
                {
                    "security_id":         sec_id,
                    "symbol":              symbol,
                    "company_name":        row.get("company_name", symbol),
                    "isin":                row.get("isin") if pd.notna(row.get("isin", None)) else None,
                    "series":              row.get("series"),
                    "face_value":          row.get("face_value") if pd.notna(row.get("face_value", None)) else None,
                    "listing_date":        row.get("listing_date") if pd.notna(row.get("listing_date", None)) else None,
                    "industry":            sectors.get("industry"),
                    "sector":              sectors.get("sector"),
                    "market_cap_category": "UNKNOWN",  # enriched separately via index membership
                }
            )

        db.bulk_upsert_equity_master(equity_rows)
        log.info("NSE equity master enrichment complete — %d symbols upserted", len(equity_rows))
    finally:
        db.close()


if __name__ == "__main__":
    run()
