"""
NSE Sector & Market Cap Seeder
-------------------------------
Downloads NSE index constituent files to enrich equity_master with:
  - industry / sector  (from thematic indices)
  - market_cap_category (LARGECAP / MIDCAP / SMALLCAP from size indices)

Sources: https://archives.nseindia.com/content/indices/ind_<name>list.csv

Schedule: Weekly (same as nse_master.py — Sunday 1 AM IST).
Can also be run once on setup.
"""

import io
import time
import requests
import pandas as pd
from utils.logger import get_logger
from db.connection import Database
from config import NSE_HEADERS

log = get_logger("nse_sectors")

BASE_URL = "https://archives.nseindia.com/content/indices/ind_{}list.csv"

# ── Thematic indices → sector label ─────────────────────────────────────────
SECTOR_INDICES = {
    "niftybank":         "Banking & Finance",
    "niftyit":           "Information Technology",
    "niftypharma":       "Pharmaceuticals",
    "niftyauto":         "Automobile",
    "niftyfmcg":         "FMCG",
    "niftymetal":        "Metals & Mining",
    "niftyenergy":       "Energy & Oil",
    "niftyrealty":       "Real Estate",
    "niftymedia":        "Media & Entertainment",
}

# ── Size indices → market cap category ──────────────────────────────────────
# Priority order matters — Nifty 50 overrides Nifty Next 50 for LARGECAP
SIZE_INDICES = [
    ("nifty50",          "LARGECAP"),
    ("niftynext50",      "LARGECAP"),
    ("niftymidcap150",   "MIDCAP"),
    ("niftysmallcap250", "SMALLCAP"),
]


def _get_session() -> requests.Session:
    session = requests.Session()
    session.headers.update(NSE_HEADERS)
    session.get("https://www.nseindia.com", timeout=15)
    time.sleep(1)
    return session


def _fetch_index(session: requests.Session, index_name: str) -> pd.DataFrame:
    url = BASE_URL.format(index_name)
    try:
        resp = session.get(url, timeout=20)
        resp.raise_for_status()
        df = pd.read_csv(io.StringIO(resp.text), dtype=str)
        df.columns = [c.strip() for c in df.columns]
        return df
    except Exception as exc:
        log.warning("Failed to fetch %s: %s", index_name, exc)
        return pd.DataFrame()


def build_sector_map(session: requests.Session) -> dict:
    """
    Returns {symbol -> {"sector": ..., "industry": ...}}
    Uses the Industry column from the CSV (e.g. "Financial Services").
    Falls back to the thematic index label if the Industry column is blank.
    """
    sector_map = {}

    for index_name, sector_label in SECTOR_INDICES.items():
        df = _fetch_index(session, index_name)
        if df.empty:
            continue
        for _, row in df.iterrows():
            symbol = str(row.get("Symbol", "")).strip()
            industry = str(row.get("Industry", "")).strip()
            if not symbol:
                continue
            # Don't overwrite if already set from a more specific index
            if symbol not in sector_map:
                sector_map[symbol] = {
                    "sector":   sector_label,
                    "industry": industry if industry and industry != "nan" else sector_label,
                }
        log.info("  %-25s → %d symbols", index_name, len(df))

    # Also seed industry from Nifty 50 / Next 50 using their Industry column
    for index_name, _ in SIZE_INDICES[:2]:
        df = _fetch_index(session, index_name)
        for _, row in df.iterrows():
            symbol = str(row.get("Symbol", "")).strip()
            industry = str(row.get("Industry", "")).strip()
            if symbol and symbol not in sector_map and industry and industry != "nan":
                sector_map[symbol] = {
                    "sector":   industry,
                    "industry": industry,
                }

    log.info("Sector map built: %d symbols", len(sector_map))
    return sector_map


def build_market_cap_map(session: requests.Session) -> dict:
    """
    Returns {symbol -> "LARGECAP" | "MIDCAP" | "SMALLCAP"}
    Priority: Nifty 50 > Nifty Next 50 > Midcap 150 > Smallcap 250
    """
    cap_map = {}

    for index_name, cap_category in SIZE_INDICES:
        df = _fetch_index(session, index_name)
        if df.empty:
            continue
        for _, row in df.iterrows():
            symbol = str(row.get("Symbol", "")).strip()
            if symbol and symbol not in cap_map:   # first match wins (priority order)
                cap_map[symbol] = cap_category
        log.info("  %-25s → %d symbols (%s)", index_name, len(df), cap_category)

    log.info("Market cap map built: %d symbols", len(cap_map))
    return cap_map


def run():
    """
    Full sector + market cap enrichment:
      1. Fetch all index CSVs
      2. Build sector map and market cap map
      3. Bulk-update equity_master
    """
    log.info("Starting NSE sector & market cap seeding...")
    session = _get_session()

    sector_map  = build_sector_map(session)
    cap_map     = build_market_cap_map(session)

    if not sector_map and not cap_map:
        log.warning("No data fetched — aborting")
        return

    db = Database()
    try:
        updated = 0
        with db.conn.cursor() as cur:
            # Get all symbols from equity_master
            cur.execute("SELECT em.security_id, em.symbol FROM equity_master em")
            rows = cur.fetchall()

            for security_id, symbol in rows:
                sector_info = sector_map.get(symbol, {})
                cap_cat     = cap_map.get(symbol)

                if not sector_info and not cap_cat:
                    continue

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
                        sector_info.get("sector") or None,
                        sector_info.get("industry") or None,
                        cap_cat or None,
                        security_id,
                    ),
                )
                updated += 1

        db.conn.commit()
        log.info("Sector enrichment complete — %d symbols updated", updated)

        # Quick summary
        with db.conn.cursor() as cur:
            cur.execute("""
                SELECT sector, COUNT(*) FROM equity_master
                WHERE sector IS NOT NULL
                GROUP BY sector ORDER BY COUNT(*) DESC LIMIT 10
            """)
            log.info("Top sectors in DB:")
            for row in cur.fetchall():
                log.info("  %-35s %d stocks", row[0], row[1])

            cur.execute("""
                SELECT market_cap_category, COUNT(*) FROM equity_master
                WHERE market_cap_category != 'UNKNOWN'
                GROUP BY market_cap_category
            """)
            log.info("Market cap breakdown:")
            for row in cur.fetchall():
                log.info("  %-12s %d stocks", row[0], row[1])
    finally:
        db.close()


if __name__ == "__main__":
    run()
