import type { IncomingMessage, ServerResponse } from 'node:http';
import { ADMISSION_DEFAULTS, clamp } from '@noodle-borg/admission-limits/portable';
import {
  assistantEmbedOperatorView,
  publicSurfaceOf,
  surfaceEnvelope,
} from '@noodle-borg/assistant-gateway/portable';
import { readJsonBody, sendJson } from '@noodle-borg/transport-http';
import {
  type ApplicationChannelsProjection,
  ApplicationChannelsResponseSchema,
  ApplicationChannelsSaveRequestSchema,
} from '@noodle-borg/wire-contracts';
import { resolveTargetOrigins } from '../application-runtime-target.js';
import {
  businessGrantAllows,
  type SolutionInstallation,
} from '../business-information/portable.js';
import type { ResolveEndpointUrlOptions } from '../mcp-public-routing.js';
import type { AssistantRouteDeps } from './assistant.js';
import {
  type BusinessInformationRouteDeps,
  mutationFailure,
  requireIdentity,
  requireInstallationPermission,
} from './business-information.js';
import type { SolutionInstallationRef } from './business-information-paths.js';
import { type ResolveEndpointBase, tenantMcpUrl } from './endpoint-enrichment.js';

export interface BusinessChannelRouteDeps
  extends BusinessInformationRouteDeps,
    Pick<
      AssistantRouteDeps,
      | 'registry'
      | 'publicEmbeds'
      | 'admissionCounters'
      | 'admissionEnvelope'
      | 'managedModelResolver'
    > {
  readonly resolveEndpointBase: ResolveEndpointBase;
  readonly resolveEndpointUrlOptions?: ResolveEndpointUrlOptions;
}

/** Business grants project the existing MCP/assistant channel authority without developer permissions. */
export async function handleBusinessChannels(
  req: IncomingMessage,
  res: ServerResponse,
  ref: SolutionInstallationRef,
  deps: BusinessChannelRouteDeps,
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'PATCH') {
    res.setHeader('Allow', 'GET, PATCH');
    return sendJson(res, 405, { error: 'method not allowed' });
  }
  const identity = await requireIdentity(req, res, deps);
  if (identity === false) return;
  const authorized = await requireInstallationPermission(
    res,
    ref,
    identity,
    req.method === 'PATCH' ? 'installation:administer' : 'records:read',
    deps,
  );
  if (!authorized) return;
  let installation = authorized.installation;
  const setupReady =
    !deps.businessOnboarding || (await deps.businessOnboarding.ready(installation));
  if (req.method === 'GET' && !setupReady)
    return sendJson(res, 409, {
      code: 'business_setup_required',
      error:
        'Complete the organization agreement and business notice before publishing agent channels.',
    });
  if (req.method === 'PATCH') {
    const body = await readJsonBody(req, deps.maxBody);
    if (!body.ok) return sendJson(res, body.status, { error: body.error });
    const parsed = ApplicationChannelsSaveRequestSchema.safeParse(body.value);
    if (!parsed.success)
      return sendJson(res, 400, { code: 'channels_invalid', error: 'invalid channel settings' });
    if (parsed.data.active && !setupReady)
      return sendJson(res, 409, {
        code: 'business_setup_required',
        error: 'Complete business setup before publishing agent channels.',
      });
    const result = await deps.store.setIntakeState({
      scope: authorized.scope,
      expectedRevision: parsed.data.expectedRevision,
      active: parsed.data.active,
      actorSubject: identity.subject,
    });
    if (!result.ok) return mutationFailure(res, result);
    installation = result.installation;
  }
  const projection = await projectBusinessChannels(
    installation,
    businessGrantAllows(authorized.grant, 'installation:administer'),
    deps.resolveEndpointBase(req),
    deps,
  );
  res.setHeader('cache-control', 'private, no-store');
  sendJson(res, 200, ApplicationChannelsResponseSchema.parse({ ok: true, data: projection }));
}

