"""
Digest Emailer
--------------
Sends the generated HTML digest to the user via SMTP.

Config (all via .env):
  DIGEST_SMTP_HOST      e.g. smtp.gmail.com
  DIGEST_SMTP_PORT      e.g. 587
  DIGEST_SMTP_USER      sender email address
  DIGEST_SMTP_PASSWORD  sender email password / app password
  DIGEST_FROM_NAME      e.g. "Wealth Tracker"
  DIGEST_RECIPIENTS     comma-separated email addresses
                        (maps to user_identifiers in portfolio_snapshots)

If DIGEST_SMTP_HOST is not set, digests are logged to stdout only
(useful for local dev / CI).
"""

import os
import smtplib
import email.mime.multipart as multipart
import email.mime.text as mimetext
from typing import Dict, Optional

from utils.logger import get_logger
from digest.generator import run_all, generate_digest_for_user

log = get_logger("digest.emailer")

# ── Config ────────────────────────────────────────────────────────────────────

def _cfg(key: str, default: str = "") -> str:
    return os.getenv(key, default).strip()


def _smtp_enabled() -> bool:
    return bool(_cfg("DIGEST_SMTP_HOST") and _cfg("DIGEST_SMTP_USER"))


# ── Send one email ────────────────────────────────────────────────────────────

def _send_email(to_addr: str, subject: str, html: str, plain: str):
    if not _smtp_enabled():
        log.info("[DRY RUN] Would send to %s: %s", to_addr, subject)
        log.info(plain)
        return

    msg = multipart.MIMEMultipart("alternative")
    msg["From"]    = f"{_cfg('DIGEST_FROM_NAME', 'Wealth Tracker')} <{_cfg('DIGEST_SMTP_USER')}>"
    msg["To"]      = to_addr
    msg["Subject"] = subject

    msg.attach(mimetext.MIMEText(plain, "plain", "utf-8"))
    msg.attach(mimetext.MIMEText(html,  "html",  "utf-8"))

    host = _cfg("DIGEST_SMTP_HOST")
    port = int(_cfg("DIGEST_SMTP_PORT", "587"))
    user = _cfg("DIGEST_SMTP_USER")
    pwd  = _cfg("DIGEST_SMTP_PASSWORD")

    try:
        with smtplib.SMTP(host, port, timeout=30) as s:
            s.ehlo()
            s.starttls()
            s.login(user, pwd)
            s.sendmail(user, [to_addr], msg.as_bytes())
        log.info("Email sent → %s: %s", to_addr, subject)
    except Exception as exc:
        log.error("SMTP failed for %s: %s", to_addr, exc)
        raise


# ── Recipient mapping ─────────────────────────────────────────────────────────

def _build_recipient_map() -> Dict[str, str]:
    """
    Returns {user_identifier: email_address} from env var DIGEST_RECIPIENTS.

    Format: "user_id_1:email1@x.com,user_id_2:email2@x.com"
    If only an email is given (no colon), it doubles as the user_identifier.
    """
    raw = _cfg("DIGEST_RECIPIENTS")
    if not raw:
        return {}
    result = {}
    for entry in raw.split(","):
        entry = entry.strip()
        if not entry:
            continue
        if ":" in entry:
            uid, email_addr = entry.split(":", 1)
            result[uid.strip()] = email_addr.strip()
        else:
            result[entry] = entry   # email doubles as user ID
    return result


# ── Main run ──────────────────────────────────────────────────────────────────

def run(dry_run: bool = False):
    """
    Generate and email weekly portfolio digests to all configured recipients.

    Calls run_all() from digest.generator to build personalised HTML/plain-text
    digests for each user who has a portfolio snapshot. Then looks up each
    user_identifier in the DIGEST_RECIPIENTS env-var map and sends the digest
    via SMTP. If DIGEST_SMTP_HOST is not configured, digests are logged to
    stdout only (safe for local dev). If `dry_run` is True, both generation and
    email sending are suppressed — generator logs the plain text instead.
    Called by the scheduler every Friday at 5:00 PM IST.
    """
    log.info("=== Digest Emailer starting (dry_run=%s) ===", dry_run)

    recipient_map = _build_recipient_map()
    if not recipient_map:
        log.warning(
            "DIGEST_RECIPIENTS is not set — generating digests but not sending emails. "
            "Set DIGEST_RECIPIENTS=user_id:email@x.com in .env to enable delivery."
        )

    digests = run_all(dry_run=dry_run)
    log.info("Generated %d digest(s)", len(digests))

    sent = skipped = failed = 0
    for d in digests:
        uid   = d["user_id"]
        email = recipient_map.get(uid)
        if not email:
            log.info("No email mapped for user %s — skipping delivery", uid)
            skipped += 1
            continue
        try:
            _send_email(email, d["subject"], d["html"], d["plain"])
            sent += 1
        except Exception:
            failed += 1

    log.info("=== Done — sent=%d  skipped=%d  failed=%d ===", sent, skipped, failed)


if __name__ == "__main__":
    # Local test: python -m digest.emailer
    run(dry_run=True)
