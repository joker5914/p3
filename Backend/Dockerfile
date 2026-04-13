FROM python:3.11-slim

# Run as non-root — Cloud Run security best practice
RUN groupadd -r dismissal && useradd -r -g dismissal -d /app -s /sbin/nologin dismissal

WORKDIR /app

COPY requirements-server.txt .
RUN pip install --no-cache-dir -r requirements-server.txt

COPY . .

RUN chown -R dismissal:dismissal /app

USER dismissal

# Respect $PORT injected by Cloud Run; fall back to 8080 for local dev
CMD ["sh", "-c", "uvicorn main:app --host=0.0.0.0 --port=${PORT:-8080}"]
