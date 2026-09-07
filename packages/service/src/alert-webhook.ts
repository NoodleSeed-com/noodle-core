import { isIP } from 'node:net';
import { type DnsLookup, guardedFetch, isPublicUnicast } from '@noodle-borg/connector-http';
import type { AlertMetric, AlertRuleRecord } from './store/alert-rules.js';

/**
 * Alert webhook delivery (E2, ADR 0130): a single POST attempt with a bounded timeout through the
 * shared SSRF guard (`guardedFetch` pins DNS resolutions to public unicast addresses — the same
 * anti-rebinding layer the HTTP connector uses). No retries, no backoff queue (deferred to E3).
 *
 * The webhook URL is SENSITIVE (it may embed capability tokens). Nothing this module returns or
 * throws carries the URL, its host, or an upstream error message: outcomes are closed-vocabulary
 * reason codes plus the HTTP status, safe to log verbatim.
 */

export const ALERT_WEBHOOK_SCHEMA_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 10_000;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export interface AlertWebhookPayload {
  readonly schemaVersion: typeof ALERT_WEBHOOK_SCHEMA_VERSION;
  readonly event: 'breach' | 'test';
  readonly org: string;
  readonly app: string;
  readonly env: string;
  readonly rule: {
    readonly id: string;
    readonly name?: string;
    readonly metric: AlertMetric;
    readonly threshold: number;
    readonly windowMinutes: number;
    readonly comparison: '>=';
  };
  readonly observed: number;
  readonly firedAt: string;
}

export function buildAlertWebhookPayload(
  rule: AlertRuleRecord,
  event: 'breach' | 'test',
  observed: number,
  firedAt: string,
): AlertWebhookPayload {
  return {
    schemaVersion: ALERT_WEBHOOK_SCHEMA_VERSION,
    event,
    org: rule.orgSlug,
    app: rule.appSlug,
    env: rule.environment,
    rule: {
      id: rule.id,
      ...(rule.name !== undefined ? { name: rule.name } : {}),
      metric: rule.metric,
      threshold: rule.threshold,
      windowMinutes: rule.windowMinutes,
      comparison: rule.comparison,
    },
    observed,
    firedAt,
  };
}

/** Closed-vocabulary outcome — safe to log and to return to callers (never carries the URL). */
export interface AlertWebhookDelivery {
  readonly delivered: boolean;
  readonly status?: number;
  readonly reason?: 'invalid_url' | 'egress_blocked' | 'timeout' | 'network_error' | 'http_error';
}

export interface WebhookUrlPolicy {
  /**
   * Development/test-only carve-out: allow `http://localhost`, `http://127.0.0.1`, and `[::1]`
   * targets (mirrors `customerVerifierAllowInsecureLocalhost`). Off in production: webhooks are
   * https-only and literal private/reserved IPs are rejected outright.
   */
  readonly allowLoopback: boolean;
}

export type WebhookUrlValidation = { ok: true; url: URL } | { ok: false; error: string };

/**
 * Policy validation for a webhook URL, applied at rule create/test time AND re-applied on every
 * delivery (defense in depth for stored rules). Error messages are generic policy text — they
 * never echo the URL, host, or credentials back.
 */
export function validateAlertWebhookUrl(
  raw: string,
  policy: WebhookUrlPolicy,
): WebhookUrlValidation {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: '"webhookUrl" must be a valid absolute URL' };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, error: '"webhookUrl" must not embed credentials' };
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const loopback = LOOPBACK_HOSTS.has(host);
  if (url.protocol === 'http:') {
    if (loopback && policy.allowLoopback) return { ok: true, url };
    return {
      ok: false,
      error:
        '"webhookUrl" must use https (plain http is allowed only for loopback targets outside production)',
    };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, error: '"webhookUrl" must use https' };
  }
  if (loopback) {
    return policy.allowLoopback
      ? { ok: true, url }
      : { ok: false, error: '"webhookUrl" must not target a loopback address' };
  }
  // Literal IPs carry no DNS step for the delivery-time guard to pin, so they are policy-checked
  // here: only public unicast addresses are accepted (blocks 10/8, 172.16/12, 192.168/16,
  // link-local incl. the cloud metadata address, and other reserved ranges).
  if (isIP(host) !== 0 && !isPublicUnicast(host)) {
    return { ok: false, error: '"webhookUrl" must not target a private or reserved IP address' };
  }
  return { ok: true, url };
}

export interface DeliverAlertWebhookOptions {
  readonly allowLoopback?: boolean;
  /** Whole-attempt bound. Default 10s. */
  readonly timeoutMs?: number;
  /** Injectable DNS resolver for SSRF tests (threaded into the guarded agent). */
  readonly lookup?: DnsLookup;
}

/**
 * Single-attempt webhook POST. Loopback targets (dev carve-out) use the plain platform fetch —
 * the pinned lookup would reject loopback resolutions by design; everything else goes through
 * {@link guardedFetch}. Redirects are not followed (a redirect could re-point the request at an
 * unguarded literal-IP target); a 3xx reports as an ordinary non-2xx outcome.
 */
export async function deliverAlertWebhook(
  rawUrl: string,
  payload: AlertWebhookPayload,
  options: DeliverAlertWebhookOptions = {},
): Promise<AlertWebhookDelivery> {
  const validated = validateAlertWebhookUrl(rawUrl, {
    allowLoopback: options.allowLoopback === true,
  });
  if (!validated.ok) return { delivered: false, reason: 'invalid_url' };
  const init: RequestInit = {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'user-agent': 'noodleseed-alerts/1',
    },
    body: JSON.stringify(payload),
    redirect: 'manual',
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  };
  const host = validated.url.hostname.replace(/^\[|\]$/g, '');
  try {
    const response = LOOPBACK_HOSTS.has(host)
      ? await fetch(validated.url, init)
      : await guardedFetch(validated.url, init, {
          ...(options.timeoutMs !== undefined ? { connectTimeoutMs: options.timeoutMs } : {}),
          ...(options.lookup !== undefined ? { lookup: options.lookup } : {}),
        });
    // Drain/cancel the body — the response content is untrusted and unbounded; only the status matters.
    try {
      await response.body?.cancel();
    } catch {
      // ignore: some bodies are already consumed/closed
    }
    if (response.ok) return { delivered: true, status: response.status };
    return { delivered: false, status: response.status, reason: 'http_error' };
  } catch (error) {
    return { delivered: false, reason: classifyDeliveryError(error) };
  }
}

/** Map a fetch failure to a closed reason code — upstream messages may embed the URL/host. */
function classifyDeliveryError(error: unknown): 'egress_blocked' | 'timeout' | 'network_error' {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'timeout';
    if (error.message.startsWith('egress blocked:')) return 'egress_blocked';
    const cause = error.cause;
    if (cause instanceof Error && cause.message.startsWith('egress blocked:')) {
      return 'egress_blocked';
    }
    if (cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError')) {
      return 'timeout';
    }
  }
  return 'network_error';
}
