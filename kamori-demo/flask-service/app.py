"""
flask-service — Email Confirmation

──────────────────────────────────────────────────────────────────────────
SDK Integration: Python logging + KamoriHandler  (kamori-sdk)

KamoriHandler is a standard logging.Handler. Attach it to any existing
Python logger and all records forward to Kamori — zero changes to existing
log call sites.

Integration (3 lines):
    import logging
    from kamori_sdk.logging_handler import KamoriHandler

    logging.getLogger().addHandler(
        KamoriHandler(url=KAMORI_URL, token=INGEST_TOKEN or None)
    )

Best for: services already using Python's logging module (Django, Flask, etc.).
──────────────────────────────────────────────────────────────────────────
"""

import atexit
import logging
import os

from flask import Flask, jsonify, request
from kamori_sdk.logging_handler import KamoriHandler

app = Flask(__name__)

KAMORI_URL    = os.getenv("KAMORI_URL",    "http://localhost:3110")
INGEST_TOKEN = os.getenv("INGEST_TOKEN", "")

# ── Kamori: Python logging + KamoriHandler ──────────────────────────────────
# Attach KamoriHandler alongside StreamHandler (stdout).
# Every logger.info / .warning / .error call now goes to both.
_kamori_handler = KamoriHandler(url=KAMORI_URL, token=INGEST_TOKEN or None)
logging.basicConfig(level=logging.DEBUG, handlers=[logging.StreamHandler(), _kamori_handler])
logger = logging.getLogger("flask-service")
atexit.register(lambda: _kamori_handler.client.shutdown(timeout=5.0))
# ─────────────────────────────────────────────────────────────────────────

_confirmation_count = 0


@app.get("/health")
def health():
    return jsonify({"ok": True, "service": "flask-service", "sdk": "python-logging+KamoriHandler"})


@app.post("/send-confirmation")
def send_confirmation():
    global _confirmation_count
    _confirmation_count += 1

    body     = request.get_json(silent=True) or {}
    to_email = body.get("email", "user@example.com")
    order_id = body.get("orderId", "unknown")

    # Fault: every 20th confirmation simulates an SMTP 550 bounce
    if _confirmation_count % 20 == 0:
        logger.error(
            "smtp_bounce orderId=%s smtp_code=550 email=%s — SMTP 550 5.1.1: User unknown",
            order_id, to_email,
        )
        return jsonify({"ok": False, "error": "email_bounced", "orderId": order_id}), 422

    logger.info("confirmation_sent orderId=%s email=%s", order_id, to_email)
    return jsonify({"ok": True, "orderId": order_id, "email": to_email})
