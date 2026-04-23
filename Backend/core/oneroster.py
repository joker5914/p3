"""
core/oneroster.py — OneRoster 1.2 REST client.

OneRoster is the IMS Global / 1EdTech interchange spec used by PowerSchool,
Infinite Campus, Skyward, Synergy, Aeries, and every other mainstream K-12
SIS.  A client that speaks this spec covers ~80% of US districts with a
single implementation.

Auth
----
The spec allows OAuth2 Client Credentials.  We hit ``{endpoint}/token``
(the conventional path used by most SIS vendors; some use
``/oauth/token``) with ``grant_type=client_credentials`` and Basic auth
built from ``client_id:client_secret``.  The access token is cached in
memory for its advertised ``expires_in`` window, refreshed lazily on 401.

Pagination
----------
OneRoster pages via ``?limit=<n>&offset=<n>``.  We iterate until the
server returns fewer rows than the limit.  Responses may also carry
``X-Total-Count`` and ``Link`` headers, but not every implementation is
consistent — counting rows yields the same stop condition.

Delta sync
----------
Pass ``?filter=dateLastModified>'<ISO8601>'`` (OneRoster filter syntax —
yes, single-quoted) to pull only records changed since the last sync.
On the first sync for a district, ``since`` is None and we pull
everything.

Rate limiting
-------------
HTTP 429 → sleep for ``Retry-After`` seconds (falling back to an
exponential backoff) and retry up to a few times.  OneRoster servers
rarely rate-limit but the logic is here so we don't die on a district's
over-enthusiastic firewall.

Intentionally out of scope
--------------------------
* Write-back (PUT/POST) — the spec allows it but we're one-way today.
* ``/academicSessions``, ``/classes``, ``/enrollments`` — not needed for
  pickup; easy to add later using the same request pattern.
* Streaming bulk exports — the OAS-like bulk endpoint exists but has
  spotty support; pagination is the compatible path.
"""
from __future__ import annotations

import base64
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, Iterator, List, Optional

import requests

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------

class OneRosterError(Exception):
    """Base class for all OneRoster client failures."""


class OneRosterAuthError(OneRosterError):
    """OAuth2 token exchange failed — wrong credentials or a disabled
    OAuth2 client on the SIS side.  Surfaced by the wizard's Test
    Connection button as a user-facing error."""


class OneRosterRequestError(OneRosterError):
    """A data request (GET /users etc.) failed after retries."""


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------

@dataclass
class _Token:
    access_token: str
    expires_at:   datetime   # absolute UTC expiry


