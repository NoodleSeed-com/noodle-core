/**
 * Deploy-time knowledge document upload (ADR 0202 D5). The compiler pinned each document's
 * hash; this leg re-opens every file without following symlinks, re-hashes the exact bytes
 * from that same handle, and uploads only what the service reports missing — a swapped file
 * fails validation instead of shipping unreviewed content under a stale descriptor.
 */
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  compileKnowledgeComponents,
  type KnowledgeCompileIssue,
  knowledgeComponentManifestSchema,
} from '@noodle-borg/knowledge/portable';
import { knowledgePreflightResponseSchema } from '@noodle-borg/wire-contracts';
import { z } from 'zod';

export type KnowledgeDeployStage = 'validate' | 'preflight' | 'upload';

export class KnowledgeDeployError extends Error {
  readonly stage: KnowledgeDeployStage;

  constructor(stage: KnowledgeDeployStage, message: string) {
    super(message);
    this.name = 'KnowledgeDeployError';
    this.stage = stage;
  }
}

export interface KnowledgeDeploySummary {
  readonly checked: number;
  readonly uploaded: number;
  readonly reused: number;
}

/**
 * Only the manifest field this leg owns; the manifest's own schema is the compiler's contract.
 * Knowledge lives under `server.knowledge` (Core v2) — parsing it at the manifest root made the
 * first shipped upload leg a silent no-op on every real deploy.
 */
const manifestKnowledgeSchema = z.object({
  server: z.object({ knowledge: z.array(knowledgeComponentManifestSchema).optional() }).optional(),
});

interface LoadedDocument {
  readonly sha256: string;
  readonly bytes: Buffer;
}

/** Open without following symlinks, require a regular file, and read from that same handle. */
function readDocumentNoFollow(rootDir: string, path: string): Buffer {
  let fd: number;
  try {
    fd = openSync(join(rootDir, path), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'EMLINK') {
      throw new KnowledgeDeployError('validate', `knowledge document ${path} is a symlink`);
    }
    throw new KnowledgeDeployError(
      'validate',
      `cannot read knowledge document ${path}: ${(error as Error).message}`,
    );
  }
  try {
    if (!fstatSync(fd).isFile()) {
      throw new KnowledgeDeployError(
        'validate',
        `knowledge document ${path} is not a regular file`,
      );
    }
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

export async function prepareKnowledgeDocumentsForDeploy(input: {
  readonly manifest: string;
  readonly rootDir: string;
  readonly service: string;
  readonly org: string;
  readonly app: string;
  readonly env: string;
  readonly authToken?: string;
  readonly fetchImpl: typeof fetch;
}): Promise<KnowledgeDeploySummary> {
  let raw: unknown;
  try {
    raw = JSON.parse(input.manifest) as unknown;
  } catch {
    return { checked: 0, uploaded: 0, reused: 0 };
  }
  const parsed = manifestKnowledgeSchema.safeParse(raw);
  const components = parsed.success ? (parsed.data.server?.knowledge ?? []) : [];
  if (components.length === 0) return { checked: 0, uploaded: 0, reused: 0 };

  const bytesByHash = new Map<string, LoadedDocument>();
  const preflightComponents: { name: string; documents: { sha256: string; bytes: number }[] }[] =
    [];
  for (const component of components) {
    const documents: { sha256: string; bytes: number }[] = [];
    for (const descriptor of component.documents) {
      if (descriptor.sha256 === undefined) {
        throw new KnowledgeDeployError(
          'validate',
          `knowledge document ${descriptor.path} has no content hash; recompile before deploying`,
        );
      }
      const bytes = readDocumentNoFollow(input.rootDir, descriptor.path);
      const actual = createHash('sha256').update(bytes).digest('hex');
      if (actual !== descriptor.sha256) {
        throw new KnowledgeDeployError(
          'validate',
          `knowledge document ${descriptor.path} changed since compile ` +
            `(expected ${descriptor.sha256.slice(0, 12)}…, found ${actual.slice(0, 12)}…); redeploy from a clean build`,
        );
      }
      bytesByHash.set(actual, { sha256: actual, bytes });
      documents.push({ sha256: actual, bytes: bytes.length });
    }
    preflightComponents.push({ name: component.name, documents });
  }

  const base = `${input.service}/v1/orgs/${input.org}/apps/${input.app}/envs/${input.env}/knowledge`;
  const headers = {
    'content-type': 'application/json',
    ...(input.authToken !== undefined ? { authorization: `Bearer ${input.authToken}` } : {}),
  };
  const preflightResponse = await input.fetchImpl(`${base}/preflight`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ components: preflightComponents }),
  });
  const preflightRaw: unknown = await preflightResponse.json().catch(() => ({}));
  const preflight = knowledgePreflightResponseSchema.safeParse(preflightRaw);
  if (preflightResponse.status !== 200 || !preflight.success) {
    const failure = preflightRaw as { error?: string; fix?: string };
    const detail = [failure.error, failure.fix].filter(Boolean).join('; fix: ');
    throw new KnowledgeDeployError(
      'preflight',
      detail === '' ? `knowledge preflight failed (HTTP ${preflightResponse.status})` : detail,
    );
  }

  let uploaded = 0;
  for (const sha256 of preflight.data.missing) {
    const document = bytesByHash.get(sha256);
    if (document === undefined) {
      throw new KnowledgeDeployError('upload', `service requested unknown document hash ${sha256}`);
    }
    const response = await input.fetchImpl(`${base}/documents/${sha256}`, {
      method: 'PUT',
      headers: input.authToken !== undefined ? { authorization: `Bearer ${input.authToken}` } : {},
      body: new Uint8Array(document.bytes),
    });
    if (response.status !== 200) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new KnowledgeDeployError(
        'upload',
        body.error ?? `knowledge document upload failed (HTTP ${response.status})`,
      );
    }
    uploaded += 1;
  }
  return { checked: bytesByHash.size, uploaded, reused: bytesByHash.size - uploaded };
}

/**
 * Fill each authored knowledge document's `sha256`/`bytes` from the project files before the
 * manifest goes anywhere near the wire. The authored manifest deliberately carries bare path
 * descriptors ("the authored manifest carries descriptors and paths, never contents"), and the
 * service cannot read tenant files, so this client-side pass is the only place the hashes the
 * deploy preflight and upload leg require can come from. Reuses the compiler's own knowledge
 * pass so path containment, symlink rejection, and size limits stay single-sourced.
 */
export function rewriteManifestKnowledgeHashes(input: {
  readonly manifest: string;
  readonly rootDir: string;
}): string {
  let raw: unknown;
  try {
    raw = JSON.parse(input.manifest) as unknown;
  } catch {
    return input.manifest; // Not JSON: downstream manifest validation owns that error.
  }
  const parsed = manifestKnowledgeSchema.safeParse(raw);
  const components = parsed.success ? (parsed.data.server?.knowledge ?? []) : [];
  if (components.length === 0) return input.manifest;
  const issues: KnowledgeCompileIssue[] = [];
  // The pass fills sha256/bytes on the (schema-copied) documents in place; already-hashed
  // documents keep their pinned hash, which is what makes this rewrite idempotent.
  compileKnowledgeComponents(components, { rootDir: input.rootDir }, issues);
  if (issues.length > 0) {
    throw new KnowledgeDeployError('validate', issues.map((issue) => issue.message).join('; '));
  }
  (raw as { server: { knowledge?: unknown } }).server.knowledge = components;
  return JSON.stringify(raw);
}
