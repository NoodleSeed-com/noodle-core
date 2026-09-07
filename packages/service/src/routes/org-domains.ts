import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DeployAuthGate } from '@noodle-borg/control-plane/portable';
import { readJsonBody, sendJson } from '@noodle-borg/transport-http';
import { sendForbidden } from '../http-util.js';
import type { AuditSink } from '../store/audit.js';
import {
  type ControlPlaneStore,
  type OrgDomainRecord,
  validateOrgMembershipDomain,
} from '../store.js';
import { authorizeControlPlane } from './control-plane.js';
import { canManageMembers, canViewMembers, emitOrgAudit } from './org-admin.js';

const MAX_DOMAINS_PER_REQUEST = 25;

/**
 * Org domains grant data-plane membership to anyone who signs in with a matching verified address
 * ([ADR 0181](../../../../docs/decisions/0181-org-domain-membership-without-dns-verification.md)).
 * Registration is the grant and removal is the revocation; there is no verification step, because a
 * domain claim only opens the claiming org's own deployments.
 *
 * Reads are open to any org member; writes are owner-only, matching the rest of org administration.
 */
export async function handleOrgDomains(
  req: IncomingMessage,
  res: ServerResponse,
  gate: DeployAuthGate,
  controlPlane: ControlPlaneStore,
  maxBody: number,
  ref: { org: string; domain?: string },
  audit: AuditSink,
): Promise<void> {
  const identity = await authorizeControlPlane(req, res, gate, { requireIdentity: true });
  if (identity === false) return;

  if (req.method === 'GET' && ref.domain === undefined) {
    if (!(await canViewMembers(controlPlane, ref.org, identity))) {
      return sendForbidden(res, 'forbidden');
    }
    const records = await controlPlane.listOrgDomains(ref.org);
    return sendJson(res, 200, { ok: true, data: publicOrgDomains(ref.org, records) });
  }

  if (req.method === 'POST' && ref.domain === undefined) {
    if (!(await canManageMembers(controlPlane, ref.org, identity))) {
      return sendForbidden(res, 'forbidden');
    }
    const body = await readJsonBody(req, maxBody);
    if (!body.ok) return sendJson(res, body.status, { error: body.error });
    const requested = (body.value as { domains?: unknown }).domains;
    if (!Array.isArray(requested) || requested.length === 0) {
      return sendJson(res, 400, { error: '"domains" must be a non-empty array of domain names' });
    }
    if (requested.length > MAX_DOMAINS_PER_REQUEST) {
      return sendJson(res, 400, {
        error: `"domains" must contain at most ${MAX_DOMAINS_PER_REQUEST} entries`,
      });
    }
    if (requested.some((entry) => typeof entry !== 'string')) {
      return sendJson(res, 400, { error: '"domains" must contain only strings' });
    }
    try {
      // All or none: validate every entry before writing, so a rejected domain leaves no partial state.
      for (const domain of requested as readonly string[]) {
        validateOrgMembershipDomain(domain);
      }
      for (const domain of requested as readonly string[]) {
        await controlPlane.addOrgDomain({ org: ref.org, domain });
      }
    } catch (error) {
      return sendJson(res, 400, { error: (error as Error).message });
    }
    await emitOrgAudit(audit, 'org.domain.added', ref.org, identity, 201, {
      count: requested.length,
    });
    const records = await controlPlane.listOrgDomains(ref.org);
    return sendJson(res, 201, { ok: true, data: publicOrgDomains(ref.org, records) });
  }

  if (req.method === 'DELETE' && ref.domain !== undefined) {
    if (!(await canManageMembers(controlPlane, ref.org, identity))) {
      return sendForbidden(res, 'forbidden');
    }
    const removed = await controlPlane.removeOrgDomain({ org: ref.org, domain: ref.domain });
    if (!removed) return sendJson(res, 404, { error: 'not found' });
    await emitOrgAudit(audit, 'org.domain.removed', ref.org, identity, 200, {
      domain: ref.domain,
    });
    return sendJson(res, 200, { ok: true, removed: true });
  }

  return sendJson(res, 404, { error: 'not found' });
}

function publicOrgDomains(org: string, records: readonly OrgDomainRecord[]) {
  return {
    orgSlug: org,
    domains: records.map((record) => ({
      domain: record.domain,
      createdAt: record.createdAt,
    })),
  };
}
