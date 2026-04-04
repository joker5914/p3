FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Respect $PORT injected by Cloud Run; fall back to 8080 for local dev
CMD ["sh", "-c", "uvicorn server:app --host=0.0.0.0 --port=${PORT:-8080}"]
