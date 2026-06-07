"""
Sentiment Engine — Score Blending & Signal Generation
------------------------------------------------------
Pulls raw data from the four sub-signal tables, normalises each to
a [-5, +5] integer, applies weights, then writes a blended score and
a human-readable signal to stock_sentiment_indicators.

Sub-signals and weights:
  A. Delivery momentum (delivery % trend)        30 %
  B. LLM-parsed corporate disclosures            30 %
  C. Institutional (MF) ownership momentum       25 %
  D. Derivatives skew (PCR + IV skew)            15 %

Signal classification (blended score thresholds):
  +2.5 … +5.0  → ACCUMULATION  (smart money quietly building positions)
  -2.5 … +2.5  → NEUTRAL
  -5.0 … -2.5  → DISTRIBUTION  (smart money exiting into retail euphoria)
  Special case: low delivery% + high PCR          → FROTH

Run: nightly at 9:00 PM IST (after disclosures and alternative_data jobs).

Signal C (institutional momentum) uses the fund_portfolio_holdings table
that amfi_portfolio.py populates monthly — computed as MoM % change in
aggregate shares held across all MFs.
"""

from __future__ import annotations  # enables PEP 604 union syntax on Python 3.9

import math
from datetime import date, timedelta
from typing import Optional

from db.connection import get_connection
from utils.logger import get_logger

log = get_logger("sentiment_engine")

# Weights (must sum to 1.0)
W_DELIVERY      = 0.30
W_DISCLOSURE    = 0.30
W_INSTITUTIONAL = 0.25
W_DERIVATIVES   = 0.15

# Thresholds for signal classification
ACCUMULATION_THRESHOLD  =  2.5
DISTRIBUTION_THRESHOLD  = -2.5
FROTH_DELIVERY_CEILING  = 35.0   # delivery% below this = frothy
FROTH_PCR_FLOOR         =  1.2   # PCR above this = bearish options positioning


# ── Bulk data loaders ─────────────────────────────────────────────────────────
#
# Instead of querying the DB once per symbol per signal (N×4 round trips for
# N symbols), we load all signal data for every symbol in 4 bulk queries, then
# compute in memory. For 2,000 symbols this cuts DB round trips from ~8,000 to 4.

def _load_all_delivery(conn) -> Dict[str, list]:
    """
    Returns {symbol: [delivery_pct, ...]} sorted newest-first, last 30 days.
    """
    cutoff = date.today() - timedelta(days=30)
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT symbol, delivery_pct
            FROM stock_delivery_stats
            WHERE trade_date >= %s
            ORDER BY symbol, trade_date DESC
            """,
            (cutoff,),
        )
        rows = cur.fetchall()
    result: Dict[str, list] = {}
    for symbol, pct in rows:
        if pct is not None:
            result.setdefault(symbol, []).append(float(pct))
    return result


def _load_all_disclosures(conn) -> Dict[str, list]:
    """
    Returns {symbol: [(subject, llm_score), ...]} newest 3 per symbol.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT DISTINCT ON (symbol, disclosed_at) symbol, subject, llm_score
            FROM corporate_disclosures
            WHERE llm_score IS NOT NULL
            ORDER BY symbol, disclosed_at DESC
            """
        )
        rows = cur.fetchall()
    result: Dict[str, list] = {}
    for symbol, subject, score in rows:
        bucket = result.setdefault(symbol, [])
        if len(bucket) < 3:
            bucket.append((subject, int(score)))
    return result


def _load_all_institutional(conn) -> Dict[str, float]:
    """
    Returns {symbol: mf_shares_change_pct} by comparing the two most recent
    AMFI disclosure dates across all funds.
    """
    with conn.cursor() as cur:
        # Get the two latest global disclosure dates (AMFI discloses all funds at once)
        cur.execute(
            """
            SELECT DISTINCT disclosure_date
            FROM fund_portfolio_holdings
            ORDER BY disclosure_date DESC
            LIMIT 2
            """
        )
        dates = [r[0] for r in cur.fetchall()]

    if len(dates) < 2:
        return {}

    latest_date, prev_date = dates[0], dates[1]

    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT em.symbol,
                   SUM(CASE WHEN fph.disclosure_date = %s THEN fph.quantity ELSE 0 END) AS latest_qty,
                   SUM(CASE WHEN fph.disclosure_date = %s THEN fph.quantity ELSE 0 END) AS prev_qty
            FROM fund_portfolio_holdings fph
            JOIN equity_master em ON em.isin = fph.holding_isin
            WHERE fph.disclosure_date IN (%s, %s)
              AND em.symbol IS NOT NULL
            GROUP BY em.symbol
            """,
            (latest_date, prev_date, latest_date, prev_date),
        )
        rows = cur.fetchall()

    result: Dict[str, float] = {}
    for symbol, latest_qty, prev_qty in rows:
        if prev_qty and float(prev_qty) > 0:
            change_pct = ((float(latest_qty) - float(prev_qty)) / float(prev_qty)) * 100
            result[symbol] = round(change_pct, 4)
    return result


