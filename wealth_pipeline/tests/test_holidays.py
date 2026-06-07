"""
Unit tests for utils/holidays.py — is_trading_day().

No network or DB access required.
"""

import pytest
from datetime import date

from utils.holidays import is_trading_day


# ══════════════════════════════════════════════════════════════════════════════
# Weekends — always non-trading
# ══════════════════════════════════════════════════════════════════════════════

class TestWeekends:

    def test_saturday_is_not_trading(self):
        # 2025-06-07 is a Saturday
        assert is_trading_day(date(2025, 6, 7)) is False

    def test_sunday_is_not_trading(self):
        # 2025-06-08 is a Sunday
        assert is_trading_day(date(2025, 6, 8)) is False

    def test_saturday_2026_is_not_trading(self):
        # 2026-01-03 is a Saturday
        assert is_trading_day(date(2026, 1, 3)) is False


# ══════════════════════════════════════════════════════════════════════════════
# NSE 2025 known holidays — all on weekdays
# ══════════════════════════════════════════════════════════════════════════════

class TestNSEHolidays2025:

    def test_republic_day_2025(self):
        # Jan 26 2025 is a Sunday — falls on weekend anyway
        # Let's use Mahashivratri: Feb 26, 2025 (Wednesday)
        assert is_trading_day(date(2025, 2, 26)) is False

    def test_holi_2025(self):
        # Mar 14, 2025 (Friday)
        assert is_trading_day(date(2025, 3, 14)) is False

    def test_good_friday_2025(self):
        # Apr 18, 2025 (Friday)
        assert is_trading_day(date(2025, 4, 18)) is False

    def test_independence_day_2025(self):
        # Aug 15, 2025 (Friday)
        assert is_trading_day(date(2025, 8, 15)) is False

    def test_christmas_2025(self):
        # Dec 25, 2025 (Thursday)
        assert is_trading_day(date(2025, 12, 25)) is False

    def test_diwali_laxmi_puja_2025(self):
        # Oct 20, 2025 (Monday) — listed as holiday (or Muhurat session)
        assert is_trading_day(date(2025, 10, 20)) is False

    def test_maharashtra_day_2025(self):
        # May 1, 2025 (Thursday)
        assert is_trading_day(date(2025, 5, 1)) is False


# ══════════════════════════════════════════════════════════════════════════════
# NSE 2026 known holidays
# ══════════════════════════════════════════════════════════════════════════════

class TestNSEHolidays2026:

    def test_good_friday_2026(self):
        # Apr 3, 2026 (Friday)
        assert is_trading_day(date(2026, 4, 3)) is False

    def test_independence_day_2026(self):
        # Aug 15, 2026 (Saturday — but still in holiday set)
        assert is_trading_day(date(2026, 8, 15)) is False

    def test_holi_2026(self):
        # Mar 20, 2026 (Friday)
        assert is_trading_day(date(2026, 3, 20)) is False


# ══════════════════════════════════════════════════════════════════════════════
# Normal trading days — should return True
# ══════════════════════════════════════════════════════════════════════════════

class TestNormalTradingDays:

    def test_regular_monday_2025(self):
        # Jun 2, 2025 — regular Monday, no holiday
        assert is_trading_day(date(2025, 6, 2)) is True

    def test_regular_tuesday_2025(self):
        # Jun 3, 2025
        assert is_trading_day(date(2025, 6, 3)) is True

    def test_regular_wednesday_2026(self):
        # Jun 3, 2026 — Wednesday
        assert is_trading_day(date(2026, 6, 3)) is True

    def test_regular_friday_2026(self):
        # Jun 5, 2026 — Friday, no holiday
        assert is_trading_day(date(2026, 6, 5)) is True


# ══════════════════════════════════════════════════════════════════════════════
# Default argument (today)
# ══════════════════════════════════════════════════════════════════════════════

class TestDefaultArgument:

    def test_no_arg_does_not_raise(self):
        # Should not raise; return value depends on when tests run
        result = is_trading_day()
        assert isinstance(result, bool)
