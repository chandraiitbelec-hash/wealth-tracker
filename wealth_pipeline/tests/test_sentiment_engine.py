"""
Unit tests for sentiment_engine.py — pure scoring functions only.

All functions under test accept pre-loaded data dicts (no DB access),
so we test them directly without any mocking.
"""

import math
import pytest
from sentiment_engine import (
    _delivery_score_from_data,
    _disclosure_score_from_data,
    _institutional_score_from_data,
    _derivatives_score_from_data,
    _classify_signal,
    compute_for_symbol,
    ACCUMULATION_THRESHOLD,
    DISTRIBUTION_THRESHOLD,
    FROTH_DELIVERY_CEILING,
    FROTH_PCR_FLOOR,
)


# ══════════════════════════════════════════════════════════════════════════════
# Sub-signal A: Delivery score
# ══════════════════════════════════════════════════════════════════════════════

class TestDeliveryScore:

    def test_empty_data_returns_neutral_zero(self):
        score, p5, p20, trend = _delivery_score_from_data([])
        assert score == 0
        assert trend == "NEUTRAL"

    def test_too_few_points_returns_neutral(self):
        score, p5, p20, trend = _delivery_score_from_data([55.0, 60.0])
        assert score == 0
        assert trend == "NEUTRAL"

    def test_rising_trend_gives_positive_score(self):
        # Recent days much higher than rolling avg → RISING
        pcts = [80, 82, 78, 40, 38, 36, 35, 34, 33, 32]
        score, p5, p20, trend = _delivery_score_from_data(pcts)
        assert score > 0
        assert trend == "RISING"

    def test_falling_trend_gives_negative_score(self):
        # Recent days much lower than rolling avg → FALLING
        pcts = [20, 18, 22, 70, 72, 68, 71, 69, 73, 74]
        score, p5, p20, trend = _delivery_score_from_data(pcts)
        assert score < 0
        assert trend == "FALLING"

    def test_stable_high_delivery_is_mildly_positive(self):
        # Stable 70% delivery, no sharp trend → neutral-to-positive
        pcts = [70.0] * 20
        score, p5, p20, trend = _delivery_score_from_data(pcts)
        assert score >= 0
        assert trend == "NEUTRAL"

    def test_score_clamped_to_minus5_plus5(self):
        # Extreme values shouldn't escape the range
        pcts = [100.0] * 20
        score, *_ = _delivery_score_from_data(pcts)
        assert -5 <= score <= 5

        pcts = [0.0] * 20
        score, *_ = _delivery_score_from_data(pcts)
        assert -5 <= score <= 5


# ══════════════════════════════════════════════════════════════════════════════
# Sub-signal B: Disclosure score
# ══════════════════════════════════════════════════════════════════════════════

class TestDisclosureScore:

    def test_empty_returns_zero_and_nones(self):
        score, subject, latest = _disclosure_score_from_data([])
        assert score == 0
        assert subject is None
        assert latest is None

    def test_single_positive_disclosure(self):
        score, subject, latest = _disclosure_score_from_data([("Buyback announced", 4)])
        assert score == 4
        assert subject == "Buyback announced"
        assert latest == 4

    def test_recency_weighting_favours_latest(self):
        # Latest +5, previous -5, oldest -5 → should be net positive
        entries = [("Good news", 5), ("Bad news", -5), ("Bad news", -5)]
        score, _, _ = _disclosure_score_from_data(entries)
        # weights 3,2,1 → (5×3 + -5×2 + -5×1) / 6 = (15-10-5)/6 = 0
        assert score == 0

    def test_all_positive_disclosures(self):
        entries = [("A", 4), ("B", 3), ("C", 5)]
        score, _, _ = _disclosure_score_from_data(entries)
        assert score > 0

    def test_all_negative_disclosures(self):
        entries = [("A", -4), ("B", -3), ("C", -5)]
        score, _, _ = _disclosure_score_from_data(entries)
        assert score < 0

    def test_score_clamped(self):
        entries = [("X", 5), ("Y", 5), ("Z", 5)]
        score, _, _ = _disclosure_score_from_data(entries)
        assert score <= 5


# ══════════════════════════════════════════════════════════════════════════════
# Sub-signal C: Institutional score
# ══════════════════════════════════════════════════════════════════════════════

class TestInstitutionalScore:

    def test_none_returns_zero(self):
        score, pct = _institutional_score_from_data(None)
        assert score == 0
        assert pct == 0.0

    def test_large_increase_gives_max_score(self):
        score, _ = _institutional_score_from_data(10.0)
        assert score == 5

    def test_moderate_increase_gives_positive(self):
        score, _ = _institutional_score_from_data(3.0)
        assert score == 3

    def test_small_increase_gives_one(self):
        score, _ = _institutional_score_from_data(1.0)
        assert score == 1

    def test_flat_gives_zero(self):
        score, _ = _institutional_score_from_data(0.0)
        assert score == 0

    def test_large_decrease_gives_minus5(self):
        score, _ = _institutional_score_from_data(-10.0)
        assert score == -5

    def test_boundary_values(self):
        # Exact boundary values
        assert _institutional_score_from_data(5.0)[0] == 5
        assert _institutional_score_from_data(2.0)[0] == 3
        assert _institutional_score_from_data(-2.0)[0] == -1
        assert _institutional_score_from_data(-5.0)[0] == -3


# ══════════════════════════════════════════════════════════════════════════════
# Sub-signal D: Derivatives score
# ══════════════════════════════════════════════════════════════════════════════

