"""
Scheduler
---------
Wires up all ingestion jobs using APScheduler (in-process cron).
Run this as a long-lived process: `python scheduler.py`

Jobs (16 total):
   1. AMFI NAV                 — daily at 11:00 PM IST
   2. NSE EOD Bhavcopy         — Mon–Fri at 7:00 PM IST
   3. NSE Live Intraday        — Mon–Fri every 5 min, 9:15–3:30 IST
   4. Intraday cache clear     — Mon–Fri at 9:15 AM IST
   5. NSE Equity Master        — weekly, Sunday 1:00 AM IST
   6. NSE Sector & Market Cap  — weekly, Sunday 2:00 AM IST (after master)
   7. NSE Industry class.      — weekly, Sunday 3:00 AM IST (after sectors)
   8. Delivery + Options chain — Mon–Fri at 7:30 PM IST (after EOD prices)
   9. NSE Disclosures + LLM   — Mon–Fri at 8:00 PM IST
  10. Sentiment engine         — Mon–Fri at 9:00 PM IST (after all signals)
  11. News Feed (market hours) — Mon–Fri every 15 min, 9:00 AM – 4:00 PM IST
  12. News Feed (off-hours)    — hourly, every day
  13. AMFI Portfolio discl.    — monthly, 15th at 2:00 AM IST
  14. Weekly AI digest         — every Friday at 5:00 PM IST
  15. Supabase keepalive       — daily at noon IST
  16. Price retention cleanup  — weekly, Sunday 4:00 AM IST
"""

import signal
import sys
from apscheduler.schedulers.blocking import BlockingScheduler
from apscheduler.triggers.cron import CronTrigger

from ingestion import amfi, nse_eod, nse_live, nse_master, nse_sectors, nse_industry, amfi_portfolio
from ingestion import alternative_data, nse_disclosures, news_feed
import sentiment_engine
from digest import emailer as digest_emailer
from utils.holidays import is_trading_day
from utils.logger import get_logger
from db.connection import get_connection
from config import (
    AMFI_CRON,
    NSE_EOD_CRON,
    NSE_LIVE_INTERVAL_MINUTES,
    MARKET_OPEN_HOUR,
    MARKET_OPEN_MINUTE,
    MARKET_CLOSE_HOUR,
)

log = get_logger("scheduler")
TZ = "Asia/Kolkata"


def _supabase_keepalive():
    """
    Touch the DB so Supabase doesn't pause the free-tier project.
    Supabase pauses after 7 days of inactivity — this runs daily at noon.
    A SELECT 1 is enough; it resets the activity timer at zero cost.
    """
    try:
        conn = get_connection()
        with conn.cursor() as cur:
            cur.execute("SELECT 1")
        conn.close()
        log.debug("Supabase keepalive OK")
    except Exception as exc:
        log.warning("Supabase keepalive failed: %s", exc)


def _price_retention_cleanup():
    """
    Delete stock_daily_prices rows older than 2 years.
    Keeps storage bounded (~120 MB cap vs unbounded growth).
    Runs weekly on Sunday night after all ingestion is done.
    """
    try:
        conn = get_connection()
        with conn.cursor() as cur:
            cur.execute("""
                DELETE FROM stock_daily_prices
                WHERE trade_date < CURRENT_DATE - INTERVAL '2 years'
            """)
            deleted = cur.rowcount
        conn.commit()
        conn.close()
        if deleted:
            log.info("Price retention: deleted %d rows older than 2 years", deleted)
        else:
            log.debug("Price retention: nothing to prune")
    except Exception as exc:
        log.warning("Price retention cleanup failed: %s", exc)


def _trading_day_guard(fn):
    """Wrap a job so it skips execution on NSE market holidays."""
    def wrapper():
        if not is_trading_day():
            log.info("Skipping %s — today is not a trading day.", fn.__name__)
            return
        fn()
    wrapper.__name__ = fn.__name__
    return wrapper


