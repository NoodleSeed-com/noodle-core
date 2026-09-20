import { createHash } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
import { compileManifest, InMemoryCatalog } from '@noodle-borg/compiler';
import { compileConnectors } from '@noodle-borg/connector-defs';
import { z } from 'zod';
import { withBuiltinStateCatalog } from '../state-catalog.js';
import {
  type DraftArtifactCheck,
  draftArtifactCheckSchema,
  draftCompileFailure,
} from './compiler-result.js';

// Trusted compiler only: never evaluate/import uploaded TypeScript here. The worker receives JSON,
// has an empty environment, and supplies neither filesystem roots nor execution/credential authority.
const inputSchema = z.strictObject({
  manifest: z.string().max(4 * 1024 * 1024),
  connectors: z
    .string()
    .max(4 * 1024 * 1024)
    .optional(),
});
function check(): DraftArtifactCheck {
  const input = inputSchema.parse(workerData);
  const manifest = boundedJson(input.manifest);
  const connectors = input.connectors === undefined ? undefined : boundedJson(input.connectors);
  if (manifest === undefined || (input.connectors !== undefined && connectors === undefined))
    return draftCompileFailure('invalid_artifact');
  const catalog =
    connectors === undefined ? undefined : compileConnectors(JSON.stringify(connectors));
  if (catalog && !catalog.ok) return diagnostics(catalog.errors);
  const builtins = withBuiltinStateCatalog([]);
  if (
    catalog?.ok &&
    catalog.catalog.some((entry) => builtins.some((builtin) => builtin.id === entry.id))
  )
    return draftCompileFailure('reserved_connector');
  const compiled = compileManifest(manifest, {
    catalog: new InMemoryCatalog([...builtins, ...(catalog?.ok ? catalog.catalog : [])]),
  });
  if (!compiled.ok) return diagnostics(compiled.errors);
  return {
    ok: true,
    artifactDigest: createHash('sha256')
      .update(JSON.stringify({ artifact: compiled.artifact, connectors }))
      .digest('hex'),
  };
}

function diagnostics(
  issues: readonly { readonly code: string; readonly message: string; readonly path: string }[],
): DraftArtifactCheck {
  return {
    ok: false,
    issues: issues.slice(0, 20).map((issue) => ({
      code: /^[a-z][a-z0-9_]{0,79}$/.test(issue.code) ? issue.code : 'invalid_artifact',
      message: issue.message.slice(0, 500),
      path: issue.path.slice(0, 240),
    })),
  };
}

/** Bound recursive compiler work before existing validators; worker termination also bounds regex/schema work. */
function boundedJson(source: string): unknown {
  const value: unknown = JSON.parse(source);
  const pending = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const current = pending.pop();
    if (!current || ++nodes > 50_000 || current.depth > 64) return undefined;
    if (typeof current.value === 'string' && current.value.length > 256 * 1024) return undefined;
    if (current.value !== null && typeof current.value === 'object') {
      const entries = Object.entries(current.value);
      if (entries.length > 512 || entries.some(([key]) => key === '__proto__')) return undefined;
      for (const [, child] of entries) pending.push({ value: child, depth: current.depth + 1 });
    }
  }
  return value;
}

let result: DraftArtifactCheck;
try {
  result = draftArtifactCheckSchema.parse(check());
} catch {
  result = draftCompileFailure('invalid_artifact');
}
parentPort?.postMessage(result);