def _load_all_derivatives(conn) -> Dict[str, tuple]:
    """
    Returns {symbol: (pcr, iv_skew)} from the most recent options snapshot.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT DISTINCT ON (symbol) symbol, pcr, iv_skew
            FROM stock_options_data
            ORDER BY symbol, snapshot_date DESC
            """
        )
        rows = cur.fetchall()
    return {
        r[0]: (float(r[1]) if r[1] else None, float(r[2]) if r[2] else None)
        for r in rows
    }


# ── Sub-signal scorers (pure functions — operate on pre-loaded data) ───────────
#
# These no longer touch the DB. They receive the symbol's slice of the bulk data
# and return a score + metadata. This makes them trivially testable too.

def _delivery_score_from_data(pcts: list) -> tuple:
    """Returns (score, pct_5d, pct_20d, trend) given a list of delivery%s newest-first."""
    if not pcts or len(pcts) < 3:
        return 0, pcts[0] if pcts else 0.0, 0.0, "NEUTRAL"

    pct_5d  = sum(pcts[:5])  / min(5,  len(pcts[:5]))
    pct_20d = sum(pcts[:20]) / min(20, len(pcts[:20]))

    diff = pct_5d - pct_20d
    if diff >= 5:
        score, trend = 3, "RISING"
    elif diff <= -5:
        score, trend = -3, "FALLING"
    else:
        # Absolute level: delivery_pct 20..80 → score -2..+2, 50% baseline → 0
        clamped = max(20.0, min(80.0, pct_5d))
        score   = round((clamped - 50) / 15)
        trend   = "NEUTRAL"

    return int(max(-5, min(5, score))), round(pct_5d, 2), round(pct_20d, 2), trend


def _disclosure_score_from_data(entries: list) -> tuple:
    """
    Returns (score, latest_subject, latest_score) given a list of
    (subject, llm_score) tuples newest-first (max 3).
    Recency-weighted: most recent gets weight 3, next 2, oldest 1.
    """
    if not entries:
        return 0, None, None

    weights = [3, 2, 1]
    weighted_sum  = sum(float(s) * weights[i] for i, (_, s) in enumerate(entries))
    total_weights = sum(weights[:len(entries)])
    score = round(weighted_sum / total_weights) if total_weights else 0

    return int(max(-5, min(5, score))), entries[0][0], entries[0][1]


def _institutional_score_from_data(change_pct: Optional[float]) -> tuple:
    """Returns (score, change_pct) given the MoM% change in aggregate MF holdings."""
    if change_pct is None:
        return 0, 0.0
    if change_pct >= 5:
        score = 5
    elif change_pct >= 2:
        score = 3
    elif change_pct >= 0.5:
        score = 1
    elif change_pct >= -0.5:
        score = 0
    elif change_pct >= -2:
        score = -1
    elif change_pct >= -5:
        score = -3
    else:
        score = -5
    return score, change_pct


def _derivatives_score_from_data(pcr: Optional[float], iv_skew: Optional[float]) -> tuple:
    """Returns (score, pcr, iv_skew) from raw options data."""
    # PCR score: 0.5 → +4, 1.0 → 0, 1.5 → -4 (low PCR = bullish, high = bearish)
    pcr_score  = round(-4 * math.tanh((pcr   - 0.9) * 2.5)) if pcr   is not None else 0
    # IV skew: large positive (puts more expensive than calls) → bearish
    skew_score = round(-3 * math.tanh(iv_skew / 5))          if iv_skew is not None else 0
    score = int(max(-5, min(5, round((pcr_score + skew_score) / 2))))
    return score, pcr, iv_skew


# ── Signal classifier ─────────────────────────────────────────────────────────

