import { djangoContractTests } from './assistant-embed-django-tests.js';
import { vueEmbedFiles } from './assistant-embed-vue.js';

/** Python infrastructure is delivered as reviewed source, not a new runtime package or identity bridge. */
export function djangoEmbedFiles(): Record<string, string> {
  return {
    'noodle_assistant/__init__.py': '',
    'noodle_assistant/auth.py': `from django.http import HttpRequest

from .contracts import AssistantIdentity


def authenticate_assistant_request(request: HttpRequest) -> AssistantIdentity | None:
    """The sole backend seam: use the existing session and server-owned membership lookup."""
    # Return None when signed out. Derive user, tenant, roles, scopes and routing server-side.
    # Never trust browser JSON, a raw cookie, or a user-selected URL as verified identity/routing.
    # Do not redirect or log cookies/credentials. An unavailable identity service should raise.
    return None
`,
    'noodle_assistant/contracts.py': `from typing import TypedDict


class RequiredUser(TypedDict):
    id: str


class AssistantUser(RequiredUser, total=False):
    email: str
    name: str
    tenant: str
    roles: list[str]
    scopes: list[str]


class RequiredIdentity(TypedDict):
    user: AssistantUser


class AssistantIdentity(RequiredIdentity, total=False):
    claims: dict[str, str | int | float | bool | None]
    preferences: dict[str, str]
    routing: dict[str, dict[str, str]]
`,
    'noodle_assistant/views.py': `import json
import math
from urllib.parse import urlsplit

import requests
from django.conf import settings
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_protect

from .auth import authenticate_assistant_request

MAX_BODY_BYTES = 16 * 1024
MAX_RESPONSE_BYTES = 256 * 1024


def failure(status, code, message):
    response = JsonResponse({"code": code, "error": message}, status=status)
    response["Cache-Control"] = "no-store"
    return response


def safe_origin(value):
    if not isinstance(value, str) or any(ord(char) <= 32 or ord(char) == 127 for char in value):
        return False
    try:
        url = urlsplit(value)
        return (
            bool(url.hostname) and "*" not in value and url.username is None
            and url.password is None and url.port != 0
            and value == f"{url.scheme}://{url.netloc}"
            and (url.scheme == "https" or (
                url.scheme == "http" and url.hostname in ("localhost", "127.0.0.1", "::1")
            ))
        )
    except ValueError:
        return False


def configuration():
    names = ("PUBLIC_APP_ORIGIN", "NOODLE_SERVICE_URL", "NOODLE_ASSISTANT_CLIENT_ID", "NOODLE_ASSISTANT_CLIENT_SECRET")
    values = [getattr(settings, name, None) for name in names]
    if not all(isinstance(value, str) and value.strip() for value in values):
        return None
    origin, service, client_id, client_secret = values
    service = service.rstrip("/")
    if not safe_origin(origin) or not safe_origin(service) or ":" in client_id:
        return None
    return origin, service, client_id, client_secret


def finite_number(value):
    try:
        return isinstance(value, (int, float)) and math.isfinite(value)
    except OverflowError:
        return False


def valid_context(value):
    return isinstance(value, dict) and len(value) <= 32 and all(
        isinstance(key, str) and len(key) <= 80 and (
            item is None or isinstance(item, bool)
            or finite_number(item)
            or (isinstance(item, str) and len(item) <= 2_000)
        ) for key, item in value.items()
    )


@csrf_protect
def assistant_session(request):
    """Same-origin JSON endpoint. Keep Django's CsrfViewMiddleware enabled."""
    if request.method != "POST":
        response = failure(405, "method_not_allowed", "POST required")
        response["Allow"] = "POST"
        return response
    config = configuration()
    if config is None:
        return failure(503, "assistant_not_configured", "assistant is not configured")
    origin, service, client_id, client_secret = config
    if request.headers.get("Origin") != origin:
        return failure(403, "origin_not_allowed", "origin is not allowed")
    if request.content_type != "application/json":
        return failure(415, "unsupported_media_type", "application/json required")
    try:
        identity = authenticate_assistant_request(request)
    except Exception:
        return failure(503, "authentication_unavailable", "application authentication is unavailable")
    if identity is None:
        return failure(401, "authentication_required", "authentication required")
    if not isinstance(identity, dict) or not isinstance(identity.get("user"), dict):
        return failure(503, "authentication_unavailable", "application authentication is unavailable")
    user_id = identity["user"].get("id")
    if not isinstance(user_id, str) or not 1 <= len(user_id) <= 240:
        return failure(503, "authentication_unavailable", "application authentication is unavailable")
    try:
        raw = request.read(MAX_BODY_BYTES + 1)
        if len(raw) > MAX_BODY_BYTES:
            return failure(413, "request_too_large", "request must not exceed 16 KiB")
        body = json.loads(raw)
    except (ValueError, OSError, RecursionError):
        return failure(400, "invalid_request", "invalid JSON request")
    if not isinstance(body, dict) or set(body) - {"context"}:
        return failure(400, "invalid_request", "invalid request body")
    if "context" in body and not valid_context(body["context"]):
        return failure(400, "invalid_request", "invalid context")
    payload = {"origin": origin, "user": identity["user"]}
    for key in ("claims", "preferences", "routing"):
        if key in identity:
            payload[key] = identity[key]
    if "context" in body:
        payload["context"] = body["context"]
    try:
        # No redirects or retries; inbound cookies/bearers never reach the Noodle exchange.
        with requests.post(
            f"{service}/v1/assistant/sessions", auth=(client_id, client_secret),
            headers={"Accept": "application/json"}, json=payload,
            timeout=(3, 10), allow_redirects=False, stream=True,
        ) as upstream:
            if upstream.status_code not in (200, 201):
                return failure(502, "session_exchange_failed", "assistant session exchange failed")
            data = bytearray()
            for chunk in upstream.iter_content(chunk_size=16 * 1024):
                data.extend(chunk)
                if len(data) > MAX_RESPONSE_BYTES:
                    return failure(502, "session_exchange_failed", "assistant session exchange failed")
            session = json.loads(data)
            if not isinstance(session, dict) or not isinstance(session.get("token"), str) or not isinstance(session.get("endpoints"), dict):
                return failure(502, "session_exchange_failed", "assistant session exchange failed")
    except (requests.RequestException, ValueError, RecursionError):
        return failure(502, "session_exchange_failed", "assistant session exchange failed")
    response = JsonResponse(session)
    response["Cache-Control"] = "no-store"
    return response
`,
    'noodle_assistant/urls.py': `from django.urls import path

from .views import assistant_session

urlpatterns = [path("api/assistant/session", assistant_session, name="noodle-assistant-session")]
`,
    'noodle_assistant/tests.py': djangoContractTests(),
    'noodle_assistant/settings.example.py': `# Merge these names into existing Django settings; use the application's secret/config loader.
# Never copy real credentials into source or expose them to the Vue build.
import os

NOODLE_SERVICE_URL = os.environ.get("NOODLE_SERVICE_URL")
NOODLE_ASSISTANT_CLIENT_ID = os.environ.get("NOODLE_ASSISTANT_CLIENT_ID")
NOODLE_ASSISTANT_CLIENT_SECRET = os.environ.get("NOODLE_ASSISTANT_CLIENT_SECRET")
PUBLIC_APP_ORIGIN = os.environ.get("PUBLIC_APP_ORIGIN")
# Keep django.middleware.csrf.CsrfViewMiddleware and existing authentication middleware enabled.
# Root URL configuration: path("", include("noodle_assistant.urls"))
`,
    '.env.noodle-host.example': `# Backend settings only. Never copy these values into VITE_* or another browser-prefixed variable.
NOODLE_SERVICE_URL=https://cloud.noodleseed.dev
NOODLE_ASSISTANT_CLIENT_ID=
NOODLE_ASSISTANT_CLIENT_SECRET=
PUBLIC_APP_ORIGIN=http://localhost:5173
`,
    ...vueEmbedFiles(),
    'NOODLE-INTEGRATION.md': djangoIntegrationGuide(),
  };
}

