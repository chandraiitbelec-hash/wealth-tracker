"""
Unit tests for ingestion/news_feed.py — pure functions only.

All functions that touch the DB or network are mocked.
"""

import pytest
from datetime import datetime, timezone, timedelta
from unittest.mock import MagicMock, patch

from ingestion.news_feed import (
    _clean,
    _infer_category,
    _tag_symbols,
    _parse_date,
    ARTICLE_MAX_AGE_HOURS,
    ARTICLE_RETENTION_DAYS,
    ECONOMY_KWORDS,
    MARKET_KWORDS,
    MF_KWORDS,
)


# ══════════════════════════════════════════════════════════════════════════════
# _clean — HTML stripping and whitespace normalisation
# ══════════════════════════════════════════════════════════════════════════════

class TestClean:

    def test_strips_html_tags(self):
        assert _clean("<p>Hello <b>world</b></p>") == "Hello world"

    def test_decodes_html_entities(self):
        result = _clean("Infosys &amp; Wipro")
        assert "&amp;" not in result
        assert "Infosys" in result and "Wipro" in result

    def test_collapses_whitespace(self):
        result = _clean("  too   many   spaces  ")
        assert "  " not in result

    def test_empty_string_returns_empty(self):
        assert _clean("") == ""

    def test_none_like_empty_string(self):
        # The function signature accepts str; passing "" covers the falsy branch
        assert _clean("") == ""

    def test_truncates_at_1000_chars(self):
        long_text = "a" * 2000
        assert len(_clean(long_text)) <= 1000


# ══════════════════════════════════════════════════════════════════════════════
# _infer_category — keyword-based category override
# ══════════════════════════════════════════════════════════════════════════════

class TestInferCategory:

    def test_rbi_keyword_overrides_to_economy(self):
        assert _infer_category("RBI raises repo rate", "", "market") == "economy"

    def test_mutual_fund_keyword_gives_mf(self):
        assert _infer_category("NAV falls in equity fund", "", "economy") == "mf"

    def test_nifty_keyword_gives_market(self):
        assert _infer_category("Nifty hits record high", "", "stocks") == "market"

    def test_mf_takes_priority_over_economy(self):
        # "mutual fund" + "repo rate" → mf should win (checked first)
        result = _infer_category("Mutual fund portfolio and repo rate", "", "stocks")
        assert result == "mf"

    def test_falls_back_to_default_when_no_keyword(self):
        result = _infer_category("Company fires CEO", "Board reshuffle", "stocks")
        assert result == "stocks"

    def test_case_insensitive_matching(self):
        assert _infer_category("REPO RATE HIKE EXPECTED", "", "market") == "economy"

    def test_keyword_in_summary_also_triggers(self):
        result = _infer_category("Breaking news", "RBI policy meeting today", "market")
        assert result == "economy"


# ══════════════════════════════════════════════════════════════════════════════
# _tag_symbols — NSE symbol extraction from article text
# ══════════════════════════════════════════════════════════════════════════════

class TestTagSymbols:

    def _make_index(self):
        return {
            "RELIANCE": "RELIANCE",
            "INFY": "INFY",
            "TCS": "TCS",
            "HDFCBANK": "HDFCBANK",
            "INFOSYS": "INFY",       # company name token → symbol
            "TATA": "TCS",           # company name token
        }

    def test_finds_symbol_in_title(self):
        index = self._make_index()
        tags = _tag_symbols("RELIANCE hits 52-week high", "", index)
        assert "RELIANCE" in tags

    def test_finds_multiple_symbols(self):
        index = self._make_index()
        tags = _tag_symbols("INFY and TCS report strong Q4", "", index)
        assert "INFY" in tags
        assert "TCS" in tags

    def test_finds_symbol_via_company_name_token(self):
        index = self._make_index()
        tags = _tag_symbols("Infosys beats estimates", "", index)
        assert "INFY" in tags

    def test_returns_sorted_list(self):
        index = self._make_index()
        tags = _tag_symbols("TCS and INFY", "", index)
        assert tags == sorted(tags)

    def test_no_false_positive_on_common_words(self):
        # "THE", "AND" are not in the index so shouldn't match
        index = self._make_index()
        tags = _tag_symbols("The company and its board", "", index)
        assert tags == []

    def test_empty_index_returns_empty(self):
        tags = _tag_symbols("RELIANCE INFY TCS", "", {})
        assert tags == []

    def test_scans_both_title_and_summary(self):
        index = self._make_index()
        tags = _tag_symbols("Market update", "HDFCBANK raises rates", index)
        assert "HDFCBANK" in tags

    def test_deduplicates_results(self):
        index = self._make_index()
        tags = _tag_symbols("RELIANCE RELIANCE RELIANCE", "", index)
        assert tags.count("RELIANCE") == 1


# ══════════════════════════════════════════════════════════════════════════════
# _parse_date — feedparser entry date extraction
# ══════════════════════════════════════════════════════════════════════════════

class TestParseDate:

    def _make_entry(self, **kwargs):
        entry = MagicMock()
        # Default: no date attributes
        for attr in ("published_parsed", "updated_parsed", "created_parsed",
                     "published", "updated"):
            setattr(entry, attr, None)
        for k, v in kwargs.items():
            setattr(entry, k, v)
        return entry

    def test_uses_published_parsed_first(self):
        t = (2025, 1, 15, 10, 0, 0, 0, 0, 0)   # time.struct_time-like tuple
        entry = self._make_entry(published_parsed=t)
        result = _parse_date(entry)
        assert result.year == 2025
        assert result.month == 1

    def test_falls_back_to_string_published(self):
        entry = self._make_entry(published="Mon, 15 Jan 2025 10:00:00 +0000")
        result = _parse_date(entry)
        assert result.year == 2025

    def test_returns_utcnow_when_no_date(self):
        entry = self._make_entry()
        before = datetime.utcnow()
        result = _parse_date(entry)
        after  = datetime.utcnow()
        assert before <= result.replace(tzinfo=None) <= after


# ══════════════════════════════════════════════════════════════════════════════
# Constants sanity checks
# ══════════════════════════════════════════════════════════════════════════════

class TestConstants:

    def test_max_age_hours_is_positive(self):
        assert ARTICLE_MAX_AGE_HOURS > 0

    def test_retention_days_greater_than_max_age(self):
        # Retention window must be wider than the fetch window
        assert ARTICLE_RETENTION_DAYS * 24 >= ARTICLE_MAX_AGE_HOURS

    def test_keyword_sets_are_non_empty(self):
        assert len(ECONOMY_KWORDS) > 0
        assert len(MARKET_KWORDS) > 0
        assert len(MF_KWORDS) > 0

    def test_no_overlap_between_market_and_economy_core_terms(self):
        # "nifty" shouldn't be in economy, "rbi" shouldn't be in market
        assert "nifty" not in ECONOMY_KWORDS
        assert "rbi" not in MARKET_KWORDS
