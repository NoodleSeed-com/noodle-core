import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AdmissionEnvelope, DailyCounterStore } from '@noodle-borg/admission-limits/portable';
import type { ManagedAssistantModelResolver } from '@noodle-borg/assistant-gateway/model-runtime';
import type {
  AssistantAppearanceSettingsStore,
  AssistantElevationCoordinator,
  AssistantElevationStore,
  AssistantStore,
  PublicEmbedStore,
} from '@noodle-borg/assistant-gateway/portable';
import type { DeployAuthGate } from '@noodle-borg/control-plane/portable';
import type { RequestEventInput } from '@noodle-borg/module';
import type { Logger, TlsPosture } from '@noodle-borg/transport-http';
import type { ServerRegistry } from '../registry.js';
import type { AuditSink } from '../store/audit.js';
import type { ControlPlaneStore, TenantRef } from '../store.js';
import {
  handleAssistantAppRequest,
  handleAssistantPreflight,
  handleAssistantSession,
  handleAssistantTurn,
  handleConsoleApprovalNonce,
} from './assistant.js';
import { handleAssistantAppearance } from './assistant-appearance.js';
import { handleAssistantClients } from './assistant-clients.js';
import { handleAssistantDoctor } from './assistant-doctor.js';
import { handleAssistantEmbedScript } from './assistant-embed-script.js';
import { handleAssistantEmbeds } from './assistant-embeds.js';
import {
  handleAssistantConfirmation,
  handleAssistantInteraction,
} from './assistant-interactions.js';
import { handlePublicAssistantConfiguration } from './assistant-public-configuration.js';
import { handlePublicAssistantSession } from './assistant-public-session.js';
import { handleAssistantSandbox } from './assistant-sandbox.js';
import { handleAssistantSuggestions } from './assistant-suggestions.js';
import { handleAssistantTranscript } from './assistant-transcript.js';

export interface AssistantDispatchDeps {
  readonly registry: ServerRegistry;
  readonly store: AssistantStore;
  readonly appearance?: AssistantAppearanceSettingsStore;
  readonly publicEmbeds?: PublicEmbedStore;
  readonly elevations?: AssistantElevationStore;
  readonly elevationCoordinator?: AssistantElevationCoordinator;
  readonly admissionCounters?: DailyCounterStore;
  readonly admissionEnvelope?: AdmissionEnvelope;
  readonly gate: DeployAuthGate;
  readonly controlPlane: ControlPlaneStore;
  readonly audit: AuditSink;
  readonly maxBody: number;
  readonly serviceBase: (req: IncomingMessage) => string;
  readonly modelFetch?: typeof fetch;
  readonly managedModelResolver?: ManagedAssistantModelResolver;
  readonly captureRequestEvent?: (event: RequestEventInput) => void;
  readonly clock?: () => Date;
  readonly logger?: Logger;
  readonly applySecurityHeaders: (res: ServerResponse, tls: TlsPosture) => void;
  readonly enforceHttps: (req: IncomingMessage, res: ServerResponse, tls: TlsPosture) => boolean;
  readonly sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  readonly tls: TlsPosture;
}