def main():
    scheduler = BlockingScheduler(timezone=TZ)

    # 1. AMFI NAV — daily 11 PM IST
    scheduler.add_job(
        amfi.run,
        CronTrigger(hour=AMFI_CRON["hour"], minute=AMFI_CRON["minute"], timezone=TZ),
        id="amfi_nav",
        name="AMFI NAV Ingestion",
        misfire_grace_time=3600,
    )

    # 2. NSE EOD Bhavcopy — Mon–Fri 7 PM IST (skips market holidays)
    scheduler.add_job(
        _trading_day_guard(nse_eod.run),
        CronTrigger(day_of_week="mon-fri", hour=NSE_EOD_CRON["hour"],
                    minute=NSE_EOD_CRON["minute"], timezone=TZ),
        id="nse_eod",
        name="NSE EOD Bhavcopy Ingestion",
        misfire_grace_time=3600,
    )

    # 3. NSE Intraday — every 5 min during market hours (skips market holidays)
    scheduler.add_job(
        _trading_day_guard(nse_live.run),
        CronTrigger(
            day_of_week="mon-fri",
            hour=f"{MARKET_OPEN_HOUR}-{MARKET_CLOSE_HOUR}",
            minute=f"*/{NSE_LIVE_INTERVAL_MINUTES}",
            timezone=TZ,
        ),
        id="nse_live",
        name="NSE Live Intraday Tick",
        misfire_grace_time=60,
    )

    # 4. Clear intraday cache at market open (skips market holidays)
    scheduler.add_job(
        _trading_day_guard(nse_live.clear_cache),
        CronTrigger(day_of_week="mon-fri", hour=MARKET_OPEN_HOUR,
                    minute=MARKET_OPEN_MINUTE, timezone=TZ),
        id="intraday_cache_clear",
        name="Clear Intraday Cache",
    )

    # 5. NSE Equity Master enrichment — weekly, Sunday 1 AM IST
    scheduler.add_job(
        nse_master.run,
        CronTrigger(day_of_week="sun", hour=1, minute=0, timezone=TZ),
        id="nse_master",
        name="NSE Equity Master Enrichment",
        misfire_grace_time=7200,
    )

    # 6. NSE Sector & Market Cap seeding — weekly, Sunday 2 AM IST (after master)
    scheduler.add_job(
        nse_sectors.run,
        CronTrigger(day_of_week="sun", hour=2, minute=0, timezone=TZ),
        id="nse_sectors",
        name="NSE Sector & Market Cap Enrichment",
        misfire_grace_time=7200,
    )

    # 7. NSE Industry classification — weekly, Sunday 3 AM IST (after sectors)
    scheduler.add_job(
        nse_industry.run,
        CronTrigger(day_of_week="sun", hour=3, minute=0, timezone=TZ),
        id="nse_industry",
        name="NSE Industry Classification Enrichment",
        misfire_grace_time=7200,
    )

    # 8. Delivery stats + Options chain — Mon–Fri at 7:30 PM IST (after EOD prices)
    scheduler.add_job(
        _trading_day_guard(alternative_data.run),
        CronTrigger(day_of_week="mon-fri", hour=19, minute=30, timezone=TZ),
        id="alternative_data",
        name="Delivery Stats & Options Chain",
        misfire_grace_time=3600,
    )

    # 9. NSE Disclosures + LLM scoring — Mon–Fri at 8:00 PM IST
    scheduler.add_job(
        _trading_day_guard(nse_disclosures.run),
        CronTrigger(day_of_week="mon-fri", hour=20, minute=0, timezone=TZ),
        id="nse_disclosures",
        name="NSE Corporate Disclosures + LLM Scoring",
        misfire_grace_time=3600,
    )

    # 10. Sentiment engine blend — Mon–Fri at 9:00 PM IST (after all signals are in)
    scheduler.add_job(
        _trading_day_guard(sentiment_engine.run),
        CronTrigger(day_of_week="mon-fri", hour=21, minute=0, timezone=TZ),
        id="sentiment_engine",
        name="Sentiment Score Blending",
        misfire_grace_time=3600,
    )

    # 11. News Feed — every 15 min during market hours Mon–Fri
    scheduler.add_job(
        news_feed.run,
        CronTrigger(
            day_of_week="mon-fri",
            hour="9-16",
            minute="*/15",
            timezone=TZ,
        ),
        id="news_market_hours",
        name="News Feed (market hours)",
        misfire_grace_time=300,
    )

    # 12. News Feed — hourly off-hours and weekends (economy/policy news doesn't stop)
    scheduler.add_job(
        news_feed.run,
        CronTrigger(minute=0, timezone=TZ),   # top of every hour
        id="news_off_hours",
        name="News Feed (off-hours)",
        misfire_grace_time=600,
    )

    # 13. AMFI Portfolio Disclosures — monthly, 15th at 2 AM IST
    scheduler.add_job(
        amfi_portfolio.run,
        CronTrigger(day=15, hour=2, minute=0, timezone=TZ),
        id="amfi_portfolio",
        name="AMFI Portfolio Disclosure Ingestion",
        misfire_grace_time=7200,
    )

    # 14. Weekly AI Portfolio Digest — every Friday at 5 PM IST
    scheduler.add_job(
        digest_emailer.run,
        CronTrigger(day_of_week="fri", hour=17, minute=0, timezone=TZ),
        id="digest_weekly",
        name="Weekly AI Portfolio Digest",
        misfire_grace_time=3600,
    )

    # 15. Supabase keepalive — daily at noon IST
    #     Prevents free-tier project from pausing after 7 days of inactivity.
    scheduler.add_job(
        _supabase_keepalive,
        CronTrigger(hour=12, minute=0, timezone=TZ),
        id="supabase_keepalive",
        name="Supabase Keepalive Ping",
        misfire_grace_time=3600,
    )

    # 16. Price history retention — weekly, Sunday 4 AM IST (after industry job)
    #     Deletes stock_daily_prices rows older than 2 years to cap storage.
    scheduler.add_job(
        _price_retention_cleanup,
        CronTrigger(day_of_week="sun", hour=4, minute=0, timezone=TZ),
        id="price_retention",
        name="Stock Price 2-Year Retention Cleanup",
        misfire_grace_time=7200,
    )

    def _shutdown(sig, frame):
        log.info("Shutting down scheduler...")
        scheduler.shutdown(wait=False)
        sys.exit(0)

    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)

    log.info("Scheduler started. Jobs registered:")
    for job in scheduler.get_jobs():
        log.info("  %-40s next run: %s", job.name, job.next_run_time)

    scheduler.start()


if __name__ == "__main__":
    main()
