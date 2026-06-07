-- Wealth Pipeline — Database Schema
-- Run this once to initialise:
--   psql [connection_string] -f db/schema.sql

-- ============================================================
-- 1. Security Master (thin anchor table)
--    Exists only to give daily_prices and intraday_live_feed
--    a single stable FK regardless of asset type.
-- ============================================================
CREATE TABLE IF NOT EXISTS security_master (
    id          SERIAL PRIMARY KEY,
    asset_type  VARCHAR(15) NOT NULL CHECK (asset_type IN ('EQUITY', 'MUTUAL_FUND')),
    unique_code VARCHAR(20) UNIQUE NOT NULL,  -- NSE ticker OR AMFI scheme code
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_security_master_type_code
    ON security_master (asset_type, unique_code);


-- ============================================================
-- 2. Equity Master (NSE equities static data)
-- ============================================================
CREATE TABLE IF NOT EXISTS equity_master (
    id                  SERIAL PRIMARY KEY,
    security_id         INT UNIQUE NOT NULL REFERENCES security_master(id) ON DELETE CASCADE,
    symbol              VARCHAR(20)  NOT NULL,   -- NSE ticker, e.g. RELIANCE
    company_name        VARCHAR(255) NOT NULL,
    isin                VARCHAR(12)  UNIQUE,
    series              VARCHAR(5),              -- EQ, BE, etc.
    industry            VARCHAR(100),            -- NSE industry classification
    sector              VARCHAR(100),            -- broader sector grouping
    face_value          DECIMAL(10, 2),
    listing_date        DATE,
    market_cap_category VARCHAR(10) CHECK (
                            market_cap_category IN ('LARGECAP', 'MIDCAP', 'SMALLCAP', 'UNKNOWN')
                        ),
    updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_equity_master_symbol  ON equity_master (symbol);
CREATE INDEX IF NOT EXISTS idx_equity_master_isin    ON equity_master (isin);
CREATE INDEX IF NOT EXISTS idx_equity_master_sector  ON equity_master (sector);


-- ============================================================
-- 3. Mutual Fund Master (AMFI scheme static data)
-- ============================================================
CREATE TABLE IF NOT EXISTS mutual_fund_master (
    id                      SERIAL PRIMARY KEY,
    security_id             INT UNIQUE NOT NULL REFERENCES security_master(id) ON DELETE CASCADE,
    scheme_code             VARCHAR(20)  NOT NULL,   -- AMFI scheme code
    scheme_name             VARCHAR(255) NOT NULL,
    amc_name                VARCHAR(150),            -- e.g. "HDFC Mutual Fund"
    isin_growth             VARCHAR(12),             -- ISIN for Growth / Reinvestment option
    isin_div_payout         VARCHAR(12),             -- ISIN for Dividend Payout option
    isin_div_reinvestment   VARCHAR(12),             -- ISIN for Dividend Reinvestment option
    scheme_category         VARCHAR(80),             -- e.g. "Equity Scheme - Large Cap Fund"
    scheme_type             VARCHAR(20) CHECK (
                                scheme_type IN ('Open-ended', 'Close-ended', 'Interval', 'Unknown')
                            ),
    plan                    VARCHAR(10) CHECK (plan IN ('Direct', 'Regular', 'Unknown')),
    option                  VARCHAR(10) CHECK (option IN ('Growth', 'IDCW', 'Unknown')),
    benchmark               VARCHAR(150),
    updated_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mf_master_scheme_code    ON mutual_fund_master (scheme_code);
CREATE INDEX IF NOT EXISTS idx_mf_master_isin_growth    ON mutual_fund_master (isin_growth);
CREATE INDEX IF NOT EXISTS idx_mf_master_amc            ON mutual_fund_master (amc_name);
CREATE INDEX IF NOT EXISTS idx_mf_master_category       ON mutual_fund_master (scheme_category);


-- ============================================================
-- 4. Daily EOD Historical Prices
--    Shared across equities (NSE close) and MFs (AMFI NAV).
-- ============================================================
CREATE TABLE IF NOT EXISTS daily_prices (
    security_id INT  NOT NULL REFERENCES security_master(id) ON DELETE CASCADE,
    price_date  DATE NOT NULL,
    close_price DECIMAL(15, 4) NOT NULL,
    updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (security_id, price_date)
);

CREATE INDEX IF NOT EXISTS idx_daily_prices_date
    ON daily_prices (price_date DESC);


-- ============================================================
-- 5. Intraday Live Cache  (equities only)
--    Overwritten every 5 minutes during market hours.
--    Cleared at 9:15 AM each trading day.
-- ============================================================
CREATE TABLE IF NOT EXISTS intraday_live_feed (
    security_id     INT PRIMARY KEY REFERENCES security_master(id) ON DELETE CASCADE,
    last_price      DECIMAL(15, 4) NOT NULL,
    is_delayed_feed BOOLEAN        DEFAULT TRUE,
    last_updated    TIMESTAMP      NOT NULL
);