class TestDerivativesScore:

    def test_no_data_returns_zero(self):
        score, pcr, iv = _derivatives_score_from_data(None, None)
        assert score == 0
        assert pcr is None
        assert iv is None

    def test_low_pcr_and_negative_skew_is_bullish(self):
        # Low PCR (0.5) → calls dominating → bullish
        # Negative IV skew → calls more expensive → bullish
        score, _, _ = _derivatives_score_from_data(0.5, -5.0)
        assert score > 0

    def test_high_pcr_and_positive_skew_is_bearish(self):
        # High PCR (1.5) → puts dominating → bearish
        # Positive IV skew → puts more expensive → bearish
        score, _, _ = _derivatives_score_from_data(1.5, 5.0)
        assert score < 0

    def test_neutral_pcr_near_zero_score(self):
        # PCR ~0.9 is the neutral midpoint
        score, _, _ = _derivatives_score_from_data(0.9, 0.0)
        assert score == 0

    def test_score_clamped(self):
        score, _, _ = _derivatives_score_from_data(0.1, -20.0)
        assert -5 <= score <= 5
        score, _, _ = _derivatives_score_from_data(3.0, 20.0)
        assert -5 <= score <= 5


# ══════════════════════════════════════════════════════════════════════════════
# Signal classifier
# ══════════════════════════════════════════════════════════════════════════════

class TestClassifySignal:

    def test_froth_when_low_delivery_and_high_pcr(self):
        # Low delivery + high PCR → FROTH regardless of blended score
        signal, reason = _classify_signal(3.0, 25.0, 1.5, 0.0)
        assert signal == "FROTH"
        assert "delivery" in reason.lower() or "pcr" in reason.lower()

    def test_no_froth_when_pcr_missing(self):
        # Can't trigger FROTH without PCR data
        signal, _ = _classify_signal(0.0, 20.0, None, 0.0)
        assert signal != "FROTH"

    def test_no_froth_when_delivery_high(self):
        # High delivery even with high PCR → not FROTH
        signal, _ = _classify_signal(0.0, 60.0, 1.5, 0.0)
        assert signal != "FROTH"

    def test_accumulation_above_threshold(self):
        signal, _ = _classify_signal(ACCUMULATION_THRESHOLD + 0.1, 60.0, 0.5, 3.0)
        assert signal == "ACCUMULATION"

    def test_distribution_below_threshold(self):
        # delivery_pct=50 > FROTH_DELIVERY_CEILING(35) → FROTH doesn't trigger
        signal, _ = _classify_signal(DISTRIBUTION_THRESHOLD - 0.1, 50.0, 1.3, -3.0)
        assert signal == "DISTRIBUTION"

    def test_neutral_in_middle_band(self):
        signal, _ = _classify_signal(0.0, 50.0, 0.9, 0.0)
        assert signal == "NEUTRAL"

    def test_froth_takes_priority_over_accumulation(self):
        # Even if blended score is high, FROTH wins when conditions met
        signal, _ = _classify_signal(4.0, 20.0, 1.5, 5.0)
        assert signal == "FROTH"


# ══════════════════════════════════════════════════════════════════════════════
# compute_for_symbol — integration across all four sub-signals
# ══════════════════════════════════════════════════════════════════════════════

class TestComputeForSymbol:

    def _make_data(
        self,
        delivery_pcts=None,
        disclosures=None,
        inst_change=None,
        deriv=(None, None),
    ):
        return (
            {"RELIANCE": delivery_pcts or []},
            {"RELIANCE": disclosures or []},
            {"RELIANCE": inst_change} if inst_change is not None else {},
            {"RELIANCE": deriv},
        )

    def test_all_zero_data_returns_all_zero_scores(self):
        del_d, disc_d, inst_d, deriv_d = self._make_data()
        row = compute_for_symbol("RELIANCE", del_d, disc_d, inst_d, deriv_d)
        assert row["del_score"]   == 0
        assert row["disc_score"]  == 0
        assert row["inst_score"]  == 0
        assert row["deriv_score"] == 0

    def test_blended_score_within_range(self):
        del_d  = {"RELIANCE": [80]*20}
        disc_d = {"RELIANCE": [("Good", 5), ("Good", 4)]}
        inst_d = {"RELIANCE": 8.0}
        deriv_d = {"RELIANCE": (0.5, -3.0)}
        row = compute_for_symbol("RELIANCE", del_d, disc_d, inst_d, deriv_d)
        assert -5.0 <= row["blended"] <= 5.0

    def test_froth_scenario_classified_correctly(self):
        # Low delivery + high PCR → FROTH
        del_d   = {"RELIANCE": [20]*20}
        disc_d  = {"RELIANCE": []}
        inst_d  = {}
        deriv_d = {"RELIANCE": (1.5, 2.0)}
        row = compute_for_symbol("RELIANCE", del_d, disc_d, inst_d, deriv_d)
        assert row["signal"] == "FROTH"

    def test_missing_symbol_returns_all_zero(self):
        row = compute_for_symbol("UNKNOWN", {}, {}, {}, {})
        assert row["blended"] == 0.0
        assert row["signal"] == "NEUTRAL"

    def test_output_contains_all_required_keys(self):
        del_d, disc_d, inst_d, deriv_d = self._make_data()
        row = compute_for_symbol("RELIANCE", del_d, disc_d, inst_d, deriv_d)
        required = {
            "symbol", "del_score", "disc_score", "inst_score", "deriv_score",
            "blended", "pct_5d", "pct_20d", "trend", "mf_change",
            "pcr", "iv_skew", "disc_subject", "disc_latest_score",
            "signal", "signal_reason",
        }
        assert required.issubset(row.keys())
