import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ControlPlaneIdentity, DeployAuthGate } from '@noodle-borg/control-plane/portable';
import {
  McpSubdomainCooldownError,
  McpSubdomainIdempotencyConflictError,
  McpSubdomainOwnerRequiredError,
  McpSubdomainUnavailableError,
  validateMcpSubdomain,
} from '@noodle-borg/control-plane/portable';
import { normalizePublicBaseDomain } from '@noodle-borg/module';
import { readJsonBody, sendJson } from '@noodle-borg/transport-http';
import {
  McpSubdomainMutationRequestSchema,
  McpSubdomainMutationResponseSchema,
  McpSubdomainSettingResponseSchema,
} from '@noodle-borg/wire-contracts';
import { type AuditSink, emitAuditMirrors } from '../store/audit.js';
import type { ControlPlaneStore, McpSubdomainMutationResult } from '../store.js';
import { authorizeControlPlane } from './control-plane.js';

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,256}$/;

export async function handleOrgMcpSubdomain(
  req: IncomingMessage,
  res: ServerResponse,
  gate: DeployAuthGate,
  controlPlane: ControlPlaneStore,
  maxBody: number,
  ref: { readonly org: string },
  audit: AuditSink,
  publicBaseDomain?: string,
): Promise<void> {
  const identity = await authorizeControlPlane(req, res, gate, { requireIdentity: true });
  if (identity === false) return;
  const member = await controlPlane.getOrgMember({ org: ref.org, subject: identity.subject });
  if (req.method === 'GET') {
    if (member === undefined) return sendMembershipRequired(res);
    const setting = await controlPlane.getMcpSubdomainSetting(ref.org);
    if (setting === undefined) return sendJson(res, 404, { ok: false, error: 'not found' });
    return sendJson(
      res,
      200,
      McpSubdomainSettingResponseSchema.parse({
        ok: true,
        data: {
          orgSlug: setting.orgSlug,
          mcpSubdomain: setting.mcpSubdomain,
          mcpServerHost: publicMcpServerHost(setting.mcpSubdomain, publicBaseDomain),
          changeAllowedAt: setting.changeAllowedAt ?? null,
        },
      }),
    );
  }
  if (member?.role !== 'owner') return sendOwnerRequired(res);
  const idempotencyKey = req.headers['idempotency-key'];
  if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
    return sendJson(res, 400, {
      ok: false,
      code: 'idempotency_key_required',
      error: 'Idempotency-Key must contain 8-256 safe characters',
    });
  }
  const body = await readJsonBody(req, maxBody);
  if (!body.ok) return sendJson(res, body.status, { ok: false, error: body.error });
  const raw = isRecord(body.value) ? body.value : {};
  if (raw.acknowledgeOldUrlsStopWorking !== true) {
    return sendJson(res, 400, {
      ok: false,
      code: 'mcp_subdomain_acknowledgement_required',
      error: 'acknowledge that existing MCP server URLs stop working',
    });
  }
  const parsed = McpSubdomainMutationRequestSchema.safeParse(body.value);
  if (!parsed.success) {
    return sendJson(res, 400, {
      ok: false,
      code: 'invalid_mcp_subdomain',
      error: 'invalid MCP subdomain request',
    });
  }
  try {
    validateMcpSubdomain(parsed.data.mcpSubdomain);
  } catch {
    return sendJson(res, 400, {
      ok: false,
      code: 'invalid_mcp_subdomain',
      error: 'MCP subdomain must be an available lowercase DNS label',
    });
  }

  let result: McpSubdomainMutationResult;
  try {
    result = await controlPlane.changeMcpSubdomain({
      org: ref.org,
      mcpSubdomain: parsed.data.mcpSubdomain,
      idempotencyKey,
      actor: { subject: identity.subject, email: identity.email },
    });
  } catch (error) {
    return handleMutationError(res, error);
  }
  if (result.changed && !result.replayed) {
    const event = successAudit(result, identity);
    if (result.auditCommitted) await emitAuditMirrors(audit, event);
    else await audit.emit(event);
  }
  return sendJson(res, 200, mutationResponse(result, publicBaseDomain));
}

function mutationResponse(result: McpSubdomainMutationResult, publicBaseDomain?: string) {
  return McpSubdomainMutationResponseSchema.parse({
    ok: true,
    data: {
      orgSlug: result.orgSlug,
      previousMcpSubdomain: result.previousMcpSubdomain,
      previousMcpServerHost: publicMcpServerHost(result.previousMcpSubdomain, publicBaseDomain),
      mcpSubdomain: result.mcpSubdomain,
      mcpServerHost: publicMcpServerHost(result.mcpSubdomain, publicBaseDomain),
      changed: result.changed,
      replayed: result.replayed,
      changedAt: result.changedAt ?? null,
      changeAllowedAt: result.changeAllowedAt ?? null,
      oldUrlsInvalidated: result.changed,
      reauthorizationRequired: result.changed,
    },
  });
}

function publicMcpServerHost(label: string, publicBaseDomain?: string): string | null {
  return publicBaseDomain === undefined
    ? null
    : `${label}.${normalizePublicBaseDomain(publicBaseDomain)}`;
}

function handleMutationError(res: ServerResponse, error: unknown): void {
  if (error instanceof McpSubdomainOwnerRequiredError) {
    sendOwnerRequired(res);
    return;
  }
  if (error instanceof McpSubdomainUnavailableError) {
    sendJson(res, 409, {
      ok: false,
      code: 'mcp_subdomain_unavailable',
      error: 'MCP subdomain is unavailable',
    });
    return;
  }
  if (error instanceof McpSubdomainCooldownError) {
    sendJson(res, 429, {
      ok: false,
      code: 'mcp_subdomain_cooldown',
      error: 'MCP subdomain cannot be changed yet',
      changeAllowedAt: error.changeAllowedAt,
    });
    return;
  }
  if (error instanceof McpSubdomainIdempotencyConflictError) {
    sendJson(res, 409, {
      ok: false,
      code: 'idempotency_key_conflict',
      error: 'Idempotency-Key was already used for another request',
    });
    return;
  }
  throw error;
}

function successAudit(result: McpSubdomainMutationResult, identity: ControlPlaneIdentity) {
  return {
    eventType: 'org.mcp_subdomain.changed',
    org: result.orgSlug,
    actorSubject: identity.subject,
    actorEmail: identity.email,
    decision: 'allow' as const,
    status: 200,
    details: {
      previousMcpSubdomain: result.previousMcpSubdomain,
      mcpSubdomain: result.mcpSubdomain,
    },
  };
}

function sendMembershipRequired(res: ServerResponse): void {
  sendJson(res, 403, {
    ok: false,
    code: 'organization_member_required',
    error: 'organization membership required',
  });
}

function sendOwnerRequired(res: ServerResponse): void {
  sendJson(res, 403, {
    ok: false,
    code: 'organization_owner_required',
    error: 'Only an organization owner can change the MCP subdomain',
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}
