/** Tests ship with the Python profile and run through the customer's existing Django test runner. */
export function djangoContractTests(): string {
  return `import json
from unittest.mock import Mock, patch

import requests
from django.test import Client, SimpleTestCase, override_settings


@override_settings(
    ROOT_URLCONF="noodle_assistant.urls", ALLOWED_HOSTS=["app.example"],
    MIDDLEWARE=["django.middleware.csrf.CsrfViewMiddleware"],
    PUBLIC_APP_ORIGIN="https://app.example", NOODLE_SERVICE_URL="https://cloud.example",
    NOODLE_ASSISTANT_CLIENT_ID="synthetic-client", NOODLE_ASSISTANT_CLIENT_SECRET="synthetic-test-credential",
)
class AssistantSessionContractTests(SimpleTestCase):
    """Synthetic route proof. Add real session/membership fixtures in the application's own suite."""

    def setUp(self):
        self.client = Client(enforce_csrf_checks=True)
        self.csrf = "a" * 32
        self.client.cookies["csrftoken"] = self.csrf
        self.identity_patch = patch("noodle_assistant.views.authenticate_assistant_request", return_value=None)
        self.authenticate = self.identity_patch.start()
        self.addCleanup(self.identity_patch.stop)
        self.exchange_patch = patch("noodle_assistant.views.requests.post")
        self.exchange = self.exchange_patch.start()
        self.addCleanup(self.exchange_patch.stop)
        self.session = {
            "token": "synthetic-session", "expiresAt": "2030-01-01T00:00:00Z",
            "endpoints": {"turns": "https://cloud.example/turns", "toolConfirmations": "https://cloud.example/confirmations"},
        }
        upstream = Mock(status_code=201)
        upstream.iter_content.return_value = [json.dumps(self.session).encode()]
        self.upstream = upstream
        self.exchange.return_value.__enter__.return_value = upstream

    def post(self, body=None, **headers):
        defaults = {"HTTP_HOST": "app.example", "HTTP_ORIGIN": "https://app.example", "HTTP_X_CSRFTOKEN": self.csrf}
        defaults.update(headers)
        return self.client.post("/api/assistant/session", json.dumps({} if body is None else body), content_type="application/json", secure=True, **defaults)

    def signed_in(self):
        self.authenticate.return_value = {
            "user": {"id": "person-a", "tenant": "tenant-a", "scopes": ["tasks:read"]},
            "routing": {"endpoints": {"customer_api": "https://tenant-a.example/api"}},
        }

    def test_signed_out_is_json_401_not_redirect(self):
        response = self.post()
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["code"], "authentication_required")
        self.assertNotIn("Location", response)
        self.assertEqual(response["Cache-Control"], "no-store")
        self.exchange.assert_not_called()

    def test_csrf_is_not_exempted(self):
        self.assertEqual(self.post(HTTP_X_CSRFTOKEN="").status_code, 403)
        self.authenticate.assert_not_called()
        self.exchange.assert_not_called()

    def test_wrong_origin_is_refused_before_identity_or_exchange(self):
        self.assertEqual(self.post(HTTP_ORIGIN="https://attacker.example").status_code, 403)
        self.authenticate.assert_not_called()
        self.exchange.assert_not_called()

    def test_form_content_type_is_refused(self):
        response = self.client.post("/api/assistant/session", "{}", content_type="text/plain", secure=True,
            HTTP_HOST="app.example", HTTP_ORIGIN="https://app.example", HTTP_X_CSRFTOKEN=self.csrf)
        self.assertEqual(response.status_code, 415)
        self.exchange.assert_not_called()

    def test_browser_cannot_choose_identity_or_routes(self):
        self.signed_in()
        for body in ({"user": {"id": "person-b"}}, {"routing": {}}, {"claims": {"admin": True}},
                     {"context": {"nested": {}}}, {"context": {"number": float("inf")}},
                     {"context": {"number": 10 ** 1_000}}, {"context": {"text": "x" * 2_001}}):
            with self.subTest(body_kind=next(iter(body))):
                self.assertEqual(self.post(body).status_code, 400)
        self.exchange.assert_not_called()

    def test_body_limit(self):
        self.signed_in()
        self.assertEqual(self.post({"context": {"page": "x" * 16_384}}).status_code, 413)
        self.exchange.assert_not_called()

    def test_deep_json_is_refused_without_a_server_error(self):
        self.signed_in()
        nested = "[" * 3_000 + "0" + "]" * 3_000
        response = self.client.post("/api/assistant/session", nested, content_type="application/json", secure=True,
            HTTP_HOST="app.example", HTTP_ORIGIN="https://app.example", HTTP_X_CSRFTOKEN=self.csrf)
        self.assertEqual(response.status_code, 400)
        self.exchange.assert_not_called()
        self.upstream.iter_content.return_value = [nested.encode()]
        self.assertEqual(self.post().status_code, 502)
        # Older supported Python parsers can exhaust recursion before reaching the byte limit.
        with patch("noodle_assistant.views.json.loads", side_effect=RecursionError):
            self.assertEqual(self.post().status_code, 400)
        with patch("noodle_assistant.views.json.loads", side_effect=[{}, RecursionError()]):
            self.assertEqual(self.post().status_code, 502)

    def test_success_uses_backend_identity_without_forwarding_cookies(self):
        self.signed_in()
        response = self.post({"context": {"page": "tasks"}}, HTTP_AUTHORIZATION="Bearer synthetic-inbound")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), self.session)
        self.assertEqual(response["Cache-Control"], "no-store")
        sent = self.exchange.call_args.kwargs
        self.assertEqual(sent["json"]["user"]["tenant"], "tenant-a")
        self.assertEqual(sent["json"]["routing"], self.authenticate.return_value["routing"])
        self.assertFalse(sent["allow_redirects"])
        self.assertEqual(sent["timeout"], (3, 10))
        self.assertNotIn("synthetic-inbound", str(sent))
        self.assertNotIn("Cookie", sent["headers"])

    def test_exchange_failure_is_sanitized(self):
        self.signed_in()
        self.exchange.side_effect = requests.Timeout("private upstream details")
        response = self.post()
        self.assertEqual(response.status_code, 502)
        self.assertNotIn(b"private", response.content)
        self.exchange.assert_called_once()

    def test_redirect_and_html_are_not_forwarded(self):
        self.signed_in()
        self.upstream.status_code = 302
        self.assertEqual(self.post().status_code, 502)
        self.upstream.status_code = 200
        self.upstream.iter_content.return_value = [b"<html>private upstream details</html>"]
        self.assertEqual(self.post().status_code, 502)

    def test_missing_configuration_and_identity_failure_are_not_signed_out(self):
        with override_settings(NOODLE_ASSISTANT_CLIENT_SECRET=""):
            self.assertEqual(self.post().status_code, 503)
        self.authenticate.side_effect = RuntimeError("private identity failure")
        self.assertEqual(self.post().status_code, 503)
        self.exchange.assert_not_called()
`;
}
