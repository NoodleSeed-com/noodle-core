/**
 * Dispatch for the tenant analytics READ surface (metrics, events, session detail). Extracted
 * verbatim from `service.ts` (which stays a thin composition root under the size gate), keeping the
 * file's uniform parse → security headers → https guard → handler → catch-500 shape plus the
 * 409 "requires a configured event store" precondition each analytics route shares.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DeployAuthGate } from '@noodle-borg/control-plane/portable';
import type { RequestEventStore } from '@noodle-borg/module';
import type { TlsPosture } from '@noodle-borg/transport-http';
import type { DeveloperGrantStore } from '../oauth/developer-grant.js';
import type { ControlPlaneStore } from '../store.js';
import { handleTenantEvents, handleTenantMetrics, handleTenantSession } from './analytics.js';
import { handleTenantAssistantUsage } from './assistant-usage.js';
import {
  parseTenantAssistantUsagePath,
  parseTenantEventsPath,
  parseTenantMetricsPath,
  parseTenantSessionPath,
} from './paths.js';

export interface AnalyticsDispatchDeps {
  readonly gate: DeployAuthGate;
  readonly controlPlane: ControlPlaneStore;
  readonly requestEventStore: RequestEventStore | undefined;
  readonly applySecurityHeaders: (res: ServerResponse, tls: TlsPosture) => void;
  readonly enforceHttps: (req: IncomingMessage, res: ServerResponse, tls: TlsPosture) => boolean;
  readonly sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  readonly tls: TlsPosture;
  readonly developerGrantStore: DeveloperGrantStore | undefined;
}

/** Try the analytics read routes; returns true when the request was handled (or a guard ended it). */
export function dispatchAnalyticsReads(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: AnalyticsDispatchDeps,
): boolean {
  const {
    gate,
    controlPlane,
    requestEventStore,
    applySecurityHeaders,
    enforceHttps,
    sendJson,
    tls,
    developerGrantStore,
  } = deps;

  const assistantUsageRef = parseTenantAssistantUsagePath(url.pathname);
  if (assistantUsageRef !== undefined && req.method === 'GET') {
    applySecurityHeaders(res, tls);
    if (enforceHttps(req, res, tls)) return true;
    if (requestEventStore === undefined) {
      sendJson(res, 409, { ok: false, error: 'assistant usage requires a configured event store' });
      return true;
    }
    handleTenantAssistantUsage(
      req,
      res,
      gate,
      controlPlane,
      requestEventStore,
      assistantUsageRef,
      url,
      developerGrantStore,
    ).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    });
    return true;
  }

  const metricsRef = parseTenantMetricsPath(url.pathname);
  if (metricsRef !== undefined && req.method === 'GET') {
    applySecurityHeaders(res, tls);
    if (enforceHttps(req, res, tls)) return true;
    if (requestEventStore === undefined) {
      sendJson(res, 409, { ok: false, error: 'metrics require a configured event store' });
      return true;
    }
    handleTenantMetrics(
      req,
      res,
      gate,
      controlPlane,
      requestEventStore,
      metricsRef,
      url,
      developerGrantStore,
    ).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    });
    return true;
  }
  const eventsRef = parseTenantEventsPath(url.pathname);
  if (eventsRef !== undefined && req.method === 'GET') {
    applySecurityHeaders(res, tls);
    if (enforceHttps(req, res, tls)) return true;
    if (requestEventStore === undefined) {
      sendJson(res, 409, { ok: false, error: 'events require a configured event store' });
      return true;
    }
    handleTenantEvents(
      req,
      res,
      gate,
      controlPlane,
      requestEventStore,
      eventsRef,
      url,
      developerGrantStore,
    ).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    });
    return true;
  }
  const sessionRef = parseTenantSessionPath(url.pathname);
  if (sessionRef !== undefined && req.method === 'GET') {
    applySecurityHeaders(res, tls);
    if (enforceHttps(req, res, tls)) return true;
    if (requestEventStore === undefined) {
      sendJson(res, 409, { ok: false, error: 'sessions require a configured event store' });
      return true;
    }
    handleTenantSession(
      req,
      res,
      gate,
      controlPlane,
      requestEventStore,
      sessionRef.ref,
      sessionRef.sessionId,
      developerGrantStore,
    ).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    });
    return true;
  }
  return false;
}
