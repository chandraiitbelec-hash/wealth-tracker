"""
AMFI NAV Ingestion
------------------
Fetches the daily NAV file from AMFI and writes to:
  - security_master      (anchor row per scheme)
  - mutual_fund_master   (rich static data — AMC, ISINs, category, plan, option)
  - daily_prices         (NAV per scheme per date)

Schedule: Daily at 11:00 PM IST (AMFI publishes between 9–11 PM).

AMFI file format (semicolon-separated):
  Category header lines:  "Open Ended Schemes(Equity Scheme - Large Cap Fund)"
  AMC header lines:       "Aditya Birla Sun Life Mutual Fund"
  Column header line:     "Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Net Asset Value;Date"
  Data rows:              "119551;INF209K01YK4;INF209K01YL2;Aditya Birla Sun Life ... - IDCW;26.58;04-Jun-2025"
"""

import re
import requests
from datetime import date
from utils.logger import get_logger
from db.connection import Database
from config import AMFI_NAV_URL

log = get_logger("amfi")

# ── Regex patterns for file structure detection ──────────────────────────────

# Category header: lines that start with "Open Ended" / "Close Ended" / "Interval"
_RE_CATEGORY = re.compile(
    r"^(Open Ended Schemes|Close Ended Schemes|Interval Fund)\s*\((.+)\)\s*$",
    re.IGNORECASE,
)

# AMC header: non-numeric lines with no semicolons that are not known headers
_KNOWN_SKIP_LINES = {
    "scheme code;isin div payout/ isin growth;isin div reinvestment;"
    "scheme name;net asset value;date",
}

# Plan detection patterns
_RE_DIRECT  = re.compile(r"\bdirect\b",  re.IGNORECASE)
_RE_REGULAR = re.compile(r"\bregular\b", re.IGNORECASE)

# Option detection patterns
_RE_GROWTH  = re.compile(r"\bgrowth\b",                  re.IGNORECASE)
_RE_IDCW    = re.compile(r"\b(idcw|dividend|div payout)\b", re.IGNORECASE)

# Scheme type from category header keyword
_RE_OPEN    = re.compile(r"open\s+ended",   re.IGNORECASE)
_RE_CLOSE   = re.compile(r"close\s+ended",  re.IGNORECASE)
_RE_INTERVAL= re.compile(r"interval",       re.IGNORECASE)


def _is_valid_isin(value: str) -> bool:
    return bool(value) and len(value) == 12 and value.startswith("IN")


def _infer_plan(scheme_name: str) -> str:
    if _RE_DIRECT.search(scheme_name):
        return "Direct"
    if _RE_REGULAR.search(scheme_name):
        return "Regular"
    return "Unknown"


def _infer_option(scheme_name: str) -> str:
    if _RE_IDCW.search(scheme_name):
        return "IDCW"
    if _RE_GROWTH.search(scheme_name):
        return "Growth"
    return "Unknown"


def _infer_scheme_type(category_line: str) -> str:
    if _RE_OPEN.search(category_line):
        return "Open-ended"
    if _RE_CLOSE.search(category_line):
        return "Close-ended"
    if _RE_INTERVAL.search(category_line):
        return "Interval"
    return "Unknown"


def _sanitize(value: str) -> str:
    return value.strip().replace("\xa0", " ").replace("​", "")


def fetch_raw_content() -> str:
    log.info("Fetching AMFI NAV file from %s", AMFI_NAV_URL)
    resp = requests.get(AMFI_NAV_URL, timeout=30)
    resp.raise_for_status()
    return resp.content.decode("utf-8", errors="replace")