export function dispatchAssistantRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: AssistantDispatchDeps,
): boolean {
  if (url.pathname === '/v1/console/approval-nonces/consume' && req.method === 'POST') {
    return run(req, res, deps, () => handleConsoleApprovalNonce(req, res, deps));
  }
  if (
    (url.pathname === '/v1/assistant/public-sessions' ||
      url.pathname === '/v1/assistant/turns' ||
      url.pathname === '/v1/assistant/tool-confirmations' ||
      url.pathname === '/v1/assistant/interactions' ||
      url.pathname === '/v1/assistant/apps' ||
      url.pathname === '/v1/assistant/suggestions' ||
      url.pathname === '/v1/assistant/transcript') &&
    req.method === 'OPTIONS'
  ) {
    deps.applySecurityHeaders(res, deps.tls);
    handleAssistantPreflight(req, res);
    return true;
  }
  if (url.pathname === '/v1/assistant/embed.js') {
    // Static, secret-free browser script: security headers apply, HTTPS is enforced, but no auth.
    deps.applySecurityHeaders(res, deps.tls);
    if (deps.enforceHttps(req, res, deps.tls)) return true;
    handleAssistantEmbedScript(req, res);
    return true;
  }
  if (url.pathname === '/v1/assistant/sandbox') {
    // Static, secret-free iframe document: security headers apply, HTTPS is enforced, but no auth.
    deps.applySecurityHeaders(res, deps.tls);
    if (deps.enforceHttps(req, res, deps.tls)) return true;
    handleAssistantSandbox(req, res);
    return true;
  }
  if (url.pathname === '/v1/assistant/public-sessions' && req.method === 'POST') {
    return run(req, res, deps, () => handlePublicAssistantSession(req, res, deps));
  }
  const publicConfigurationMatch = /^\/v1\/assistant\/public-configurations\/([^/]+)$/.exec(
    url.pathname,
  );
  if (publicConfigurationMatch) {
    let embedId: string;
    try {
      embedId = decodeURIComponent(publicConfigurationMatch[1] ?? '');
    } catch {
      deps.sendJson(res, 400, { error: 'invalid embed id' });
      return true;
    }
    return run(req, res, deps, () => handlePublicAssistantConfiguration(req, res, embedId, deps));
  }
  if (url.pathname === '/v1/assistant/sessions' && req.method === 'POST') {
    return run(req, res, deps, () => handleAssistantSession(req, res, deps));
  }
  if (url.pathname === '/v1/assistant/turns' && req.method === 'POST') {
    return run(req, res, deps, () => handleAssistantTurn(req, res, deps));
  }
  if (url.pathname === '/v1/assistant/apps' && req.method === 'POST') {
    return run(req, res, deps, () => handleAssistantAppRequest(req, res, deps));
  }
  if (url.pathname === '/v1/assistant/transcript' && req.method === 'POST') {
    return run(req, res, deps, () => handleAssistantTranscript(req, res, deps));
  }
  if (url.pathname === '/v1/assistant/suggestions' && req.method === 'POST') {
    return run(req, res, deps, () => handleAssistantSuggestions(req, res, deps));
  }
  const doctorMatch = /^\/v1\/orgs\/([^/]+)\/apps\/([^/]+)\/envs\/([^/]+)\/assistant\/doctor$/.exec(
    url.pathname,
  );
  const appearanceMatch =
    /^\/v1\/orgs\/([^/]+)\/apps\/([^/]+)\/envs\/([^/]+)\/assistant\/appearance$/.exec(url.pathname);
  if (appearanceMatch) {
    const tenant = decodeTenant(appearanceMatch);
    if (!tenant) {
      deps.sendJson(res, 400, { error: 'invalid tenant path' });
      return true;
    }
    return run(req, res, deps, () => handleAssistantAppearance(req, res, tenant, deps));
  }
  if (doctorMatch) {
    const tenant = decodeTenant(doctorMatch);
    if (!tenant) {
      deps.sendJson(res, 400, { error: 'invalid tenant path' });
      return true;
    }
    return run(req, res, deps, () => handleAssistantDoctor(req, res, tenant, deps));
  }
  const embedsMatch =
    /^\/v1\/orgs\/([^/]+)\/apps\/([^/]+)\/envs\/([^/]+)\/assistant\/embeds(?:\/([^/]+))?$/.exec(
      url.pathname,
    );
  if (embedsMatch) {
    const tenant = decodeTenant(embedsMatch);
    if (!tenant) {
      deps.sendJson(res, 400, { error: 'invalid tenant path' });
      return true;
    }
    const embedId = embedsMatch[4] ? decodeURIComponent(embedsMatch[4]) : undefined;
    return run(req, res, deps, () => handleAssistantEmbeds(req, res, tenant, embedId, deps));
  }
  if (url.pathname === '/v1/assistant/tool-confirmations' && req.method === 'POST') {
    return run(req, res, deps, () => handleAssistantConfirmation(req, res, deps));
  }
  if (url.pathname === '/v1/assistant/interactions' && req.method === 'POST') {
    return run(req, res, deps, () => handleAssistantInteraction(req, res, deps));
  }
  const match =
    /^\/v1\/orgs\/([^/]+)\/apps\/([^/]+)\/envs\/([^/]+)\/assistant\/clients(?:\/([^/]+)(?:\/(rotate))?)?$/.exec(
      url.pathname,
    );
  if (!match) return false;
  const tenant = decodeTenant(match);
  if (!tenant) {
    deps.sendJson(res, 400, { error: 'invalid tenant path' });
    return true;
  }
  const id = match[4] ? decodeURIComponent(match[4]) : undefined;
  const action = match[5] === 'rotate' ? 'rotate' : id ? 'item' : 'collection';
  return run(req, res, deps, () => handleAssistantClients(req, res, tenant, id, action, deps));
}

function run(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AssistantDispatchDeps,
  handler: () => Promise<void>,
): true {
  deps.applySecurityHeaders(res, deps.tls);
  if (deps.enforceHttps(req, res, deps.tls)) return true;
  handler().catch(() => {
    if (!res.headersSent) deps.sendJson(res, 500, { error: 'internal error' });
  });
  return true;
}

function decodeTenant(match: RegExpExecArray): TenantRef | undefined {
  try {
    return {
      org: decodeURIComponent(match[1] ?? ''),
      app: decodeURIComponent(match[2] ?? ''),
      env: decodeURIComponent(match[3] ?? ''),
    };
  } catch {
    return undefined;
  }
}
