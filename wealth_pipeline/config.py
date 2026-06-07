import os
from dotenv import load_dotenv

load_dotenv()

# Database
DB_CONFIG = {
    "host": os.getenv("DB_HOST", "localhost"),
    "port": int(os.getenv("DB_PORT", 5432)),
    "dbname": os.getenv("DB_NAME", "wealth_db"),
    "user": os.getenv("DB_USER", "postgres"),
    "password": os.getenv("DB_PASSWORD", ""),
}

# AMFI
AMFI_NAV_URL = "https://portal.amfiindia.com/spages/NAVAll.txt"

# NSE EOD Bhavcopy
NSE_BHAVCOPY_URL_TEMPLATE = (
    "https://nsearchives.nseindia.com/content/cm/"
    "BhavCopy_NSE_CM_0_0_0_{date_str}_F_0000.csv.zip"
)

# NSE Live snapshot (public delayed feed)
NSE_LIVE_URL = "https://www.nseindia.com/api/equity-stockIndices?index=SECURITIES%20IN%20F%26O"

# NSE session bootstrap (needed to get cookies)
NSE_HOME_URL = "https://www.nseindia.com"

# NSE equity series to keep (filter out derivatives/debt)
NSE_EQUITY_SERIES = {"EQ", "BE"}

# Market hours (IST)
MARKET_OPEN_HOUR = 9
MARKET_OPEN_MINUTE = 15
MARKET_CLOSE_HOUR = 15
MARKET_CLOSE_MINUTE = 30

# Schedules (all times IST / Asia/Kolkata)
AMFI_CRON = {"hour": 23, "minute": 0}         # 11:00 PM IST daily
NSE_EOD_CRON = {"hour": 19, "minute": 0}       # 7:00 PM IST daily
NSE_LIVE_INTERVAL_MINUTES = 5                   # every 5 mins during market hours

# HTTP headers to mimic browser (NSE blocks plain requests)
NSE_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-GB,en-US;q=0.9,en;q=0.8",
    "Referer": "https://www.nseindia.com/",
}
