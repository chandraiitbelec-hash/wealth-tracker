# Wealth Pipeline — Data Ingestion Layer

Price feed engine for the unified wealth platform. Ingests mutual fund NAVs (AMFI) and equity prices (NSE) into a unified PostgreSQL schema.

## Architecture

```
[ AMFI Portal (Text) ]  ──(11 PM daily)──>  [ amfi.py ]     ─┐
[ NSE Bhavcopy (ZIP) ]  ──(7 PM daily)───>  [ nse_eod.py ]  ─┼─> [ PostgreSQL ]
[ NSE Delayed JSON   ]  ──(every 5 min)──>  [ nse_live.py ] ─┘
                                 ▲
                          [ scheduler.py ]  (APScheduler, runs as a daemon)
```

## Setup

### 1. Prerequisites
- Python 3.11+
- PostgreSQL 14+

### 2. Install dependencies
```bash
cd wealth_pipeline
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 3. Configure environment
```bash
cp .env.example .env
# Edit .env with your PostgreSQL credentials
```

### 4. Initialise the database
```bash
psql -U postgres -c "CREATE DATABASE wealth_db;"
psql -U postgres -d wealth_db -f db/schema.sql
```

### 5. Run a one-off ingestion (test)
```bash
python -m ingestion.amfi          # fetch today's AMFI NAVs
python -m ingestion.nse_eod       # fetch today's NSE Bhavcopy
python -m ingestion.nse_live      # one live tick (only works during market hours)
```

### 6. Start the scheduler (production)
```bash
python scheduler.py
```

## Schedule Summary

| Job | Trigger | Source |
|-----|---------|--------|
| AMFI NAV | Daily 11:00 PM IST | portal.amfiindia.com |
| NSE EOD | Mon–Fri 7:00 PM IST | nseindia.com Bhavcopy ZIP |
| NSE Live | Mon–Fri every 5 min, 9:15–3:30 IST | nseindia.com public API |
| Cache clear | Mon–Fri 9:15 AM IST | internal |

## Key Design Decisions

- **Upsert everywhere** — all jobs are safe to re-run; no duplicate data.
- **Session reuse for NSE** — NSE blocks plain requests; a cookie-bootstrapped session is created once and reused across intraday ticks.
- **Holiday guard** — `utils/holidays.py` prevents unnecessary fetch attempts on non-trading days.
- **Settled vs. live split** — `daily_prices` holds T+1 settled data; `intraday_live_feed` holds the current-day delayed snapshot, cleared each morning.
- **AMFI encoding** — file decoded with `errors="replace"` to handle occasional non-UTF-8 characters.
