"""
Weekly Portfolio Digest Generator
------------------------------------
Pulls the latest portfolio snapshot from the DB, diffs it against the
previous week's snapshot, then asks Claude to write a personalized
plain-English summary.

The generated text is returned as a dict:
  {
    "subject":      str,   # email subject line
    "html":         str,   # full HTML email body
    "plain":        str,   # plain-text fallback
    "user_id":      str,
    "snapshot_date":str,
  }

Called by digest/emailer.py → scheduled every Friday 5 PM IST.
"""

import json
import os
import textwrap
from datetime import date, timedelta
from typing import List, Optional

import anthropic

from db.connection import get_connection
from utils.logger import get_logger

log = get_logger("digest.generator")

_ANTHROPIC_CLIENT: Optional[anthropic.Anthropic] = None


def _get_client() -> anthropic.Anthropic:
    global _ANTHROPIC_CLIENT
    if _ANTHROPIC_CLIENT is None:
        api_key = os.getenv("ANTHROPIC_API_KEY")
        if not api_key:
            raise EnvironmentError(
                "ANTHROPIC_API_KEY is not set. "
                "Add it to .env to enable AI digest generation."
            )
        _ANTHROPIC_CLIENT = anthropic.Anthropic(api_key=api_key)
    return _ANTHROPIC_CLIENT


# ── DB helpers ────────────────────────────────────────────────────────────────

def _fetch_latest_snapshot(conn, user_id: str) -> Optional[dict]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT snapshot_date, total_value, stocks_value, mf_value,
                   total_invested, total_pnl, payload_json
            FROM portfolio_snapshots
            WHERE user_identifier = %s
            ORDER BY snapshot_date DESC
            LIMIT 1
            """,
            (user_id,),
        )
        row = cur.fetchone()
    if not row:
        return None
    return {
        "date":           str(row[0]),
        "total_value":    float(row[1] or 0),
        "stocks_value":   float(row[2] or 0),
        "mf_value":       float(row[3] or 0),
        "total_invested": float(row[4] or 0),
        "total_pnl":      float(row[5] or 0),
        "payload":        row[6] or {},
    }


def _fetch_snapshot_one_week_ago(conn, user_id: str, ref_date: date) -> Optional[dict]:
    cutoff = ref_date - timedelta(days=10)   # allow up to 10-day-old "last week" snapshot
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT snapshot_date, total_value, stocks_value, mf_value,
                   total_invested, total_pnl
            FROM portfolio_snapshots
            WHERE user_identifier = %s
              AND snapshot_date < %s
            ORDER BY snapshot_date DESC
            LIMIT 1
            """,
            (user_id, ref_date),
        )
        row = cur.fetchone()
    if not row:
        return None
    return {
        "date":         str(row[0]),
        "total_value":  float(row[1] or 0),
        "stocks_value": float(row[2] or 0),
        "mf_value":     float(row[3] or 0),
        "total_invested": float(row[4] or 0),
        "total_pnl":    float(row[5] or 0),
    }


def _fetch_all_users(conn) -> List[str]:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT DISTINCT user_identifier FROM portfolio_snapshots"
        )
        return [r[0] for r in cur.fetchall()]


# ── Number helpers ────────────────────────────────────────────────────────────

def _fmt_cr(v: float) -> str:
    """Format value in Crores / Lakhs."""
    abs_v = abs(v)
    if abs_v >= 1_00_00_000:
        return f"₹{abs_v/1_00_00_000:.2f} Cr"
    if abs_v >= 1_00_000:
        return f"₹{abs_v/1_00_000:.2f} L"
    return f"₹{abs_v:,.0f}"


def _pct(a: float, b: float) -> str:
    if b == 0:
        return "N/A"
    return f"{((a - b) / abs(b)) * 100:+.2f}%"


# ── Sector breakdown from payload ─────────────────────────────────────────────

def _top_sectors(payload: dict, n: int = 5) -> list[dict]:
    stocks = payload.get("stocks", [])
    sector_map: dict = {}
    for s in stocks:
        sec = s.get("sector") or "Unknown"
        sector_map[sec] = sector_map.get(sec, 0) + (s.get("closingValue") or 0)
    sorted_sectors = sorted(sector_map.items(), key=lambda x: -x[1])
    return [{"sector": k, "value": v} for k, v in sorted_sectors[:n] if k != "Unknown"]


