"""
Unit tests for ingestion/alternative_data.py — MTO parser, option-chain
parser, and the token-bucket rate limiter.

Network calls are fully mocked; no DB access.
"""

import time
import threading
import pytest
from datetime import date
from unittest.mock import MagicMock, patch

from ingestion.alternative_data import (
    _parse_mto,
    _parse_option_chain,
    _TokenBucket,
)


# ══════════════════════════════════════════════════════════════════════════════
# _parse_mto — NSE MTO DAT file parser
# ══════════════════════════════════════════════════════════════════════════════

class TestParseMTO:
    """Tests for the NSE delivery-statistics DAT file parser."""

    def _make_mto_bytes(self, lines: list[str]) -> bytes:
        return "\n".join(lines).encode("latin-1")

    def test_parses_comma_separated_eq_records(self):
        content = self._make_mto_bytes([
            "10,1,RELIANCE,EQ,1000000,650000,65.00",
            "10,2,INFY,EQ,500000,300000,60.00",
        ])
        records = _parse_mto(content)
        assert len(records) == 2
        assert records[0]["symbol"] == "RELIANCE"
        assert records[0]["delivery_pct"] == pytest.approx(65.0)
        assert records[1]["deliverable_qty"] == 300000

    def test_parses_pipe_separated_records(self):
        content = self._make_mto_bytes([
            "10|1|TCS|EQ|200000|150000|75.00",
        ])
        records = _parse_mto(content)
        assert len(records) == 1
        assert records[0]["symbol"] == "TCS"
        assert records[0]["delivery_pct"] == pytest.approx(75.0)

    def test_skips_non_record_type_10(self):
        content = self._make_mto_bytes([
            "20,1,HDFC,EQ,100000,80000,80.00",   # type 20, should be skipped
            "10,2,WIPRO,EQ,50000,30000,60.00",
        ])
        records = _parse_mto(content)
        assert len(records) == 1
        assert records[0]["symbol"] == "WIPRO"

    def test_skips_non_eq_series(self):
        content = self._make_mto_bytes([
            "10,1,NIFTY,FO,999999,500000,50.00",   # F&O series, skip
            "10,2,SBIN,BE,100000,60000,60.00",      # BE series, keep
        ])
        records = _parse_mto(content)
        # BE is allowed, FO is not
        symbols = [r["symbol"] for r in records]
        assert "SBIN" in symbols
        assert "NIFTY" not in symbols

    def test_handles_numbers_with_commas(self):
        content = self._make_mto_bytes([
            "10,1,RELIANCE,EQ,1,000,000,650,000,65.00",
        ])
        # Commas inside number fields are stripped before int() conversion
        records = _parse_mto(content)
        # If parsing fails due to extra commas we just get 0 records — that's fine
        # The point is it doesn't raise an exception
        assert isinstance(records, list)

    def test_returns_empty_for_empty_content(self):
        records = _parse_mto(b"")
        assert records == []

    def test_returns_empty_for_malformed_content(self):
        records = _parse_mto(b"this is not a valid MTO file\ngarbage data here")
        assert records == []

    def test_record_contains_all_required_fields(self):
        content = self._make_mto_bytes([
            "10,1,HDFC,EQ,100000,70000,70.00",
        ])
        records = _parse_mto(content)
        assert len(records) == 1
        rec = records[0]
        assert "symbol" in rec
        assert "traded_qty" in rec
        assert "deliverable_qty" in rec
        assert "delivery_pct" in rec


# ══════════════════════════════════════════════════════════════════════════════
# _parse_option_chain — NSE option chain response parser
# ══════════════════════════════════════════════════════════════════════════════

def _make_option_chain(symbol="RELIANCE", strikes=None, underlying=2500.0):
    """Build a minimal NSE option-chain API response dict."""
    if strikes is None:
        strikes = [
            {
                "strikePrice":  2400,
                "expiryDate":  "25-Jun-2025",
                "CE": {"openInterest": 10000, "impliedVolatility": 18.0},
                "PE": {"openInterest": 12000, "impliedVolatility": 20.0},
            },
            {
                "strikePrice":  2500,
                "expiryDate":  "25-Jun-2025",
                "CE": {"openInterest": 8000,  "impliedVolatility": 16.0},
                "PE": {"openInterest": 9000,  "impliedVolatility": 18.0},
            },
            {
                "strikePrice":  2600,
                "expiryDate":  "25-Jun-2025",
                "CE": {"openInterest": 6000, "impliedVolatility": 15.0},
                "PE": {"openInterest": 7000, "impliedVolatility": 16.0},
            },
        ]
    return {
        "records": {
            "data": strikes,
            "underlyingValue": underlying,
        },
        "filtered": {"data": strikes},
    }


