"""
Scheduler
---------
Wires up all ingestion jobs using APScheduler (in-process cron).
Run this as a long-lived process: `python scheduler.py`

Jobs:
  1. AMFI NAV            — daily at 11:00 PM IST
  2. NSE EOD Bhavcopy    — Mon–Fri at 7:00 PM IST
  3. NSE Live Intraday   — Mon–Fri every 5 min, 9:15–3:30 IST
  4. Intraday cache clear— Mon–Fri at 9:15 AM IST
  5. NSE Equity Master   — weekly (Sunday 1:00 AM IST) — enriches company/sector data
"""

import signal
import sys
from apscheduler.schedulers.blocking import BlockingScheduler
from apscheduler.triggers.cron import CronTrigger

from ingestion import amfi, nse_eod, nse_live, nse_master, nse_sectors, nse_industry
from utils.logger import get_logger
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

    # 2. NSE EOD Bhavcopy — Mon–Fri 7 PM IST
    scheduler.add_job(
        nse_eod.run,
        CronTrigger(day_of_week="mon-fri", hour=NSE_EOD_CRON["hour"],
                    minute=NSE_EOD_CRON["minute"], timezone=TZ),
        id="nse_eod",
        name="NSE EOD Bhavcopy Ingestion",
        misfire_grace_time=3600,
    )

    # 3. NSE Intraday — every 5 min during market hours
    scheduler.add_job(
        nse_live.run,
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

    # 4. Clear intraday cache at market open
    scheduler.add_job(
        nse_live.clear_cache,
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
