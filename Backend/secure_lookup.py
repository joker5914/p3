import os
from dotenv import load_dotenv

load_dotenv()  # <--- this should be here

import hashlib
from cryptography.fernet import Fernet
import base64

# Load encryption key from environment variable
ENCRYPTION_KEY = os.getenv("P3_ENCRYPTION_KEY")
if not ENCRYPTION_KEY:
    raise RuntimeError("Missing encryption key in environment (P3_ENCRYPTION_KEY)")

try:
    assert len(base64.urlsafe_b64decode(ENCRYPTION_KEY.encode())) == 32
except Exception:
    raise RuntimeError("P3_ENCRYPTION_KEY must be a valid 32-byte base64-encoded string")

fernet = Fernet(ENCRYPTION_KEY.encode())

# Tokenize plate number (one-way hash for lookup)
def tokenize_plate(plate: str) -> str:
    return hashlib.sha256(plate.encode()).hexdigest()

def encrypt_string(plaintext: str) -> str:
    return fernet.encrypt(plaintext.encode()).decode()

def decrypt_string(ciphertext: str) -> str:
    return fernet.decrypt(ciphertext.encode()).decode()
