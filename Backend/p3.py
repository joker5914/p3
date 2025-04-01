import requests
import os
from datetime import datetime
from dotenv import load_dotenv
import logging

# Setup logging
logging.basicConfig(level=logging.INFO)

load_dotenv()

# Clearly named DEV environment variables
BASE_URL = os.getenv("DEV_BACKEND_URL", "http://localhost:8000")
API_TOKEN = os.getenv("DEV_P3_API_TOKEN")

if not API_TOKEN:
    logging.error("DEV_P3_API_TOKEN is missing from .env")
    raise RuntimeError("DEV_P3_API_TOKEN missing in .env")

url = f"{BASE_URL}/api/v1/scan"
headers = {
    "Authorization": f"Bearer {API_TOKEN}",
    "Content-Type": "application/json"
}

data = {
    "plate": "ABC123",
    "timestamp": datetime.utcnow().isoformat(),
    "location": "entry_scanner_1",
    "confidence_score": 0.95
}

try:
    response = requests.post(url, json=data, headers=headers, timeout=5)
    response.raise_for_status()  # Raises HTTPError for bad responses (4xx or 5xx)
    logging.info("✅ Success: %s", response.json())

except requests.exceptions.Timeout:
    logging.error("⏳ Request timed out")
except requests.exceptions.HTTPError as e:
    logging.error("🚨 HTTP error: %s - %s", response.status_code, response.text)
except requests.exceptions.RequestException as e:
    logging.error("🚧 Request failed: %s", e)