export async function projectBusinessChannels(
  installation: SolutionInstallation,
  canEdit: boolean,
  base: string,
  deps: Pick<
    BusinessChannelRouteDeps,
    | 'registry'
    | 'publicEmbeds'
    | 'admissionCounters'
    | 'admissionEnvelope'
    | 'managedModelResolver'
    | 'resolveEndpointUrlOptions'
    | 'now'
  >,
): Promise<ApplicationChannelsProjection> {
  const tenant = {
    org: installation.scope.org,
    app: installation.scope.app,
    env: installation.scope.env,
  };
  const registered = await deps.registry.getActiveByTenant(tenant);
  const target = registered && (await resolveTargetOrigins(registered));
  const shared = { revision: installation.revision, active: installation.intakeActive, canEdit };
  if (!target?.deploymentId)
    return {
      ...shared,
      mcp: { status: 'unavailable' },
      assistant: {
        status: 'unavailable',
        reason: 'The application has no active deployment.',
        origins: [],
        capabilities: [],
      },
    };
  const endpointOptions = await deps.resolveEndpointUrlOptions?.(tenant.org);
  const mcp: ApplicationChannelsProjection['mcp'] = {
    status: installation.intakeActive ? 'ready' : 'paused',
    url: tenantMcpUrl(base, tenant, undefined, endpointOptions),
    accessMode: target.accessMode,
  };
  const surface = publicSurfaceOf(target.served.artifact.server.assistant);
  const emptyAssistant = {
    status: 'unavailable' as const,
    origins: [...(surface?.origins ?? [])],
    capabilities: surface?.capabilities.map((entry) => entry.name) ?? [],
  };
  const records = await deps.publicEmbeds?.list(tenant);
  const record = records?.find(
    (entry) =>
      entry.revokedAt === undefined &&
      entry.org === tenant.org &&
      entry.app === tenant.app &&
      entry.env === tenant.env,
  );
  const counters = deps.admissionCounters;
  if (!surface || !record || !counters) {
    return {
      ...shared,
      deploymentId: target.deploymentId,
      mcp,
      assistant: {
        ...emptyAssistant,
        reason: 'The public assistant is not configured for this deployment.',
      },
    };
  }
  const at = deps.now?.() ?? new Date();
  const managed = target.served.artifact.server.assistant?.model?.kind === 'noodle-managed';
  const binding = managed
    ? await deps.managedModelResolver?.resolve({
        tenant,
        deploymentId: target.deploymentId,
      })
    : undefined;
  const bounds = binding?.publicAdmission;
  const modelUnavailable = managed && binding === undefined;
  const view = await assistantEmbedOperatorView({
    record,
    surface,
    envelope: surfaceEnvelope(clamp(deps.admissionEnvelope ?? ADMISSION_DEFAULTS), record, bounds),
    peek: (key) => counters.peek(key, at),
    ...(bounds?.spend ? { spend: bounds.spend } : {}),
  });
  const ready = surface.origins.length > 0 && surface.capabilities.length > 0 && !modelUnavailable;
  return {
    ...shared,
    deploymentId: target.deploymentId,
    mcp,
    assistant: {
      status: !ready
        ? 'unavailable'
        : !installation.intakeActive || view.turnsPerDay === 0 || view.mintsPerDay === 0
          ? 'paused'
          : 'ready',
      ...(!ready
        ? {
            reason: modelUnavailable
              ? 'Managed assistant availability is not configured for this application.'
              : 'The application needs an allowed website origin and declared assistant capabilities.',
          }
        : {}),
      embedId: record.embedId,
      serviceUrl: base.replace(/\/+$/, ''),
      scriptUrl: `${base.replace(/\/+$/, '')}/v1/assistant/embed.js`,
      origins: [...view.origins],
      capabilities: [...view.capabilities],
      usage: {
        turnsPerDay: view.turnsPerDay,
        turnsToday: view.turnsToday,
        mintsPerDay: view.mintsPerDay,
        mintsToday: view.mintsToday,
        ...(view.managedSpend ? { managedSpend: view.managedSpend } : {}),
      },
    },
  };
}