def _classify_signal(
    blended: float,
    delivery_pct_5d: float,
    pcr: Optional[float],
    mf_change_pct: float,
) -> tuple[str, str]:
    """
    Return (signal, reason) human-readable label.

    FROTH: High noise (low delivery) + bearish derivatives.
    ACCUMULATION: Smart money quietly building (high delivery + positive institutional).
    DISTRIBUTION: Smart money exiting into retail enthusiasm.
    NEUTRAL: No clear directional signal.
    """
    froth = (
        delivery_pct_5d < FROTH_DELIVERY_CEILING and
        pcr is not None and pcr > FROTH_PCR_FLOOR
    )
    if froth:
        return "FROTH", (
            f"Low delivery ({delivery_pct_5d:.1f}%) suggests speculative trading, "
            f"while options PCR {pcr:.2f} signals bearish hedging. "
            "Retail momentum diverges from institutional positioning."
        )

    if blended >= ACCUMULATION_THRESHOLD:
        reason_parts = []
        if mf_change_pct > 0.5:
            reason_parts.append(f"MF aggregate holdings up {mf_change_pct:+.1f}% MoM")
        if delivery_pct_5d > 50:
            reason_parts.append(f"delivery {delivery_pct_5d:.1f}% above average")
        reason = ". ".join(reason_parts) or "Multiple indicators point to institutional accumulation."
        return "ACCUMULATION", reason

    if blended <= DISTRIBUTION_THRESHOLD:
        reason_parts = []
        if mf_change_pct < -0.5:
            reason_parts.append(f"MF aggregate holdings down {abs(mf_change_pct):.1f}% MoM")
        if delivery_pct_5d < 30:
            reason_parts.append(f"low delivery {delivery_pct_5d:.1f}% suggests distribution")
        reason = ". ".join(reason_parts) or "Multiple indicators suggest distribution into retail buyers."
        return "DISTRIBUTION", reason

    return "NEUTRAL", "No significant divergence between sub-signals."


# ── Batch upsert blended scores ───────────────────────────────────────────────

def _batch_upsert_indicators(conn, rows: List[dict]):
    """
    Write all computed sentiment rows in a single transaction.

    Using execute_values with a named-column approach: we pass tuples in a
    fixed column order matching the INSERT, then reference them positionally.
    This replaces the previous pattern of one `conn.commit()` per symbol,
    cutting write round trips from N to 1.
    """
    if not rows:
        return

    from psycopg2.extras import execute_values

    tuples = [
        (
            r["symbol"],       r["del_score"],        r["disc_score"],
            r["inst_score"],   r["deriv_score"],       r["blended"],
            r["pct_5d"],       r["pct_20d"],           r["trend"],
            r["mf_change"],    r["pcr"],               r["iv_skew"],
            r["disc_subject"], r["disc_latest_score"], r["signal"],
            r["signal_reason"],
        )
        for r in rows
    ]

    sql = """
        INSERT INTO stock_sentiment_indicators (
            symbol, delivery_score, disclosure_score,
            institutional_score, derivatives_score,
            blended_score, delivery_pct_5d, delivery_pct_20d,
            delivery_trend, mf_shares_change_pct,
            pcr, iv_skew,
            latest_disclosure_subject, latest_disclosure_score,
            signal, signal_reason, updated_at
        ) VALUES %s
        ON CONFLICT (symbol) DO UPDATE SET
            delivery_score            = EXCLUDED.delivery_score,
            disclosure_score          = EXCLUDED.disclosure_score,
            institutional_score       = EXCLUDED.institutional_score,
            derivatives_score         = EXCLUDED.derivatives_score,
            blended_score             = EXCLUDED.blended_score,
            delivery_pct_5d           = EXCLUDED.delivery_pct_5d,
            delivery_pct_20d          = EXCLUDED.delivery_pct_20d,
            delivery_trend            = EXCLUDED.delivery_trend,
            mf_shares_change_pct      = EXCLUDED.mf_shares_change_pct,
            pcr                       = EXCLUDED.pcr,
            iv_skew                   = EXCLUDED.iv_skew,
            latest_disclosure_subject = EXCLUDED.latest_disclosure_subject,
            latest_disclosure_score   = EXCLUDED.latest_disclosure_score,
            signal                    = EXCLUDED.signal,
            signal_reason             = EXCLUDED.signal_reason,
            updated_at                = NOW()
    """
    template = (
        "(%s,%s,%s, %s,%s, %s,%s,%s, %s,%s, %s,%s, %s,%s, %s,%s, NOW())"
    )
    with conn.cursor() as cur:
        execute_values(cur, sql, tuples, template=template)
    conn.commit()


# ── Per-symbol compute ────────────────────────────────────────────────────────

