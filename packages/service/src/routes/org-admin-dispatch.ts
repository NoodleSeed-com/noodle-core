/**
 * Dispatch for the org-admin control-plane routes: the orgs collection, the single-org item
 * (PATCH rename / GET inspect), members, and invitations. Extracted verbatim from `service.ts`
 * (which stays a thin composition root under the size gate), the same way as
 * `analytics-dispatch.ts`/`github-dispatch.ts`. The path families here (`/v1/orgs`,
 * `/v1/orgs/{org}`, `.../members`, `.../invitations`) are disjoint from the ADR 0128 resource
 * reads (`apps`/`envs`/`deployments`), so this dispatcher's position next to them in the
 * composition root is not behavior-bearing.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DeployAuthGate } from '@noodle-borg/control-plane/portable';
import type { TlsPosture } from '@noodle-borg/transport-http';
import type { AuditSink } from '../store/audit.js';
import type { ControlPlaneStore } from '../store.js';
import type { InvitationEmailSender } from '../welcome-email.js';
import {
  handleInvitations,
  handleMembers,
  handleOpenAIAppsChallenge,
  handleOrgInspect,
  handleOrgs,
  handleOrgUpdate,
} from './org-admin.js';
import { handleOrgDomains } from './org-domains.js';
import { handleOrgMcpSubdomain } from './org-mcp-subdomain.js';
import {
  parseInvitationsPath,
  parseMembersPath,
  parseOrgDomainsPath,
  parseOrgMcpSubdomainPath,
  parseOrgOpenAIAppsChallengePath,
  parseOrgPath,
} from './paths.js';

export interface OrgAdminDispatchDeps {
  readonly gate: DeployAuthGate;
  readonly controlPlane: ControlPlaneStore;
  readonly audit: AuditSink;
  readonly maxBody: number;
  readonly applySecurityHeaders: (res: ServerResponse, tls: TlsPosture) => void;
  readonly enforceHttps: (req: IncomingMessage, res: ServerResponse, tls: TlsPosture) => boolean;
  readonly sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  readonly tls: TlsPosture;
  readonly publicMcpBaseDomain?: string | undefined;
  readonly invitationEmailSender?: InvitationEmailSender | undefined;
  readonly invitationConsoleBaseUrl?: string | undefined;
}

/** Try the org-admin routes; returns true when the request was handled (or a guard ended it). */
export function dispatchOrgAdminRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: OrgAdminDispatchDeps,
): boolean {
  const { gate, controlPlane, audit, maxBody, applySecurityHeaders, enforceHttps, sendJson, tls } =
    deps;

  if (url.pathname === '/v1/orgs' && (req.method === 'GET' || req.method === 'POST')) {
    applySecurityHeaders(res, tls);
    if (enforceHttps(req, res, tls)) return true;
    handleOrgs(req, res, gate, controlPlane, maxBody).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    });
    return true;
  }
  const orgRef = parseOrgPath(url.pathname);
  if (orgRef !== undefined && req.method === 'PATCH') {
    applySecurityHeaders(res, tls);
    if (enforceHttps(req, res, tls)) return true;
    handleOrgUpdate(req, res, gate, controlPlane, maxBody, orgRef, audit).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    });
    return true;
  }
  if (orgRef !== undefined && req.method === 'GET') {
    applySecurityHeaders(res, tls);
    if (enforceHttps(req, res, tls)) return true;
    handleOrgInspect(req, res, gate, controlPlane, orgRef).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    });
    return true;
  }
  const membersRef = parseMembersPath(url.pathname);
  if (membersRef !== undefined) {
    applySecurityHeaders(res, tls);
    if (enforceHttps(req, res, tls)) return true;
    handleMembers(req, res, gate, controlPlane, maxBody, membersRef, audit).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    });
    return true;
  }
  const invitationsRef = parseInvitationsPath(url.pathname);
  if (invitationsRef !== undefined) {
    applySecurityHeaders(res, tls);
    if (enforceHttps(req, res, tls)) return true;
    handleInvitations(req, res, gate, controlPlane, maxBody, invitationsRef, audit, url, {
      ...(deps.invitationEmailSender !== undefined ? { sender: deps.invitationEmailSender } : {}),
      ...(deps.invitationConsoleBaseUrl !== undefined
        ? { consoleBaseUrl: deps.invitationConsoleBaseUrl }
        : {}),
    }).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    });
    return true;
  }
  const domainsRef = parseOrgDomainsPath(url.pathname);
  if (
    domainsRef !== undefined &&
    (req.method === 'GET' || req.method === 'POST' || req.method === 'DELETE')
  ) {
    applySecurityHeaders(res, tls);
    if (enforceHttps(req, res, tls)) return true;
    handleOrgDomains(req, res, gate, controlPlane, maxBody, domainsRef, audit).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    });
    return true;
  }
  const openAIAppsChallengeRef = parseOrgOpenAIAppsChallengePath(url.pathname);
  if (
    openAIAppsChallengeRef !== undefined &&
    (req.method === 'GET' || req.method === 'PUT' || req.method === 'DELETE')
  ) {
    applySecurityHeaders(res, tls);
    if (enforceHttps(req, res, tls)) return true;
    handleOpenAIAppsChallenge(
      req,
      res,
      gate,
      controlPlane,
      maxBody,
      openAIAppsChallengeRef,
      audit,
      deps.publicMcpBaseDomain,
    ).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    });
    return true;
  }
  const mcpSubdomainRef = parseOrgMcpSubdomainPath(url.pathname);
  if (mcpSubdomainRef !== undefined && (req.method === 'GET' || req.method === 'PUT')) {
    applySecurityHeaders(res, tls);
    if (enforceHttps(req, res, tls)) return true;
    handleOrgMcpSubdomain(
      req,
      res,
      gate,
      controlPlane,
      maxBody,
      mcpSubdomainRef,
      audit,
      deps.publicMcpBaseDomain,
    ).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    });
    return true;
  }
  return false;
}
