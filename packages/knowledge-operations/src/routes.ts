/**
 * Knowledge control-plane route handlers (ADR 0202 as amended). The service dispatch
 * authorizes the request and parses the tenant path, then delegates here; these handlers own
 * validation, the feature gate, staging, and wire shapes — never auth.
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { MAX_DOCUMENT_BYTES } from '@noodle-borg/knowledge/limits';
import { type DocumentTextCodec, identityDocumentTextCodec } from '@noodle-borg/knowledge/portable';
import {
  type KnowledgePreflightResponse,
  type KnowledgeUploadResponse,
  knowledgePreflightRequestSchema,
} from '@noodle-borg/wire-contracts';
import { readBody, sendJson } from './http.js';
import type { KnowledgeStagingStore } from './staging-store.js';

export interface KnowledgeTenantRef {
  readonly org: string;
  readonly app: string;
  readonly env: string;
}

export interface KnowledgeRouteDeps {
  readonly staging: KnowledgeStagingStore;
  /** Managed-config feature gate (`NOODLE_KNOWLEDGE_ENABLED`), resolved org → app → env. */
  readonly knowledgeEnabled: (tenant: KnowledgeTenantRef) => Promise<boolean>;
  readonly maxBodyBytes: number;
  /** Seals staged bytes at rest; the service injects its secret-box codec. */
  readonly codec?: DocumentTextCodec;
  /** Operator read surface (list/status); wired by `wireKnowledge`, absent in bare handlers. */
  readonly status?: import('./status-routes.js').KnowledgeStatusDeps;
}

export function knowledgeTenantKey(tenant: KnowledgeTenantRef): string {
  return `${tenant.org}/${tenant.app}/${tenant.env}`;
}

/** The one command that turns the feature on for a tenant; every fail-closed error names it. */
export function knowledgeEnableCommand(tenant: KnowledgeTenantRef): string {
  return (
    `noodle variables set NOODLE_KNOWLEDGE_ENABLED --value true --runtime cloud ` +
    `--scope env --org ${tenant.org} --app ${tenant.app} --env ${tenant.env}`
  );
}

function sendGateClosed(res: ServerResponse, tenant: KnowledgeTenantRef): void {
  sendJson(res, 403, {
    code: 'knowledge_not_enabled',
    error: 'knowledge is not enabled for this org/app/env',
    fix: knowledgeEnableCommand(tenant),
  });
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * `POST /v1/orgs/{o}/apps/{a}/envs/{e}/knowledge/preflight` — diff declared document hashes
 * against transient staging and published revisions; respond with exactly the hashes that
 * still need bytes. Descriptors only; no contents cross this route.
 */
export async function handleKnowledgePreflight(
  req: IncomingMessage,
  res: ServerResponse,
  tenant: KnowledgeTenantRef,
  deps: KnowledgeRouteDeps,
): Promise<void> {
  if (!(await deps.knowledgeEnabled(tenant))) return sendGateClosed(res, tenant);
  const body = await readBody(req, deps.maxBodyBytes);
  if (!body.ok) return sendJson(res, body.status, { error: body.error });
  let request: ReturnType<typeof knowledgePreflightRequestSchema.parse>;
  try {
    const parsed = knowledgePreflightRequestSchema.safeParse(
      JSON.parse(body.body.toString('utf8')),
    );
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'invalid request');
    request = parsed.data;
  } catch (error) {
    return sendJson(res, 400, {
      code: 'invalid_knowledge_request',
      error: `invalid knowledge preflight request: ${(error as Error).message}`,
    });
  }

  const tenantKey = knowledgeTenantKey(tenant);
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const component of request.components) {
    // Staging-only diff: revision identity includes document metadata (title/path/sourceUrl)
    // this wire shape deliberately never carries, so "is the whole component already
    // published?" is unanswerable here — a bytes-only match once told the CLI to upload
    // nothing while publication then found no metadata-matching revision and failed.
    const hashes = component.documents.map((document) => document.sha256);
    for (const sha256 of hashes) {
      if (seen.has(sha256)) continue;
      seen.add(sha256);
      if (!(await deps.staging.has(tenantKey, sha256))) missing.push(sha256);
    }
  }
  const response: KnowledgePreflightResponse = { ok: true, missing };
  return sendJson(res, 200, response);
}

/**
 * `PUT /v1/orgs/{o}/apps/{a}/envs/{e}/knowledge/documents/{sha256}` — raw UTF-8 bytes,
 * verified against the addressed hash before sealing into transient staging (ADR 0202 D5:
 * the service verifies declared length and hash before publication).
 */
export async function handleKnowledgeDocumentUpload(
  req: IncomingMessage,
  res: ServerResponse,
  tenant: KnowledgeTenantRef,
  sha256: string,
  deps: KnowledgeRouteDeps,
): Promise<void> {
  if (!(await deps.knowledgeEnabled(tenant))) return sendGateClosed(res, tenant);
  if (!SHA256_HEX.test(sha256)) {
    return sendJson(res, 400, {
      code: 'invalid_knowledge_request',
      error: 'document address must be a lowercase hex sha256',
    });
  }
  const body = await readBody(req, Math.min(deps.maxBodyBytes, MAX_DOCUMENT_BYTES));
  if (!body.ok) return sendJson(res, body.status, { error: body.error });
  const actual = createHash('sha256').update(body.body).digest('hex');
  if (actual !== sha256) {
    return sendJson(res, 400, {
      code: 'knowledge_document_hash_mismatch',
      error: 'uploaded bytes do not match the addressed content hash',
    });
  }
  const codec = deps.codec ?? identityDocumentTextCodec;
  await deps.staging.put(
    knowledgeTenantKey(tenant),
    sha256,
    await codec.seal(body.body),
    body.body.length,
  );
  const response: KnowledgeUploadResponse = { ok: true, sha256 };
  return sendJson(res, 200, response);
}