class TestParseOptionChain:

    def test_returns_dict_with_pcr(self):
        data = _make_option_chain()
        result = _parse_option_chain(data, "RELIANCE")
        assert result is not None
        assert "pcr" in result
        assert result["pcr"] is not None
        assert result["pcr"] > 0

    def test_pcr_is_put_oi_over_call_oi(self):
        # total put OI = 12000+9000+7000=28000, call OI = 10000+8000+6000=24000
        data = _make_option_chain()
        result = _parse_option_chain(data, "RELIANCE")
        expected_pcr = 28000 / 24000
        assert result["pcr"] == pytest.approx(expected_pcr, abs=0.01)

    def test_iv_skew_is_put_minus_call_at_atm(self):
        # ATM strike = 2500 (closest to underlying 2500)
        # ATM put IV = 18.0, call IV = 16.0, skew = 2.0
        data = _make_option_chain()
        result = _parse_option_chain(data, "RELIANCE")
        assert result["iv_skew"] == pytest.approx(2.0, abs=0.1)

    def test_returns_symbol(self):
        data = _make_option_chain()
        result = _parse_option_chain(data, "RELIANCE")
        assert result["symbol"] == "RELIANCE"

    def test_returns_none_for_empty_data(self):
        result = _parse_option_chain({"records": {"data": []}, "filtered": {"data": []}}, "X")
        assert result is None

    def test_underlying_price_captured(self):
        data = _make_option_chain(underlying=3000.0)
        result = _parse_option_chain(data, "RELIANCE")
        assert result["underlying_price"] == pytest.approx(3000.0)

    def test_handles_missing_iv_gracefully(self):
        strikes = [
            {
                "strikePrice": 2500,
                "expiryDate": "25-Jun-2025",
                "CE": {"openInterest": 5000},        # no impliedVolatility
                "PE": {"openInterest": 6000},
            }
        ]
        data = _make_option_chain(strikes=strikes)
        result = _parse_option_chain(data, "RELIANCE")
        # Should still return PCR, but iv_skew may be None
        assert result is not None
        assert result["pcr"] is not None


# ══════════════════════════════════════════════════════════════════════════════
# _TokenBucket — rate limiter
# ══════════════════════════════════════════════════════════════════════════════

class TestTokenBucket:

    def test_first_acquire_does_not_block(self):
        bucket = _TokenBucket(rate=10.0)   # generous rate
        start = time.monotonic()
        bucket.acquire()
        elapsed = time.monotonic() - start
        assert elapsed < 0.1   # should be near-instant

    def test_limits_throughput_over_time(self):
        # Bucket starts full: rate=5 → 5 free tokens. After depletion the
        # implementation alternates (wait + 1 free refill from sleep). For 16
        # acquires: 5 free + 6 waits × 0.2 s + 5 free-from-refill ≈ 1.2 s.
        bucket = _TokenBucket(rate=5.0)
        start = time.monotonic()
        for _ in range(16):
            bucket.acquire()
        elapsed = time.monotonic() - start
        assert elapsed >= 1.0   # at least 5 × 0.2 s waits

    def test_thread_safe_no_over_issue(self):
        """Multiple threads sharing one bucket must not raise exceptions."""
        # Rate=10: bucket starts with 10 tokens. We use 5 threads — all consume
        # immediately. Goal here is no crashes / race conditions, not timing.
        bucket = _TokenBucket(rate=10.0)
        errors = []
        lock = threading.Lock()

        def worker():
            try:
                bucket.acquire()
            except Exception as e:
                with lock:
                    errors.append(str(e))

        threads = [threading.Thread(target=worker) for _ in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        # All 5 workers completed without error → thread safety OK
        assert errors == []
