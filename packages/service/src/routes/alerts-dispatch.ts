/**
 * Dispatch for the analytics alerting routes (E2, ADR 0130), extracted the same way as
 * `analytics-dispatch.ts`/`github-dispatch.ts` so `service.ts` stays a thin composition root
 * under the size gate. The three path shapes are mutually exclusive by regex (the item pattern's
 * final `[^/]+$` can never match the `/test` suffix), so dispatch order carries no behavior.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DeployAuthGate } from '@noodle-borg/control-plane/portable';
import type { TlsPosture } from '@noodle-borg/transport-http';
import type { AlertRuleStore } from '../store/alert-rules.js';
import type { AuditSink } from '../store/audit.js';
import type { ControlPlaneStore } from '../store.js';
import { handleAlertRuleDelete, handleAlertRules, handleAlertRuleTest } from './alerts.js';
import {
  parseTenantAlertItemPath,
  parseTenantAlertsPath,
  parseTenantAlertTestPath,
} from './paths.js';

export interface AlertsDispatchDeps {
  readonly gate: DeployAuthGate;
  readonly controlPlane: ControlPlaneStore;
  readonly alertRuleStore: AlertRuleStore;
  readonly audit: AuditSink;
  readonly maxBody: number;
  readonly allowLoopbackWebhooks: boolean;
  readonly applySecurityHeaders: (res: ServerResponse, tls: TlsPosture) => void;
  readonly enforceHttps: (req: IncomingMessage, res: ServerResponse, tls: TlsPosture) => boolean;
  readonly sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  readonly tls: TlsPosture;
  readonly clock?: () => Date;
}

/** Try the alerting routes; returns true when the request was handled (or a guard ended it). */
export function dispatchAlertRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: AlertsDispatchDeps,
): boolean {
  const { applySecurityHeaders, enforceHttps, sendJson, tls } = deps;
  const routeDeps = {
    gate: deps.gate,
    controlPlane: deps.controlPlane,
    store: deps.alertRuleStore,
    audit: deps.audit,
    maxBody: deps.maxBody,
    allowLoopbackWebhooks: deps.allowLoopbackWebhooks,
    ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
  };

  const collectionRef = parseTenantAlertsPath(url.pathname);
  if (collectionRef !== undefined && (req.method === 'GET' || req.method === 'POST')) {
    applySecurityHeaders(res, tls);
    if (enforceHttps(req, res, tls)) return true;
    handleAlertRules(req, res, collectionRef, routeDeps).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    });
    return true;
  }

  const testRef = parseTenantAlertTestPath(url.pathname);
  if (testRef !== undefined && req.method === 'POST') {
    applySecurityHeaders(res, tls);
    if (enforceHttps(req, res, tls)) return true;
    handleAlertRuleTest(req, res, testRef.ref, testRef.id, routeDeps).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    });
    return true;
  }

  const itemRef = parseTenantAlertItemPath(url.pathname);
  if (itemRef !== undefined && req.method === 'DELETE') {
    applySecurityHeaders(res, tls);
    if (enforceHttps(req, res, tls)) return true;
    handleAlertRuleDelete(req, res, itemRef.ref, itemRef.id, routeDeps).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    });
    return true;
  }

  return false;
}
