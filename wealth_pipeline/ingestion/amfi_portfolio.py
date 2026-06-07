"""
AMFI Portfolio Disclosure Ingestion
-------------------------------------
AMFI mandates that every mutual fund publish its complete portfolio on
its own website **and** on the AMFI portal monthly (typically by the
10th of the following month).

Data source
-----------
AMFI consolidates all fund portfolios into downloadable text files at:
  https://www.amfiindia.com/research-information/other-data/scheme-portfolio

Each file covers one AMC.  The format is a semicolon-separated text where
each fund's block looks like:

  Scheme Name: <name>
  ISIN: <isin>
  Date of Portfolio: <DD-Mon-YYYY>

  Company Name;ISIN Isin;Industry;Quantity (Nos);Market/Fair Value (Rs. in Lakhs);% to NAV
  Infosys Ltd.;INE009A01021;Information Technology;100000;15000.00;4.52

A blank line (or "##") separates funds.

Schedule: Monthly, on the 15th at 2 AM IST (data is usually available
by the 10th).

What we store
-------------
fund_portfolio_holdings — one row per (security_id, holding_isin, disclosure_date).
security_id references the MF's row in security_master.
"""

import re
import time
import requests
from datetime import date, datetime
from typing import Optional, List, Dict

from bs4 import BeautifulSoup
from psycopg2.extras import execute_values

from db.connection import get_connection
from utils.logger import get_logger

log = get_logger("amfi_portfolio")

# AMFI portfolio page — lists downloadable portfolio files by AMC
_PORTFOLIO_PAGE = "https://www.amfiindia.com/research-information/other-data/scheme-portfolio"
_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Referer": "https://www.amfiindia.com/",
}

# ── Text file parser ──────────────────────────────────────────────────────────

_RE_DATE  = re.compile(r"Date of Portfolio\s*[:\-]\s*(.+)", re.IGNORECASE)
_RE_ISIN  = re.compile(r"^ISIN\s*[:\-]\s*([A-Z0-9]{12})", re.IGNORECASE)
_RE_SCHEME= re.compile(r"^Scheme Name\s*[:\-]\s*(.+)", re.IGNORECASE)

def _parse_portfolio_text(text: str) -> list:
    """
    Parse an AMFI portfolio text blob.
    Returns list of dicts:
      { scheme_isin, disclosure_date, holdings: [{isin, name, industry, qty, mv_lacs, pct}] }
    """
    blocks = []
    current: Optional[dict] = None
    in_data = False

    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("##"):
            # block separator
            if current and current.get("holdings"):
                blocks.append(current)
            current = None
            in_data = False
            continue

        if _RE_SCHEME.match(line):
            if current and current.get("holdings"):
                blocks.append(current)
            current = {"scheme_isin": None, "disclosure_date": None, "holdings": []}
            in_data = False
            continue

        if current is None:
            continue

        m = _RE_ISIN.match(line)
        if m and current.get("scheme_isin") is None:
            current["scheme_isin"] = m.group(1).strip()
            continue

        m = _RE_DATE.match(line)
        if m:
            try:
                current["disclosure_date"] = datetime.strptime(
                    m.group(1).strip(), "%d-%b-%Y"
                ).date()
            except ValueError:
                pass
            continue

        # Header row detection
        low = line.lower()
        if "company name" in low and ("isin" in low or "% to nav" in low):
            in_data = True
            continue

        if in_data and ";" in line:
            parts = [p.strip() for p in line.split(";")]
            if len(parts) < 4:
                continue
            # Company Name ; ISIN ; Industry ; Quantity ; Market Value ; % to NAV
            name     = parts[0]
            isin     = parts[1] if len(parts[1]) == 12 else ""
            industry = parts[2] if len(parts) > 2 else ""
            qty      = _safe_int(parts[3] if len(parts) > 3 else "")
            mv_lacs  = _safe_float(parts[4] if len(parts) > 4 else "")
            pct      = _safe_float(parts[5] if len(parts) > 5 else (parts[4] if len(parts) > 4 else ""))

            # If ISIN column is missing, pct might be in position 3 or 4
            if not isin and pct == 0 and len(parts) >= 2:
                pct = _safe_float(parts[-1])

            if not name or (pct == 0 and mv_lacs == 0):
                continue

            current["holdings"].append({
                "isin":     isin,
                "name":     name[:255],
                "industry": industry[:128],
                "qty":      qty,
                "mv_lacs":  mv_lacs,
                "pct":      pct,
            })

    if current and current.get("holdings"):
        blocks.append(current)

    return blocks


def _safe_float(s: str) -> float:
    try:
        return float(str(s).replace(",", "").strip())
    except (ValueError, TypeError):
        return 0.0


def _safe_int(s: str) -> int:
    try:
        return int(str(s).replace(",", "").strip())
    except (ValueError, TypeError):
        return 0


# ── Download portfolio files from AMFI ───────────────────────────────────────

