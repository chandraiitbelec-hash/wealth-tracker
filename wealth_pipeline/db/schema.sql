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

-- Fund portfolio holdings (AMFI monthly disclosure scrape)
-- Stores each MF's stock-level holdings so we can compute "look-through" exposure
CREATE TABLE IF NOT EXISTS fund_portfolio_holdings (
    id                  SERIAL PRIMARY KEY,
    security_id         INTEGER NOT NULL REFERENCES security_master(id) ON DELETE CASCADE,
    holding_isin        VARCHAR(20)  NOT NULL,
    holding_name        VARCHAR(255) NOT NULL,
    industry            VARCHAR(128),
    quantity            BIGINT,
    market_value_lacs   DECIMAL(18,4),
    pct_to_nav          DECIMAL(8,4) NOT NULL,   -- e.g. 4.52 means 4.52 %
    disclosure_date     DATE         NOT NULL,
    created_at          TIMESTAMP DEFAULT NOW(),
    UNIQUE (security_id, holding_isin, disclosure_date)
);
CREATE INDEX IF NOT EXISTS idx_fph_security   ON fund_portfolio_holdings(security_id);
CREATE INDEX IF NOT EXISTS idx_fph_isin       ON fund_portfolio_holdings(holding_isin);
CREATE INDEX IF NOT EXISTS idx_fph_date       ON fund_portfolio_holdings(disclosure_date);

-- Weekly portfolio snapshots (for AI digest delta computation)
CREATE TABLE IF NOT EXISTS portfolio_snapshots (
    id              SERIAL PRIMARY KEY,
    user_identifier VARCHAR(64)  NOT NULL,   -- broker client ID or email hash
    snapshot_date   DATE         NOT NULL,
    total_value     DECIMAL(18,2),
    stocks_value    DECIMAL(18,2),
    mf_value        DECIMAL(18,2),
    total_invested  DECIMAL(18,2),
    total_pnl       DECIMAL(18,2),
    payload_json    JSONB,                   -- full serialised portfolio
    created_at      TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_identifier, snapshot_date)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Sentiment Engine Tables
-- ─────────────────────────────────────────────────────────────────────────────

-- Daily delivery statistics per symbol (from NSE MTO file)
-- Delivery % = deliverable_qty / traded_qty * 100
-- High delivery = institutional conviction; low delivery = speculative froth
CREATE TABLE IF NOT EXISTS stock_delivery_stats (
    symbol          VARCHAR(20)  NOT NULL,
    trade_date      DATE         NOT NULL,
    traded_qty      BIGINT,
    deliverable_qty BIGINT,
    delivery_pct    DECIMAL(6,2),
    PRIMARY KEY (symbol, trade_date)
);
CREATE INDEX IF NOT EXISTS idx_delivery_symbol ON stock_delivery_stats(symbol);

-- Corporate announcements from NSE exchange filings feed
-- LLM score range: -5 (very negative) to +5 (very positive)
CREATE TABLE IF NOT EXISTS corporate_disclosures (
    id               SERIAL PRIMARY KEY,
    symbol           VARCHAR(20)  NOT NULL,
    disclosed_at     TIMESTAMP    NOT NULL,
    subject          VARCHAR(512) NOT NULL,
    body             TEXT,
    llm_score        SMALLINT,          -- -5 to +5; NULL = not yet processed
    llm_rationale    TEXT,
    source           VARCHAR(10)  DEFAULT 'NSE',
    created_at       TIMESTAMP    DEFAULT NOW(),
    UNIQUE (symbol, disclosed_at, subject)
);
CREATE INDEX IF NOT EXISTS idx_disc_symbol ON corporate_disclosures(symbol);
CREATE INDEX IF NOT EXISTS idx_disc_date   ON corporate_disclosures(disclosed_at DESC);

-- Options chain snapshots — near-month expiry aggregated OI and IV
CREATE TABLE IF NOT EXISTS stock_options_data (
    symbol           VARCHAR(20)  NOT NULL,
    snapshot_date    DATE         NOT NULL,
    expiry_date      DATE         NOT NULL,
    total_put_oi     BIGINT,
    total_call_oi    BIGINT,
    pcr              DECIMAL(6,4),      -- put OI / call OI  (<1 bullish, >1 bearish)
    atm_call_iv      DECIMAL(8,4),      -- implied vol of ATM call (%)
    atm_put_iv       DECIMAL(8,4),      -- implied vol of ATM put (%)
    iv_skew          DECIMAL(8,4),      -- put_iv - call_iv (positive = bearish skew)
    underlying_price DECIMAL(14,2),
    PRIMARY KEY (symbol, snapshot_date, expiry_date)
);
CREATE INDEX IF NOT EXISTS idx_opts_symbol ON stock_options_data(symbol);

-- Blended sentiment indicators (refreshed nightly by sentiment_engine.py)
CREATE TABLE IF NOT EXISTS stock_sentiment_indicators (
    symbol                    VARCHAR(20) PRIMARY KEY,
    -- Sub-scores  -5 … +5
    delivery_score            SMALLINT,
    disclosure_score          SMALLINT,
    institutional_score       SMALLINT,
    derivatives_score         SMALLINT,
    -- Blended score  -5 … +5
    blended_score             DECIMAL(4,2),
    -- Raw data for UI divergence chart
    delivery_pct_5d           DECIMAL(6,2),
    delivery_pct_20d          DECIMAL(6,2),
    delivery_trend            VARCHAR(12),   -- RISING | FALLING | NEUTRAL
    mf_shares_change_pct      DECIMAL(8,4),  -- MoM % change in MF aggregate ownership
    pcr                       DECIMAL(6,4),
    iv_skew                   DECIMAL(8,4),
    latest_disclosure_subject VARCHAR(512),
    latest_disclosure_score   SMALLINT,
    -- Human-readable signal for UI
    signal                    VARCHAR(16),   -- ACCUMULATION | DISTRIBUTION | FROTH | NEUTRAL
    signal_reason             TEXT,
    updated_at                TIMESTAMP DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- News Feed Tables
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS news_articles (
    id              SERIAL PRIMARY KEY,
    source          VARCHAR(40)  NOT NULL,    -- e.g. "economic_times", "rbi"
    category        VARCHAR(20)  NOT NULL,    -- economy | market | stocks | mf
    title           TEXT         NOT NULL,
    summary         TEXT,
    url             TEXT         NOT NULL UNIQUE,
    published_at    TIMESTAMP    NOT NULL,
    tagged_symbols  TEXT[]       DEFAULT '{}', -- NSE symbols mentioned e.g. {RELIANCE,HDFC}
    created_at      TIMESTAMP    DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_news_published  ON news_articles(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_news_category   ON news_articles(category);
CREATE INDEX IF NOT EXISTS idx_news_symbols    ON news_articles USING GIN(tagged_symbols);
