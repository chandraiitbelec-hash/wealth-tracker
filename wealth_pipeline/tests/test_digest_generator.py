"""
Unit tests for digest/generator.py — pure helper functions only.

All DB and API calls are mocked or not invoked at all.
"""

import pytest
from datetime import date, timedelta
from unittest.mock import patch, MagicMock

from digest.generator import (
    _fmt_cr,
    _pct,
    _top_sectors,
    _elss_expiring_soon,
)


# ══════════════════════════════════════════════════════════════════════════════
# _fmt_cr — currency formatter
# ══════════════════════════════════════════════════════════════════════════════

class TestFmtCr:

    def test_crores(self):
        result = _fmt_cr(1_00_00_000)
        assert "Cr" in result
        assert "1.00" in result

    def test_large_crores(self):
        result = _fmt_cr(5_50_00_000)
        assert "Cr" in result
        assert "5.50" in result

    def test_lakhs(self):
        result = _fmt_cr(2_50_000)
        assert "L" in result
        assert "2.50" in result

    def test_below_lakh(self):
        result = _fmt_cr(50_000)
        assert "Cr" not in result
        assert "L" not in result
        assert "50,000" in result

    def test_zero(self):
        result = _fmt_cr(0)
        assert result is not None
        assert len(result) > 0

    def test_currency_symbol_present(self):
        assert "₹" in _fmt_cr(1_00_00_000)
        assert "₹" in _fmt_cr(2_50_000)
        assert "₹" in _fmt_cr(50_000)

    def test_uses_abs_for_negative(self):
        # Negative values should show absolute value
        result = _fmt_cr(-1_00_00_000)
        assert "1.00" in result
        assert "Cr" in result


# ══════════════════════════════════════════════════════════════════════════════
# _pct — percentage-change formatter
# ══════════════════════════════════════════════════════════════════════════════

class TestPct:

    def test_positive_change(self):
        # (11 - 10) / 10 * 100 = +10%
        result = _pct(11.0, 10.0)
        assert result == "+10.00%"

    def test_negative_change(self):
        # (9 - 10) / 10 * 100 = -10%
        result = _pct(9.0, 10.0)
        assert result == "-10.00%"

    def test_no_change(self):
        result = _pct(10.0, 10.0)
        assert result == "+0.00%"

    def test_zero_base_returns_na(self):
        result = _pct(100.0, 0.0)
        assert result == "N/A"

    def test_sign_always_present(self):
        result = _pct(12.0, 10.0)
        assert result.startswith("+") or result.startswith("-")


# ══════════════════════════════════════════════════════════════════════════════
# _top_sectors — sector breakdown from payload
# ══════════════════════════════════════════════════════════════════════════════

def _make_payload(stocks=None, mf=None):
    return {
        "stocks": stocks or [],
        "mutualFunds": mf or [],
    }


class TestTopSectors:

    def test_returns_top_n_sectors(self):
        stocks = [
            {"sector": "Technology", "closingValue": 100_000},
            {"sector": "Banking",    "closingValue": 80_000},
            {"sector": "FMCG",       "closingValue": 60_000},
            {"sector": "Energy",     "closingValue": 40_000},
            {"sector": "Pharma",     "closingValue": 20_000},
            {"sector": "Auto",       "closingValue": 10_000},
        ]
        result = _top_sectors(_make_payload(stocks), n=5)
        assert len(result) == 5

    def test_sorted_descending_by_value(self):
        stocks = [
            {"sector": "Banking",    "closingValue": 80_000},
            {"sector": "Technology", "closingValue": 100_000},
        ]
        result = _top_sectors(_make_payload(stocks))
        assert result[0]["sector"] == "Technology"
        assert result[1]["sector"] == "Banking"

    def test_aggregates_same_sector(self):
        stocks = [
            {"sector": "Technology", "closingValue": 40_000},
            {"sector": "Technology", "closingValue": 60_000},
            {"sector": "Banking",    "closingValue": 50_000},
        ]
        result = _top_sectors(_make_payload(stocks))
        tech = next(r for r in result if r["sector"] == "Technology")
        assert tech["value"] == 100_000

    def test_excludes_unknown_sector(self):
        stocks = [
            {"sector": None,         "closingValue": 999_999},
            {"sector": "Technology", "closingValue": 1_000},
        ]
        result = _top_sectors(_make_payload(stocks))
        names = [r["sector"] for r in result]
        assert "Unknown" not in names

    def test_empty_payload_returns_empty(self):
        result = _top_sectors(_make_payload())
        assert result == []

    def test_result_contains_sector_and_value_keys(self):
        stocks = [{"sector": "IT", "closingValue": 50_000}]
        result = _top_sectors(_make_payload(stocks))
        assert "sector" in result[0]
        assert "value" in result[0]


