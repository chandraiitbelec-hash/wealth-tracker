"""
NSE trading holiday guard.

Maintains a simple hardcoded list for the current year.
Replace with an API call or DB table as the product matures.
"""

from datetime import date

# NSE holidays 2025 (add 2026 when needed)
NSE_HOLIDAYS_2025 = {
    date(2025, 1, 26),   # Republic Day
    date(2025, 2, 26),   # Mahashivratri
    date(2025, 3, 14),   # Holi
    date(2025, 3, 31),   # Id-Ul-Fitr (Ramzan Eid)
    date(2025, 4, 10),   # Shri Ram Navami
    date(2025, 4, 14),   # Dr. Baba Saheb Ambedkar Jayanti
    date(2025, 4, 18),   # Good Friday
    date(2025, 5, 1),    # Maharashtra Day
    date(2025, 8, 15),   # Independence Day
    date(2025, 8, 27),   # Ganesh Chaturthi
    date(2025, 10, 2),   # Gandhi Jayanti (Mahatma Gandhi)
    date(2025, 10, 2),   # Dussehra
    date(2025, 10, 20),  # Diwali Laxmi Puja (Muhurat Trading — short session)
    date(2025, 10, 21),  # Diwali Balipratipada
    date(2025, 11, 5),   # Prakash Gurpurb Sri Guru Nanak Dev Ji
    date(2025, 12, 25),  # Christmas
}


def is_trading_day(check_date: date = None) -> bool:
    """Return True if the given date is a valid NSE trading day."""
    if check_date is None:
        check_date = date.today()

    # Weekends
    if check_date.weekday() >= 5:
        return False

    # Known holidays
    if check_date in NSE_HOLIDAYS_2025:
        return False

    return True