def compute_for_symbol(
    symbol: str,
    delivery_data: Dict,
    disclosure_data: Dict,
    institutional_data: Dict,
    derivatives_data: Dict,
) -> Optional[dict]:
    """
    Compute blended sentiment for one symbol from pre-loaded bulk data.
    All four data dicts are keyed by symbol and populated by the load_all_*
    functions above — no DB access happens here.
    """
    del_score,  pct_5d, pct_20d, trend = _delivery_score_from_data(
        delivery_data.get(symbol, [])
    )
    disc_score, disc_subj, disc_latest = _disclosure_score_from_data(
        disclosure_data.get(symbol, [])
    )
    inst_score, mf_change = _institutional_score_from_data(
        institutional_data.get(symbol)
    )
    deriv_score, pcr, iv_skew = _derivatives_score_from_data(
        *derivatives_data.get(symbol, (None, None))
    )

    # ── Weighted blend ────────────────────────────────────────────────────────
    # Weight rationale:
    #   Delivery (30%) and Disclosures (30%) are the most direct and timely
    #   signals: delivery% is a real-time NSE data point, and filings are
    #   legally mandated before any press release. Together they form the core.
    #
    #   Institutional flow (25%) is a strong but lagged signal — AMFI data
    #   is monthly, so it reflects conviction from the previous period. It
    #   acts as a medium-term confirmer rather than a trigger.
    #
    #   Derivatives (15%) carries the smallest weight because PCR and IV skew
    #   are noisy (dominated by hedging activity) and can diverge from the
    #   underlying direction for extended periods. Useful as a warning signal
    #   but not reliable enough to dominate the blend.
    blended = (
        del_score   * W_DELIVERY +
        disc_score  * W_DISCLOSURE +
        inst_score  * W_INSTITUTIONAL +
        deriv_score * W_DERIVATIVES
    )
    blended = round(max(-5.0, min(5.0, blended)), 2)

    signal, signal_reason = _classify_signal(blended, pct_5d, pcr, mf_change)

    return {
        "symbol":            symbol,
        "del_score":         del_score,
        "disc_score":        disc_score,
        "inst_score":        inst_score,
        "deriv_score":       deriv_score,
        "blended":           blended,
        "pct_5d":            pct_5d,
        "pct_20d":           pct_20d,
        "trend":             trend,
        "mf_change":         mf_change,
        "pcr":               pcr,
        "iv_skew":           iv_skew,
        "disc_subject":      disc_subj,
        "disc_latest_score": disc_latest,
        "signal":            signal,
        "signal_reason":     signal_reason,
    }


# ── Main ──────────────────────────────────────────────────────────────────────

def run():
    """
    Compute and store blended sentiment scores for all equity symbols.

    For each symbol in equity_master, calls compute_for_symbol() to pull the
    four sub-signals (delivery momentum, disclosure sentiment, institutional
    flow, derivatives skew), applies the weighted blend, and classifies the
    result into ACCUMULATION / NEUTRAL / DISTRIBUTION / FROTH. Symbols where
    all four sub-signals are zero (no data yet) are silently skipped. Results
    are upserted into stock_sentiment_indicators and read by the web app's
    /api/asset/stock/[symbol] route. Called by the scheduler every Mon–Fri at
    9:00 PM IST, after all upstream ingestion jobs have completed.
    """
    log.info("=== Sentiment Engine starting ===")
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT DISTINCT symbol FROM equity_master WHERE symbol IS NOT NULL")
            symbols = [r[0] for r in cur.fetchall()]

        log.info("Loading signal data for %d symbols (4 bulk queries)", len(symbols))

        # Bulk-load all four signal tables in 4 round trips (vs N×4 previously)
        delivery_data     = _load_all_delivery(conn)
        disclosure_data   = _load_all_disclosures(conn)
        institutional_data = _load_all_institutional(conn)
        derivatives_data  = _load_all_derivatives(conn)

        # Compute all scores in memory — pure functions, no DB access
        log.info("Computing blended sentiment scores in memory")
        to_write: List[dict] = []
        skip = 0

        for symbol in symbols:
            row = compute_for_symbol(
                symbol,
                delivery_data,
                disclosure_data,
                institutional_data,
                derivatives_data,
            )
            if row is None or all(
                v == 0 for v in [row["del_score"], row["disc_score"],
                                  row["inst_score"], row["deriv_score"]]
            ):
                skip += 1
                continue
            to_write.append(row)

        # Single batch write — 1 round trip instead of len(to_write)
        _batch_upsert_indicators(conn, to_write)
        log.info("=== Complete — written=%d  skipped=%d ===", len(to_write), skip)
    finally:
        conn.close()


if __name__ == "__main__":
    run()