export function djangoIntegrationGuide(): string {
  return `# Django/Vue application integration

This profile is authenticated only. The existing Django application owns identity, membership and CSRF;
Vue stays a static frontend. Noodle authoring remains TypeScript in its own project. No Node production
server, new login system or direct database connector is introduced.

## Install and adapt

1. Use the existing Python environment and package manager to add requests. The profile is qualified on
   Django 5.2 and 6.1; use a Python version supported by your Django release. It does not replace application
   settings, middleware or URL configuration. Other versions require your own validation.
2. Include \`noodle_assistant.urls\` at the application root. Map the four names in
   \`noodle_assistant/settings.example.py\` with your existing server-side config loader.
3. Implement only \`authenticate_assistant_request\` in \`noodle_assistant/auth.py\`: return None when signed
   out, otherwise verified user/tenant/scopes, optional claims/preferences and membership-derived routing.
   Keep actual business functions and authorization in the application; never trust browser identity fields.
4. Install a compatible \`@noodleseed/assistant\` using the Vue application's existing package manager.
   Render \`NoodleAssistant.vue\` inside the signed-in application with a stable user/tenant \`principalKey\`
   and the current \`csrfToken\` from your existing CSRF bootstrap. Change the key on account changes.
5. The wrapper sets the element's fetch property before mounting, adding \`X-CSRFToken\` only to the exact
   same-origin session POST. It never sends that header to the Noodle service. Keep Django's normal CSRF
   middleware. If your application uses a custom header name, adapt that one name with a regression test.
6. Route \`/api/assistant/session\` through the Vue page's public origin to Django. Do not enable cross-origin
   cookies or widen trusted origins to make a split infrastructure deployment work.

The wrapper creates the Web Component directly, so Vue needs no custom-element compiler configuration.
For CSRF tokens stored in HttpOnly cookies or server sessions, reuse the application's existing masked-token
endpoint/DOM data. Do not expose an application session cookie or disable CSRF to make the test pass.

## Verify

- Run \`python manage.py test noodle_assistant\`: generated tests enforce CSRF and exercise the real view
  using synthetic identity/exchange fixtures. A signed-out request with a valid CSRF token returns JSON 401;
  an invalid/missing CSRF token is correctly refused by Django before the view.
- Run \`vitest run test/noodle-assistant-transport.test.ts\` using the existing frontend test setup (add
  Vitest as a dev dependency if absent), then build the existing Vue application.
- Run \`noodle assistant embed --framework django-vue --check --json\` with host settings exported. It
  reports static evidence only, not that Django imported settings or proxy rules are correct.
- Add actual signed-out, tenant-A, tenant-B and authorized identity fixtures to the existing test harness;
  exercise one sandbox read and confirmed action. Verify the real browser's CSRF, CSP, streaming and App frame.

Keep the service in CSP connect-src and frame-src. Missing sandbox credentials, identities or permission
remain unverified. Generated tests do not prove the customer's session function or production readiness.

## Updates

Preview with \`noodle assistant embed --framework django-vue --dry-run --json\`. Reruns create missing files
and preserve modified code. Review conflicts; never use --force to erase an existing login implementation.
These files are customer-owned after installation. Keep settings, secret values and business logic during
upgrades and rerun the contract and application acceptance tests before deployment.

Guide: https://docs.noodleseed.dev/docs/guides/embedded-assistant-django-vue
`;
}