def parse_amfi_nav(content: str, nav_date: date = None) -> list[dict]:
    """
    Parse the full AMFI NAV text file into a list of scheme dicts.
    Tracks state across lines to capture AMC name and scheme category.

    Returns list of dicts with:
        scheme_code, scheme_name, amc_name, scheme_category, scheme_type,
        plan, option, isin_col1, isin_col2, nav, nav_date
    """
    if nav_date is None:
        nav_date = date.today()

    records = []
    current_amc      = None
    current_category = None
    current_type     = "Unknown"

    for raw_line in content.splitlines():
        line = _sanitize(raw_line)

        if not line:
            continue

        # ── Category header ──────────────────────────────────────────
        cat_match = _RE_CATEGORY.match(line)
        if cat_match:
            current_category = cat_match.group(2).strip()
            current_type     = _infer_scheme_type(line)
            continue

        # ── Skip the column header row ────────────────────────────────
        if line.lower().replace(" ", "") in _KNOWN_SKIP_LINES:
            continue

        # ── Data row (contains semicolons) ────────────────────────────
        if ";" in line:
            tokens = [t.strip() for t in line.split(";")]
            if len(tokens) < 5:
                continue

            scheme_code = tokens[0]
            if not scheme_code.isdigit():
                continue  # still a header-ish line

            nav_str = tokens[4]
            try:
                nav_value = float(nav_str)
            except ValueError:
                continue  # "N.A." or blank — fund not valued yet

            isin_col1 = tokens[1]  # ISIN Div Payout / Growth
            isin_col2 = tokens[2]  # ISIN Div Reinvestment
            scheme_name = tokens[3]

            option = _infer_option(scheme_name)

            # Assign ISINs to the right semantic column
            if option == "IDCW":
                isin_div_payout       = isin_col1 if _is_valid_isin(isin_col1) else None
                isin_div_reinvestment = isin_col2 if _is_valid_isin(isin_col2) else None
                isin_growth           = None
            else:
                # Growth scheme — col1 is the growth ISIN, col2 is usually blank
                isin_growth           = isin_col1 if _is_valid_isin(isin_col1) else None
                isin_div_payout       = None
                isin_div_reinvestment = isin_col2 if _is_valid_isin(isin_col2) else None

            records.append(
                {
                    "scheme_code":           scheme_code,
                    "scheme_name":           scheme_name,
                    "amc_name":              current_amc,
                    "scheme_category":       current_category,
                    "scheme_type":           current_type,
                    "plan":                  _infer_plan(scheme_name),
                    "option":                option,
                    "isin_growth":           isin_growth,
                    "isin_div_payout":       isin_div_payout,
                    "isin_div_reinvestment": isin_div_reinvestment,
                    "nav":                   nav_value,
                    "nav_date":              nav_date,
                }
            )

        else:
            # ── AMC name line (no semicolons, not a category header) ──
            # Only update if it looks like an actual fund house name
            if len(line) > 5 and not line.startswith("//"):
                current_amc = line

    log.info("Parsed %d valid NAV records (%d AMCs)", len(records),
             len({r["amc_name"] for r in records}))
    return records


def run(nav_date: date = None):
    """Full ingestion: fetch → parse → upsert security_master + mf_master + daily_prices."""
    if nav_date is None:
        nav_date = date.today()

    content = fetch_raw_content()
    records = parse_amfi_nav(content, nav_date)

    if not records:
        log.warning("No AMFI records parsed — skipping DB write")
        return

    db = Database()
    try:
        # Step 1: bulk upsert all security_master rows in one shot
        log.info("Upserting %d rows into security_master...", len(records))
        security_tuples = [("MUTUAL_FUND", rec["scheme_code"]) for rec in records]
        code_to_id = db.bulk_upsert_securities(security_tuples)

        # Step 2: build master + price rows using the returned id map
        master_rows = []
        price_rows  = []
        for rec in records:
            sec_id = code_to_id.get(rec["scheme_code"])
            if sec_id is None:
                continue
            master_rows.append({**rec, "security_id": sec_id})
            price_rows.append((sec_id, rec["nav_date"], rec["nav"]))

        log.info("Writing to mutual_fund_master...")
        db.bulk_upsert_mf_master(master_rows)

        log.info("Writing to daily_prices...")
        db.bulk_insert_daily_prices(price_rows)

        log.info(
            "AMFI ingestion complete — %d schemes, %d prices written",
            len(master_rows), len(price_rows),
        )
    finally:
        db.close()


if __name__ == "__main__":
    run()
