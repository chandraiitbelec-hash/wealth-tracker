"""
Centralised logger factory.

All pipeline modules call get_logger(__name__) to obtain a consistently
formatted StreamHandler logger. Using a single factory keeps log format
changes in one place and avoids duplicate handler registration on re-import.
"""

import logging
import sys

# ── Section divider ────────────────────────────────────────────────────────────


def get_logger(name: str) -> logging.Logger:
    logger = logging.getLogger(name)
    if not logger.handlers:
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(
            logging.Formatter("%(asctime)s | %(levelname)-8s | %(name)s | %(message)s")
        )
        logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    return logger
