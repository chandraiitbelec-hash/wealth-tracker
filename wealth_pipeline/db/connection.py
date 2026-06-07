"""
Database connection and all upsert/query helpers.

Design:
  - security_master is the thin anchor; every asset gets a row here first.
  - equity_master / mutual_fund_master are extension tables with rich static data.
  - daily_prices and intraday_live_feed reference security_master.id.
"""

import psycopg2
from psycopg2.extras import execute_values
from config import DB_CONFIG


def get_connection():
    return psycopg2.connect(**DB_CONFIG)


class Database:

    def __init__(self):
        self.conn = get_connection()
        self.conn.autocommit = False

    def close(self):
        self.conn.close()

    # ------------------------------------------------------------------
    # Security Master  (anchor)
    # ------------------------------------------------------------------

    def upsert_security(self, asset_type: str, unique_code: str) -> int:
        """
        Single-row upsert — used by the live intraday job.
        For bulk ingestion use bulk_upsert_securities() instead.
        """
        return self.bulk_upsert_securities([(asset_type, unique_code)])[unique_code]

    def bulk_upsert_securities(self, rows: list) -> dict:
        """
        Bulk upsert into security_master in a single round trip.
        rows: list of (asset_type, unique_code)
        Returns dict: {unique_code -> id}
        """
        if not rows:
            return {}
        with self.conn.cursor() as cur:
            fetched = execute_values(
                cur,
                """
                INSERT INTO security_master (asset_type, unique_code)
                VALUES %s
                ON CONFLICT (unique_code) DO UPDATE
                    SET asset_type = EXCLUDED.asset_type
                RETURNING id, unique_code
                """,
                rows,
                fetch=True,   # collect ALL batches' RETURNING rows, not just the last
            )
            result = {row[1]: row[0] for row in fetched}
        self.conn.commit()
        return result

    def get_security_id(self, asset_type: str, unique_code: str) -> "int | None":
        with self.conn.cursor() as cur:
            cur.execute(
                "SELECT id FROM security_master WHERE asset_type = %s AND unique_code = %s",
                (asset_type, unique_code),
            )
            row = cur.fetchone()
            return row[0] if row else None

    # ------------------------------------------------------------------
    # Equity Master  (NSE equities static data)
    # ------------------------------------------------------------------

    def upsert_equity_master(
        self,
        security_id: int,
        symbol: str,
        company_name: str,
        isin: str = None,
        series: str = None,
        industry: str = None,
        sector: str = None,
        face_value: float = None,
        listing_date=None,
        market_cap_category: str = "UNKNOWN",
    ):
        with self.conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO equity_master (
                    security_id, symbol, company_name, isin, series,
                    industry, sector, face_value, listing_date, market_cap_category
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (security_id) DO UPDATE SET
                    company_name        = COALESCE(EXCLUDED.company_name,        equity_master.company_name),
                    isin                = COALESCE(EXCLUDED.isin,                equity_master.isin),
                    series              = COALESCE(EXCLUDED.series,              equity_master.series),
                    industry            = COALESCE(EXCLUDED.industry,            equity_master.industry),
                    sector              = COALESCE(EXCLUDED.sector,              equity_master.sector),
                    face_value          = COALESCE(EXCLUDED.face_value,          equity_master.face_value),
                    listing_date        = COALESCE(EXCLUDED.listing_date,        equity_master.listing_date),
                    market_cap_category = COALESCE(EXCLUDED.market_cap_category, equity_master.market_cap_category),
                    updated_at          = CURRENT_TIMESTAMP
                """,
                (
                    security_id, symbol, company_name, isin, series,
                    industry, sector, face_value, listing_date, market_cap_category,
                ),
            )
        self.conn.commit()

    def bulk_upsert_equity_master(self, rows: list[dict]):
        """
        rows: list of dicts with keys matching equity_master columns.
        Faster than calling upsert_equity_master() in a loop.
        """
        if not rows:
            return
        tuples = [
            (
                r["security_id"], r["symbol"], r.get("company_name", r["symbol"]),
                r.get("isin"), r.get("series"), r.get("industry"), r.get("sector"),
                r.get("face_value"), r.get("listing_date"), r.get("market_cap_category", "UNKNOWN"),
            )
            for r in rows
        ]
        with self.conn.cursor() as cur:
            execute_values(
                cur,
                """
                INSERT INTO equity_master (
                    security_id, symbol, company_name, isin, series,
                    industry, sector, face_value, listing_date, market_cap_category
                )
                VALUES %s
                ON CONFLICT (security_id) DO UPDATE SET
                    company_name        = COALESCE(EXCLUDED.company_name,        equity_master.company_name),
                    isin                = COALESCE(EXCLUDED.isin,                equity_master.isin),
                    series              = COALESCE(EXCLUDED.series,              equity_master.series),
                    industry            = COALESCE(EXCLUDED.industry,            equity_master.industry),
                    sector              = COALESCE(EXCLUDED.sector,              equity_master.sector),
                    face_value          = COALESCE(EXCLUDED.face_value,          equity_master.face_value),
                    listing_date        = COALESCE(EXCLUDED.listing_date,        equity_master.listing_date),
                    market_cap_category = COALESCE(EXCLUDED.market_cap_category, equity_master.market_cap_category),
                    updated_at          = CURRENT_TIMESTAMP
                """,
                tuples,
            )
        self.conn.commit()

    # ------------------------------------------------------------------
    # Mutual Fund Master  (AMFI scheme static data)
    # ------------------------------------------------------------------

    def bulk_upsert_mf_master(self, rows: list[dict]):
        """
        rows: list of dicts with keys matching mutual_fund_master columns.
        """
        if not rows:
            return
        tuples = [
            (
                r["security_id"], r["scheme_code"], r["scheme_name"],
                r.get("amc_name"), r.get("isin_growth"), r.get("isin_div_payout"),
                r.get("isin_div_reinvestment"), r.get("scheme_category"),
                r.get("scheme_type", "Unknown"), r.get("plan", "Unknown"),
                r.get("option", "Unknown"), r.get("benchmark"),
            )
            for r in rows
        ]
        with self.conn.cursor() as cur:
            execute_values(
                cur,
                """
                INSERT INTO mutual_fund_master (
                    security_id, scheme_code, scheme_name, amc_name,
                    isin_growth, isin_div_payout, isin_div_reinvestment,
                    scheme_category, scheme_type, plan, option, benchmark
                )
                VALUES %s
                ON CONFLICT (security_id) DO UPDATE SET
                    scheme_name           = EXCLUDED.scheme_name,
                    amc_name              = COALESCE(EXCLUDED.amc_name,              mutual_fund_master.amc_name),
                    isin_growth           = COALESCE(EXCLUDED.isin_growth,           mutual_fund_master.isin_growth),
                    isin_div_payout       = COALESCE(EXCLUDED.isin_div_payout,       mutual_fund_master.isin_div_payout),
                    isin_div_reinvestment = COALESCE(EXCLUDED.isin_div_reinvestment, mutual_fund_master.isin_div_reinvestment),
                    scheme_category       = COALESCE(EXCLUDED.scheme_category,       mutual_fund_master.scheme_category),
                    scheme_type           = COALESCE(EXCLUDED.scheme_type,           mutual_fund_master.scheme_type),
                    plan                  = COALESCE(EXCLUDED.plan,                  mutual_fund_master.plan),
                    option                = COALESCE(EXCLUDED.option,                mutual_fund_master.option),
                    updated_at            = CURRENT_TIMESTAMP
                """,
                tuples,
            )
        self.conn.commit()

    # ------------------------------------------------------------------
    # Daily EOD prices
    # ------------------------------------------------------------------

    def bulk_insert_daily_prices(self, rows: list[tuple]):
        """rows: list of (security_id, price_date, close_price)"""
        if not rows:
            return
        with self.conn.cursor() as cur:
            execute_values(
                cur,
                """
                INSERT INTO daily_prices (security_id, price_date, close_price)
                VALUES %s
                ON CONFLICT (security_id, price_date) DO UPDATE SET
                    close_price = EXCLUDED.close_price,
                    updated_at  = CURRENT_TIMESTAMP
                """,
                rows,
            )
        self.conn.commit()

    # ------------------------------------------------------------------
    # Intraday live cache
    # ------------------------------------------------------------------

    def bulk_upsert_intraday(self, rows: list[tuple]):
        """rows: list of (security_id, last_price, last_updated)"""
        if not rows:
            return
        with self.conn.cursor() as cur:
            execute_values(
                cur,
                """
                INSERT INTO intraday_live_feed (security_id, last_price, is_delayed_feed, last_updated)
                VALUES %s
                ON CONFLICT (security_id) DO UPDATE SET
                    last_price   = EXCLUDED.last_price,
                    last_updated = EXCLUDED.last_updated
                """,
                rows,
            )
        self.conn.commit()

    def clear_intraday_cache(self):
        with self.conn.cursor() as cur:
            cur.execute("DELETE FROM intraday_live_feed")
        self.conn.commit()
