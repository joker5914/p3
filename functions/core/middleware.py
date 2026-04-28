"""
core/middleware.py — request-scoped context used by the audit logger.

FastAPI runs each request inside its own asyncio Task, which is a fresh
context-variable scope by default.  We latch IP, user-agent, and a
per-request correlation id onto that scope here; anywhere else in the
codebase can pull them via ``core.audit.get_request_context()`` without
threading the ``Request`` object through every function signature.

Why a custom middleware instead of Depends(Request)?  The audit logger
is called from places far below the route handler — service modules,
Firestore helpers, background tasks spawned inside a request — where
injecting the Request is awkward.  ContextVar keeps the surface clean.
"""
from __future__ import annotations

import logging
from typing import Callable

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from core.audit import (
    clear_request_context,
    make_correlation_id,
    set_request_context,
)

logger = logging.getLogger(__name__)


def _client_ip(request: Request) -> str:
    """Best-effort client IP.  Cloud Run + the Firebase hosting proxy both
    set ``X-Forwarded-For``; we take the first entry (the original client).
    Falls back to the socket peer when no proxy header is present."""
    xff = request.headers.get("x-forwarded-for", "")
    if xff:
        # XFF is a comma-separated chain: "client, proxy1, proxy2" — the
        # leftmost untrusted entry is the real client.  Strip whitespace
        # around the first token.
        return xff.split(",", 1)[0].strip()
    real_ip = request.headers.get("x-real-ip", "").strip()
    if real_ip:
        return real_ip
    try:
        return request.client.host if request.client else ""
    except Exception:
        return ""


class AuditContextMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        correlation_id = (
            request.headers.get("x-correlation-id")
            or request.headers.get("x-request-id")
            or make_correlation_id()
        )
        set_request_context(
            ip=_client_ip(request),
            user_agent=request.headers.get("user-agent", "")[:512],  # cap to prevent abuse
            correlation_id=correlation_id,
            method=request.method,
            path=request.url.path,
        )
        try:
            response = await call_next(request)
        finally:
            # Starlette reuses worker tasks via connection pooling — not
            # strictly required with ContextVar semantics, but a clean
            # slate at the end of each request is cheap insurance against
            # rare leaks in deeply async code.
            clear_request_context()
        # Echo the correlation id back so clients can reference it when
        # filing a bug or tying frontend logs to backend events.
        response.headers["x-correlation-id"] = correlation_id
        return response