class OneRosterClient:
    """Thin, test-friendly OneRoster 1.2 client.

    Usage::

        client = OneRosterClient(
            endpoint="https://district.powerschool.com/ims/oneroster/v1p2",
            client_id="...",
            client_secret="...",
        )
        for user in client.fetch_users(role="student", since=last_sync):
            ...
    """

    # Default page size — large enough to be efficient, small enough that
    # a single hung page doesn't stall the whole sync.
    DEFAULT_LIMIT = 200

    # Timeouts — separate connect + read timeouts so a slow SIS doesn't
    # pin a thread forever.
    CONNECT_TIMEOUT_S = 10
    READ_TIMEOUT_S    = 60

    # Retry budget for data requests.  Auth failures don't retry here —
    # they fail fast and the caller surfaces the error.
    MAX_RETRIES       = 3

    def __init__(
        self,
        endpoint:      str,
        client_id:     str,
        client_secret: str,
        session:       Optional[requests.Session] = None,
    ):
        self.endpoint      = endpoint.rstrip("/")
        self.client_id     = client_id
        self.client_secret = client_secret
        self._session      = session or requests.Session()
        self._token: Optional[_Token] = None

    # ── Auth ────────────────────────────────────────────────────────────

    def _token_url(self) -> str:
        """Most SIS vendors serve the token endpoint as a sibling of the
        IMS path (``/oneroster/v1p2`` → ``/token``).  A handful (notably
        PowerSchool before their 2023 update) host it under ``/oauth/token``.
        We try the conventional path first and fall back once on 404.
        """
        # Conventional: strip the trailing OneRoster path component and
        # append /token at the parent.
        if "/oneroster/" in self.endpoint:
            base = self.endpoint.split("/ims/oneroster/", 1)[0]
            return f"{base}/oauth/token"
        return f"{self.endpoint}/oauth/token"

    def _fetch_token(self) -> _Token:
        """Exchange client credentials for a bearer token."""
        auth = base64.b64encode(
            f"{self.client_id}:{self.client_secret}".encode()
        ).decode()
        headers = {
            "Authorization": f"Basic {auth}",
            "Content-Type":  "application/x-www-form-urlencoded",
            "Accept":        "application/json",
        }
        data = {"grant_type": "client_credentials", "scope": "roster-core.readonly"}

        url = self._token_url()
        try:
            r = self._session.post(
                url, headers=headers, data=data,
                timeout=(self.CONNECT_TIMEOUT_S, self.READ_TIMEOUT_S),
            )
        except requests.RequestException as exc:
            raise OneRosterAuthError(
                f"Token request to {url} failed: {exc}"
            ) from exc

        if r.status_code == 404:
            # Fall back to the alternate path for older PowerSchool
            # deployments.
            alt_url = url.replace("/oauth/token", "/token")
            if alt_url != url:
                try:
                    r = self._session.post(
                        alt_url, headers=headers, data=data,
                        timeout=(self.CONNECT_TIMEOUT_S, self.READ_TIMEOUT_S),
                    )
                except requests.RequestException as exc:
                    raise OneRosterAuthError(f"Token request to {alt_url} failed: {exc}") from exc

        if r.status_code >= 400:
            # Surface the server's error body if present — most SIS
            # vendors return a useful JSON ``error_description``.
            detail = ""
            try:
                detail = r.json().get("error_description") or r.json().get("error") or r.text[:200]
            except Exception:
                detail = r.text[:200]
            raise OneRosterAuthError(
                f"OAuth token exchange failed ({r.status_code}): {detail}"
            )

        try:
            body = r.json()
        except ValueError as exc:
            raise OneRosterAuthError(f"Token response was not JSON: {r.text[:200]}") from exc

        access_token = body.get("access_token")
        expires_in   = int(body.get("expires_in", 3600))
        if not access_token:
            raise OneRosterAuthError("Token response missing access_token")

        # Knock 30s off the advertised expiry so we rotate before the
        # server starts rejecting — avoids a race on long syncs.
        expires_at = datetime.now(timezone.utc).replace(microsecond=0)
        expires_at = expires_at.fromtimestamp(expires_at.timestamp() + max(60, expires_in - 30), tz=timezone.utc)
        return _Token(access_token=access_token, expires_at=expires_at)

    def _auth_headers(self) -> Dict[str, str]:
        if self._token is None or self._token.expires_at <= datetime.now(timezone.utc):
            self._token = self._fetch_token()
        return {
            "Authorization": f"Bearer {self._token.access_token}",
            "Accept":        "application/json",
        }

    # ── Public API ──────────────────────────────────────────────────────

    def test_connection(self) -> Dict[str, Any]:
        """Used by the wizard's Test Connection button.  Returns a
        dict describing the server's response so the UI can show
        "connected; 2,847 students found" or the specific error."""
        try:
            # Fetch one student with limit=1 — cheapest possible probe
            # that exercises both the token exchange and the user query.
            r = self._get(
                "/users",
                params={"filter": "role='student'", "limit": 1, "offset": 0},
            )
            total = r.headers.get("X-Total-Count")
            body  = r.json()
            user_count = body.get("totalCount")
            if user_count is None and total is not None:
                try:
                    user_count = int(total)
                except ValueError:
                    user_count = None
            return {
                "ok": True,
                "student_count": user_count,
                "endpoint": self.endpoint,
            }
        except OneRosterAuthError as exc:
            return {"ok": False, "error_type": "auth", "message": str(exc)}
        except OneRosterError as exc:
            return {"ok": False, "error_type": "request", "message": str(exc)}

    def fetch_users(
        self,
        role:  str,
        since: Optional[datetime] = None,
        org_sourced_id: Optional[str] = None,
    ) -> Iterator[Dict[str, Any]]:
        """Yield every user matching ``role`` (``student`` or ``parent``).

        Transparently paginates.  Accepts ``since`` for delta syncs —
        the caller passes the last successful sync timestamp.
        """
        filter_parts: List[str] = [f"role='{role}'"]
        if since is not None:
            # OneRoster filters use single quotes around the value,
            # with ISO-8601 timestamps in UTC.
            iso = since.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
            filter_parts.append(f"dateLastModified>'{iso}'")
        if org_sourced_id:
            filter_parts.append(f"orgSourcedId='{org_sourced_id}'")
        flt = " AND ".join(filter_parts)

        offset = 0
        while True:
            r = self._get(
                "/users",
                params={"filter": flt, "limit": self.DEFAULT_LIMIT, "offset": offset},
            )
            body  = r.json()
            # The 1.2 spec wraps results as {users: [...]} but some
            # vendors wrap as {data: [...]} or return a bare array.
            users = body.get("users") or body.get("data") or (body if isinstance(body, list) else [])
            if not users:
                return
            for u in users:
                yield u
            if len(users) < self.DEFAULT_LIMIT:
                return
            offset += self.DEFAULT_LIMIT

    # ── Internal ────────────────────────────────────────────────────────

    def _get(self, path: str, params: Optional[Dict[str, Any]] = None) -> requests.Response:
        """GET with retry-on-429 and one-shot retry-on-401 (token refresh)."""
        url = f"{self.endpoint}{path}"
        attempt = 0
        refreshed_on_401 = False
        while True:
            attempt += 1
            try:
                r = self._session.get(
                    url,
                    headers=self._auth_headers(),
                    params=params,
                    timeout=(self.CONNECT_TIMEOUT_S, self.READ_TIMEOUT_S),
                )
            except requests.RequestException as exc:
                if attempt >= self.MAX_RETRIES:
                    raise OneRosterRequestError(f"GET {url} failed: {exc}") from exc
                time.sleep(self._backoff_seconds(attempt))
                continue

            if r.status_code == 401 and not refreshed_on_401:
                # Token expired mid-sync — refresh once, retry once.
                self._token = None
                refreshed_on_401 = True
                continue

            if r.status_code == 429 and attempt < self.MAX_RETRIES:
                delay = self._retry_after(r) or self._backoff_seconds(attempt)
                logger.info("OneRoster 429 on %s; sleeping %.1fs", url, delay)
                time.sleep(delay)
                continue

            if r.status_code >= 400:
                raise OneRosterRequestError(
                    f"GET {url} → {r.status_code}: {r.text[:200]}"
                )

            return r

    @staticmethod
    def _retry_after(r: requests.Response) -> Optional[float]:
        raw = r.headers.get("Retry-After")
        if not raw:
            return None
        try:
            return max(0.5, float(raw))
        except ValueError:
            return None

    @staticmethod
    def _backoff_seconds(attempt: int) -> float:
        # 0.5s, 1.5s, 3.5s — capped, jitter-free for deterministic tests.
        return (2 ** (attempt - 1)) * 0.5 + 0.5
