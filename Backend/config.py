"""
Dismissal — central configuration.
All environment variables and global constants live here.
Import from this module instead of calling os.getenv() directly in handlers.
"""
import logging
import os

from dotenv import load_dotenv

load_dotenv()

ENV = os.getenv("ENV", "development")

if ENV == "production":
    BACKEND_URL = (os.getenv("VITE_PROD_BACKEND_URL") or "").strip().rstrip("/")
    FRONTEND_URL = (os.getenv("VITE_PROD_FRONTEND_URL") or "").strip().rstrip("/")
else:
    BACKEND_URL = os.getenv("VITE_DEV_BACKEND_URL", "http://localhost:8000")
    FRONTEND_URL = os.getenv("VITE_DEV_FRONTEND_URL", "http://localhost:5173")

DEVICE_TIMEZONE = os.getenv("DEVICE_TIMEZONE", "America/New_York")
DEV_SCHOOL_ID = os.getenv("DEV_SCHOOL_ID", "dev_school")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)
