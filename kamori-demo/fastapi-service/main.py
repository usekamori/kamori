import logging
import os
import random
import time

import httpx
from fastapi import FastAPI

KAMORI_URL = os.getenv("KAMORI_URL", "http://localhost:7000")
INGEST_TOKEN = os.getenv("INGEST_TOKEN", "")

app = FastAPI()


def log_to_kamori(event: dict) -> None:
    """Fire-and-forget log to Kamori."""
    try:
        httpx.post(
            f"{KAMORI_URL}/v1/ingest",
            json={**event, "service": "fastapi-service"},
            headers={"Authorization": f"Bearer {INGEST_TOKEN}"} if INGEST_TOKEN else {},
            timeout=2.0,
        )
    except Exception:
        pass  # Never let logging break the app


@app.get("/health")
def health():
    return {"ok": True, "service": "fastapi-service"}


@app.get("/recommendations")
def recommendations(user_id: str = "anonymous"):
    start = time.time()

    # 10% of requests are artificially slow (simulated DB bottleneck)
    if random.random() < 0.1:
        time.sleep(2.0)
        elapsed_ms = round((time.time() - start) * 1000)
        log_to_kamori({
            "level": "warn",
            "event": "slow_recommendation_query",
            "user_id": user_id,
            "duration_ms": elapsed_ms,
            "message": f"Recommendation query exceeded 2s threshold ({elapsed_ms}ms)",
        })
    else:
        elapsed_ms = round((time.time() - start) * 1000)
        log_to_kamori({
            "level": "info",
            "event": "recommendations_served",
            "user_id": user_id,
            "duration_ms": elapsed_ms,
        })

    return {
        "user_id": user_id,
        "recommendations": [
            {"id": "prod-101", "name": "Wireless Headphones", "score": 0.94},
            {"id": "prod-202", "name": "Mechanical Keyboard", "score": 0.87},
            {"id": "prod-303", "name": "USB-C Hub", "score": 0.79},
        ],
    }