def _elss_expiring_soon(payload: dict) -> list[str]:
    """Return ELSS fund names where 3-year lock-in expires within 90 days."""
    from datetime import datetime
    mf = payload.get("mutualFunds", [])
    expiring = []
    cutoff = date.today() + timedelta(days=90)
    for f in mf:
        if "elss" not in (f.get("category") or "").lower():
            continue
        purchase_str = f.get("purchaseDate") or f.get("startDate")
        if not purchase_str:
            continue
        try:
            purchase = date.fromisoformat(purchase_str[:10])
            lock_end = date(purchase.year + 3, purchase.month, purchase.day)
            if date.today() <= lock_end <= cutoff:
                expiring.append(f.get("schemeName", "ELSS Fund"))
        except (ValueError, TypeError):
            pass
    return expiring


# ── Claude prompt ─────────────────────────────────────────────────────────────

_SYSTEM_PROMPT = textwrap.dedent("""
    You are a friendly, knowledgeable Indian personal-finance assistant
    writing a weekly portfolio digest email for a retail investor.

    Tone: warm, direct, easy to understand — like a trusted CA friend,
    not a robot. Use ₹ for amounts. Keep it concise: 3–5 short paragraphs.

    Do NOT recommend specific buy/sell actions. Do NOT give legal or tax advice.
    Highlight notable changes, positive trends, and things to keep an eye on.
    End with one actionable nudge (e.g., "consider rebalancing X" or
    "your ELSS lock-in on Y ends soon — you can redeem after Z").
""").strip()


def _build_user_message(current: dict, previous: Optional[dict]) -> str:
    payload = current.get("payload") or {}

    delta_value  = current["total_value"] - (previous["total_value"] if previous else current["total_value"])
    delta_pct    = _pct(current["total_value"], previous["total_value"]) if previous else "N/A"
    delta_stocks = current["stocks_value"] - (previous["stocks_value"] if previous else current["stocks_value"])
    delta_mf     = current["mf_value"]    - (previous["mf_value"]     if previous else current["mf_value"])

    top_sectors = _top_sectors(payload)
    elss_expiring = _elss_expiring_soon(payload)

    # Top 3 stocks by unrealised P&L
    stocks = payload.get("stocks", [])
    top_gainers = sorted(stocks, key=lambda s: -(s.get("pnlPercent") or 0))[:3]
    top_losers  = sorted(stocks, key=lambda s: (s.get("pnlPercent") or 0))[:3]

    # Underperforming MFs
    mf = payload.get("mutualFunds", [])
    low_mf = [f for f in mf if (f.get("returns") or 0) < -5]

    lines = [
        f"Portfolio date: {current['date']}",
        f"Total portfolio value: {_fmt_cr(current['total_value'])}",
        f"  • Direct equity: {_fmt_cr(current['stocks_value'])}",
        f"  • Mutual funds: {_fmt_cr(current['mf_value'])}",
        f"Total invested: {_fmt_cr(current['total_invested'])}",
        f"Total unrealised P&L: {_fmt_cr(current['total_pnl'])}",
    ]

    if previous:
        lines += [
            "",
            f"Change vs {previous['date']}:",
            f"  • Portfolio value: {_fmt_cr(delta_value)} ({delta_pct})",
            f"  • Stocks: {_fmt_cr(delta_stocks)}",
            f"  • MFs: {_fmt_cr(delta_mf)}",
        ]

    if top_sectors:
        lines.append("\nTop equity sectors:")
        for s in top_sectors:
            lines.append(f"  • {s['sector']}: {_fmt_cr(s['value'])}")

    if top_gainers:
        lines.append("\nBiggest stock winners (by %):")
        for s in top_gainers:
            name = s.get("companyName") or s.get("stockName", "")
            pct  = s.get("pnlPercent", 0)
            lines.append(f"  • {name}: {pct:+.1f}%")

    if top_losers and top_losers[0].get("pnlPercent", 0) < 0:
        lines.append("\nStocks to watch (largest drawdowns):")
        for s in top_losers:
            if (s.get("pnlPercent") or 0) >= 0:
                break
            name = s.get("companyName") or s.get("stockName", "")
            pct  = s.get("pnlPercent", 0)
            lines.append(f"  • {name}: {pct:+.1f}%")

    if low_mf:
        lines.append("\nMFs with negative returns (> -5%):")
        for f in low_mf:
            lines.append(f"  • {f.get('schemeName', '')}: {f.get('returns', 0):+.1f}%")

    if elss_expiring:
        lines.append("\nELSS lock-ins expiring within 90 days:")
        for name in elss_expiring:
            lines.append(f"  • {name}")

    return "\n".join(lines)