# ══════════════════════════════════════════════════════════════════════════════
# _elss_expiring_soon — 3-year lock-in expiry within 90 days
# ══════════════════════════════════════════════════════════════════════════════

class TestElssExpiringSoon:

    def _make_mf(self, scheme, category, purchase_date_str):
        return {
            "schemeName": scheme,
            "category": category,
            "purchaseDate": purchase_date_str,
        }

    def test_elss_expiring_within_90_days(self):
        today = date.today()
        # Lock-in ends 45 days from now → within the 90-day window
        lock_end = today + timedelta(days=45)
        purchase = date(lock_end.year - 3, lock_end.month, lock_end.day)
        payload = _make_payload(mf=[
            self._make_mf("ELSS Fund A", "ELSS", purchase.isoformat())
        ])
        result = _elss_expiring_soon(payload)
        assert "ELSS Fund A" in result

    def test_elss_not_expiring_within_90_days(self):
        today = date.today()
        # Lock-in ends 200 days from now → outside window
        lock_end = today + timedelta(days=200)
        purchase = date(lock_end.year - 3, lock_end.month, lock_end.day)
        payload = _make_payload(mf=[
            self._make_mf("ELSS Fund B", "ELSS", purchase.isoformat())
        ])
        result = _elss_expiring_soon(payload)
        assert "ELSS Fund B" not in result

    def test_non_elss_fund_ignored(self):
        today = date.today()
        lock_end = today + timedelta(days=30)
        purchase = date(lock_end.year - 3, lock_end.month, lock_end.day)
        payload = _make_payload(mf=[
            self._make_mf("Equity Growth Fund", "Equity", purchase.isoformat())
        ])
        result = _elss_expiring_soon(payload)
        assert "Equity Growth Fund" not in result

    def test_missing_purchase_date_skipped(self):
        payload = _make_payload(mf=[{
            "schemeName": "ELSS Fund C",
            "category": "ELSS",
            "purchaseDate": None,
        }])
        result = _elss_expiring_soon(payload)
        assert result == []

    def test_empty_mf_list(self):
        result = _elss_expiring_soon(_make_payload())
        assert result == []

    def test_already_expired_not_included(self):
        # Lock-in ended yesterday
        yesterday = date.today() - timedelta(days=1)
        purchase = date(yesterday.year - 3, yesterday.month, yesterday.day)
        payload = _make_payload(mf=[
            self._make_mf("ELSS Fund D", "ELSS", purchase.isoformat())
        ])
        result = _elss_expiring_soon(payload)
        assert "ELSS Fund D" not in result

    def test_case_insensitive_elss_category(self):
        today = date.today()
        lock_end = today + timedelta(days=30)
        purchase = date(lock_end.year - 3, lock_end.month, lock_end.day)
        payload = _make_payload(mf=[
            self._make_mf("ELSS Fund E", "Tax Saver - elss", purchase.isoformat())
        ])
        result = _elss_expiring_soon(payload)
        assert "ELSS Fund E" in result
