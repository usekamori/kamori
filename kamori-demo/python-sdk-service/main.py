"""
python-sdk-service — Loyalty Points

──────────────────────────────────────────────────────────────────────────
SDK Integration: Python KamoriClient  (kamori-sdk)

KamoriClient is a buffered, thread-safe HTTP client. Events are queued and
flushed on a background thread — client.log() never blocks the caller.

Integration (3 lines):
    from kamori_sdk import KamoriClient
    client = KamoriClient(url=KAMORI_URL, token=INGEST_TOKEN or None)
    client.log({"level": "info", "event": "loyalty_awarded", ...})

Best for: services that want full control over event shape without tying
into Python's logging module.
──────────────────────────────────────────────────────────────────────────
"""

import atexit
import os

from fastapi import FastAPI, Request
from kamori_sdk import KamoriClient

KAMORI_URL    = os.getenv("KAMORI_URL",    "http://localhost:3110")
INGEST_TOKEN = os.getenv("INGEST_TOKEN", "")

app = FastAPI()

# ── Kamori Python SDK ──────────────────────────────────────────────────────
# KamoriClient queues events and flushes in the background — log() is non-blocking.
kamori = KamoriClient(url=KAMORI_URL, token=INGEST_TOKEN or None)
atexit.register(lambda: kamori.shutdown(timeout=5.0))
# ─────────────────────────────────────────────────────────────────────────

_loyalty_count = 0


@app.get("/health")
def health():
    return {"ok": True, "service": "python-sdk-service", "sdk": "KamoriClient"}


@app.post("/award-loyalty")
async def award_loyalty(request: Request):
    global _loyalty_count
    _loyalty_count += 1

    body     = await request.json()
    order_id = body.get("orderId", "unknown")
    amount   = float(body.get("amount", 0))
    user_id  = body.get("userId", "anonymous")
    points   = int(amount * 10)  # 10 points per dollar

    # Fault: every 10th calculation simulates a loyalty DB timeout
    if _loyalty_count % 10 == 0:
        kamori.log({
            "level":   "error",
            "event":   "loyalty_db_timeout",
            "service": "python-sdk-service",
            "orderId": order_id,
            "userId":  user_id,
            "message": f"Loyalty DB connection timed out after 5s for order {order_id}",
        })
        return {"ok": False, "error": "db_timeout", "points": 0}

    kamori.log({
        "level":   "info",
        "event":   "loyalty_awarded",
        "service": "python-sdk-service",
        "orderId": order_id,
        "userId":  user_id,
        "amount":  amount,
        "points":  points,
    })
    return {"ok": True, "orderId": order_id, "userId": user_id, "points": points}
