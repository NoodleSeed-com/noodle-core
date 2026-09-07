import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DeployAuthGate } from '@noodle-borg/control-plane/portable';
import type { IntentEventStore, RequestEventStore } from '@noodle-borg/module';
import {
  InMemoryIntentCaptureSettingsStore,
  InMemoryIntentEventStore,
  InMemoryRequestEventStore,
  type IntentCaptureSettingsStore,
} from '@noodle-borg/observability';
import {
  applySecurityHeaders,
  enforceHttps,
  type ServedTarget,
  sendJson,
  type TenantRouteRef,
  type TlsPosture,
} from '@noodle-borg/transport-http';
import type { ServiceOptions } from './options.js';
import type { ServerRegistry } from './registry.js';
import { dispatchAnalyticsReads } from './routes/analytics-dispatch.js';
import { dispatchIntentCaptureRoutes } from './routes/intent-capture-dispatch.js';
import type { AuditSink } from './store/audit.js';
import type { ControlPlaneStore } from './store.js';

export function createObservabilityStores(options: ServiceOptions) {
  return [
    options.intentCaptureSettingsStore ?? new InMemoryIntentCaptureSettingsStore(),
    options.intentEventStore ?? new InMemoryIntentEventStore(),
    options.requestEventStore ?? new InMemoryRequestEventStore(),
    new Set(options.intentCapturePreviewOrgs ?? []),
  ] as const;
}

async function resolveIntentMode(
  target: Awaited<ReturnType<ServerRegistry['getServing']>>,
  ref: TenantRouteRef | undefined,
  previewOrgs: ReadonlySet<string>,
  settings: IntentCaptureSettingsStore,
): Promise<ServedTarget | undefined> {
  if (target === undefined) return undefined;
  const resolved =
    ref ??
    (target.org !== undefined && target.app !== undefined && target.environment !== undefined
      ? { org: target.org, app: target.app, env: target.environment }
      : undefined);
  if (resolved === undefined || !previewOrgs.has(resolved.org)) return target;
  try {
    const setting = await settings.get(resolved);
    return { ...target, intentCaptureMode: setting?.mode ?? 'off' };
  } catch {
    return target;
  }
}

export function createIntentTargetResolver(
  settings: IntentCaptureSettingsStore,
  previewOrgs: ReadonlySet<string>,
) {
  return (
    target: Awaited<ReturnType<ServerRegistry['getServing']>>,
    ref?: TenantRouteRef,
  ): Promise<ServedTarget | undefined> => resolveIntentMode(target, ref, previewOrgs, settings);
}

export function createObservabilityDispatcher(deps: {
  readonly gate: DeployAuthGate;
  readonly controlPlane: ControlPlaneStore;
  readonly requestEvents: RequestEventStore;
  readonly intentEvents: IntentEventStore;
  readonly intentSettings: IntentCaptureSettingsStore;
  readonly previewOrgs: ReadonlySet<string>;
  readonly audit: AuditSink;
  readonly maxBody: number;
  readonly tls: TlsPosture;
  readonly options: ServiceOptions;
}): (req: IncomingMessage, res: ServerResponse, url: URL) => boolean {
  return (req, res, url) =>
    dispatchAnalyticsReads(req, res, url, {
      gate: deps.gate,
      controlPlane: deps.controlPlane,
      requestEventStore: deps.requestEvents,
      applySecurityHeaders,
      enforceHttps,
      sendJson,
      tls: deps.tls,
      developerGrantStore: deps.options.developerGrantStore,
    }) ||
    dispatchIntentCaptureRoutes(req, res, url, {
      gate: deps.gate,
      controlPlane: deps.controlPlane,
      settings: deps.intentSettings,
      intents: deps.intentEvents,
      requests: deps.requestEvents,
      audit: deps.audit,
      maxBody: deps.maxBody,
      previewOrgs: deps.previewOrgs,
      applySecurityHeaders,
      enforceHttps,
      sendJson,
      tls: deps.tls,
      ...(deps.options.clock === undefined ? {} : { clock: deps.options.clock }),
    });
}