def _fetch_portfolio_urls(session: requests.Session) -> List[str]:
    """
    Scrape the AMFI portfolio page and return download URLs for all AMC text files.
    Falls back to a hardcoded pattern if scraping fails.
    """
    try:
        resp = session.get(_PORTFOLIO_PAGE, timeout=30)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "html.parser")
        urls = []
        for a in soup.find_all("a", href=True):
            href = a["href"]
            # AMFI portfolio links contain 'downloaddata' or '.txt' in various forms
            if any(kw in href.lower() for kw in ["downloaddata", "portfoliodata", "schemeportfolio"]):
                full = href if href.startswith("http") else f"https://www.amfiindia.com{href}"
                urls.append(full)
        log.info("Found %d portfolio file links on AMFI page", len(urls))
        return urls
    except Exception as exc:
        log.warning("Could not scrape AMFI portfolio page: %s", exc)
        return []


def _fetch_text(session: requests.Session, url: str) -> Optional[str]:
    """Download a portfolio text file."""
    try:
        r = session.get(url, timeout=60)
        r.raise_for_status()
        # Some files are UTF-8, some are latin-1
        try:
            return r.content.decode("utf-8")
        except UnicodeDecodeError:
            return r.content.decode("latin-1")
    except Exception as exc:
        log.warning("Failed to fetch %s: %s", url, exc)
        return None


# ── DB upsert ─────────────────────────────────────────────────────────────────

def _upsert_holdings(conn, security_id: int, holdings: list, disc_date: date):
    if not holdings:
        return 0
    rows = [
        (
            security_id,
            h["isin"] or "",
            h["name"],
            h["industry"] or None,
            h["qty"] or None,
            h["mv_lacs"] or None,
            h["pct"],
            disc_date,
        )
        for h in holdings
        if h["pct"] > 0 or h["mv_lacs"] > 0
    ]
    if not rows:
        return 0

    sql = """
        INSERT INTO fund_portfolio_holdings
            (security_id, holding_isin, holding_name, industry, quantity,
             market_value_lacs, pct_to_nav, disclosure_date)
        VALUES %s
        ON CONFLICT (security_id, holding_isin, disclosure_date)
        DO UPDATE SET
            holding_name       = EXCLUDED.holding_name,
            industry           = EXCLUDED.industry,
            quantity           = EXCLUDED.quantity,
            market_value_lacs  = EXCLUDED.market_value_lacs,
            pct_to_nav         = EXCLUDED.pct_to_nav
    """
    with conn.cursor() as cur:
        execute_values(cur, sql, rows)
    conn.commit()
    return len(rows)


def _security_id_for_isin(conn, isin: str) -> Optional[int]:
    """Look up security_master.id for a mutual fund by its ISIN (growth or div)."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT sm.id
            FROM mutual_fund_master mfm
            JOIN security_master sm ON sm.id = mfm.security_id
            WHERE mfm.isin_growth = %s OR mfm.isin_div_payout = %s
            LIMIT 1
            """,
            (isin, isin),
        )
        row = cur.fetchone()
        return row[0] if row else None


# ── Main ──────────────────────────────────────────────────────────────────────

def run():
    """
    Download and store AMFI mutual fund portfolio disclosures.

    Scrapes the AMFI portfolio page to find all AMC-level portfolio text file
    download links, downloads each file, parses fund-level holding blocks, and
    upserts into fund_portfolio_holdings keyed by (security_id, holding_isin,
    disclosure_date). Funds whose ISIN cannot be resolved via mutual_fund_master
    are skipped with a debug-level log. Called by the scheduler on the 15th of
    each month at 2:00 AM IST, after AMFI typically publishes month-end data.
    """
    log.info("=== AMFI Portfolio Disclosure Ingestion starting ===")
    session = requests.Session()
    session.headers.update(_HEADERS)

    urls = _fetch_portfolio_urls(session)
    if not urls:
        log.warning(
            "No portfolio URLs found from AMFI scrape. "
            "This may happen if AMFI restructured their page. "
            "Check %s manually and update _fetch_portfolio_urls().",
            _PORTFOLIO_PAGE,
        )
        return

    conn = get_connection()
    total_holdings = 0
    total_funds    = 0
    skipped        = 0

    for url in urls:
        log.info("Fetching: %s", url)
        text = _fetch_text(session, url)
        if not text:
            skipped += 1
            continue

        blocks = _parse_portfolio_text(text)
        log.info("  → Parsed %d fund blocks", len(blocks))

        for block in blocks:
            isin      = block.get("scheme_isin")
            disc_date = block.get("disclosure_date")
            holdings  = block.get("holdings", [])

            if not isin or not disc_date or not holdings:
                continue

            sec_id = _security_id_for_isin(conn, isin)
            if not sec_id:
                log.debug("No security_master entry for fund ISIN %s — skipping", isin)
                continue

            n = _upsert_holdings(conn, sec_id, holdings, disc_date)
            total_holdings += n
            total_funds    += 1

        time.sleep(1)   # be polite to AMFI servers

    conn.close()
    log.info(
        "=== Complete — funds=%d  holdings=%d  skipped_files=%d ===",
        total_funds, total_holdings, skipped,
    )


if __name__ == "__main__":
    run()
