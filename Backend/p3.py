"""
p3.py — Scanner client for the Raspberry Pi + Google Coral TPU node.

Changes from original:
  - Retry with exponential back-off (network blips are common on RPi).
  - Uses a persistent requests.Session (TCP keep-alive, connection pooling).
  - All config via environment variables.
  - _example_detection_source() stub shows where to wire in EdgeTPU queue.
"""

import os
import time
import logging
import requests
from datetime import datetime, timezone
from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s — %(message)s",
)
logger = logging.getLogger("p3-scanner")

ENV = os.getenv("ENV", "development")
BASE_URL = (
    os.getenv("VITE_PROD_BACKEND_URL")
    if ENV == "production"
    else os.getenv("VITE_DEV_BACKEND_URL", "http://localhost:8000")
)
API_TOKEN = (
    os.getenv("PROD_P3_API_TOKEN")
    if ENV == "production"
    else os.getenv("DEV_P3_API_TOKEN")
)
LOCATION = os.getenv("SCANNER_LOCATION", "entry_scanner_1")
REQUEST_TIMEOUT = int(os.getenv("SCANNER_TIMEOUT_SECS", "10"))
MAX_RETRIES = int(os.getenv("SCANNER_MAX_RETRIES", "5"))

if not API_TOKEN:
    raise RuntimeError(
        f"{'PROD' if ENV == 'production' else 'DEV'}_P3_API_TOKEN is not set in .env"
    )

SCAN_URL = f"{BASE_URL}/api/v1/scan"

session = requests.Session()
session.headers.update({
    "Authorization": f"Bearer {API_TOKEN}",
    "Content-Type": "application/json",
})


def post_scan(plate: str, confidence: float = 0.95) -> bool:
    payload = {
        "plate": plate.upper().strip(),
        "timestamp": datetime.now(tz=timezone.utc).isoformat(),
        "location": LOCATION,
        "confidence_score": round(confidence, 4),
    }

    backoff = 1.0
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            resp = session.post(SCAN_URL, json=payload, timeout=REQUEST_TIMEOUT)
            if resp.status_code == 200:
                logger.info("Scan accepted: plate=%s fs_id=%s",
                            plate, resp.json().get("firestore_id", "?"))
                return True
            elif resp.status_code == 404:
                logger.warning("Plate not in registry: %s — skipping", plate)
                return False
            elif resp.status_code == 401:
                logger.error("Token rejected (401). Refresh DEV/PROD_P3_API_TOKEN.")
                return False
            else:
                logger.warning("HTTP %d on attempt %d/%d: %s",
                               resp.status_code, attempt, MAX_RETRIES, resp.text[:200])
        except requests.exceptions.Timeout:
            logger.warning("Timeout on attempt %d/%d", attempt, MAX_RETRIES)
        except requests.exceptions.ConnectionError as exc:
            logger.warning("Connection error on attempt %d/%d: %s", attempt, MAX_RETRIES, exc)

        if attempt < MAX_RETRIES:
            logger.info("Retrying in %.1fs", backoff)
            time.sleep(backoff)
            backoff = min(backoff * 2, 30)

    logger.error("Failed to submit scan for plate=%s after %d attempts", plate, MAX_RETRIES)
    return False


def _example_detection_source():
    """
    Replace this with your real EdgeTPU inference queue, e.g.:
        while True:
            plate, confidence = detection_queue.get()
            yield plate, confidence
    """
    test_plates = [("ABC123", 0.95), ("XYZ789", 0.88)]
    for plate, conf in test_plates:
        yield plate, conf
        time.sleep(2)


if __name__ == "__main__":
    logger.info("P3 scanner starting — env=%s url=%s location=%s", ENV, BASE_URL, LOCATION)
    for plate, confidence in _example_detection_source():
        post_scan(plate, confidence)