# ── Main public function ──────────────────────────────────────────────────────

def generate_digest_for_user(user_id: str, conn=None) -> Optional[dict]:
    """
    Generate a digest dict for a single user.
    Returns None if no snapshot exists.
    """
    own_conn = conn is None
    if own_conn:
        conn = get_connection()

    try:
        current  = _fetch_latest_snapshot(conn, user_id)
        if not current:
            log.info("No snapshot found for user %s — skipping", user_id)
            return None

        snap_date = date.fromisoformat(current["date"])
        previous  = _fetch_snapshot_one_week_ago(conn, user_id, snap_date)

        user_msg = _build_user_message(current, previous)
        log.debug("Prompt for %s:\n%s", user_id, user_msg)

        client = _get_client()
        # Claude Opus is used here instead of Haiku because the digest email
        # is a high-stakes, user-facing piece of writing that synthesises
        # numerical data, narrative context, and personalised recommendations.
        # The quality gap between Opus and Haiku is most visible on tasks that
        # require holding many facts in context simultaneously and producing
        # fluent, non-repetitive prose — exactly what a good digest demands.
        # The weekly cadence (once per user per week) means API cost is minimal.
        resp = client.messages.create(
            model="claude-opus-4-5",
            max_tokens=1024,
            system=_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_msg}],
        )
        plain_text = resp.content[0].text.strip()

        # Wrap in simple HTML
        paragraphs = plain_text.split("\n\n")
        html_body  = "\n".join(f"<p>{p.replace(chr(10), '<br>')}</p>" for p in paragraphs)
        html = f"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
body{{font-family:sans-serif;max-width:600px;margin:auto;color:#333;line-height:1.6}}
h1{{color:#4f46e5;font-size:1.1rem}}
.footer{{font-size:0.75rem;color:#aaa;margin-top:2rem;border-top:1px solid #eee;padding-top:1rem}}
</style></head>
<body>
<h1>📊 Your Weekly Portfolio Digest — {current['date']}</h1>
{html_body}
<div class="footer">
Generated by Wealth Tracker · <a href="#">Unsubscribe</a>
</div>
</body>
</html>"""

        subject = f"Your portfolio {_pct(current['total_value'], previous['total_value']) if previous else ''} this week — {current['date']}"

        return {
            "user_id":       user_id,
            "snapshot_date": current["date"],
            "subject":       subject.strip(),
            "html":          html,
            "plain":         plain_text,
        }

    finally:
        if own_conn:
            conn.close()


def run_all(dry_run: bool = False):
    """
    Generate weekly portfolio digests for every user with a portfolio snapshot.

    Fetches the distinct list of user_identifiers from portfolio_snapshots, then
    calls generate_digest_for_user() for each one, diff-ing against the previous
    week's snapshot. Returns a list of digest dicts (with keys: user_id,
    snapshot_date, subject, html, plain). If `dry_run` is True, the generated
    plain text is printed to logs instead of being emailed. Called by
    digest/emailer.py → scheduled every Friday at 5:00 PM IST.
    """
    conn = get_connection()
    try:
        user_ids = _fetch_all_users(conn)
        log.info("Generating digests for %d users", len(user_ids))
        results = []
        for uid in user_ids:
            try:
                digest = generate_digest_for_user(uid, conn=conn)
                if digest:
                    results.append(digest)
                    if dry_run:
                        log.info("=== DRY RUN digest for %s ===\n%s", uid, digest["plain"])
            except Exception as exc:
                log.error("Digest failed for user %s: %s", uid, exc)
        return results
    finally:
        conn.close()
