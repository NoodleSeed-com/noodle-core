import type { RuntimeArtifact } from '@noodle-borg/compiler';
import { canonicalizeContext } from './context-bounds.js';
import { type ExecuteDeps, runFulfilment, validateAgainstSchema } from './execute.js';
import type { ExecutionResult } from './result.js';
import { splitResultMeta } from './result-meta.js';

/**
 * Resolve the server's declared ambient context against the invocation's temporal/caller snapshot.
 * The provider is compiled fulfilment data, not tenant code, and its result is validated before it can
 * become `${context.ambient}` for later executions.
 */
export async function executeAmbientContext(
  artifact: RuntimeArtifact,
  deps: ExecuteDeps,
): Promise<ExecutionResult> {
  if (artifact.resolution !== 'resolved') {
    return {
      ok: false,
      error: {
        code: 'shape_only_artifact',
        message: 'runtime refuses to serve a shape-only artifact',
      },
    };
  }
  const ambient = artifact.server.context?.ambient;
  if (ambient === undefined) return { ok: true, output: undefined };

  const providerContext =
    deps.context === undefined
      ? undefined
      : {
          temporal: deps.context.temporal,
          ambientStatus: 'not_configured' as const,
        };
  const providerDeps: ExecuteDeps = {
    ...deps,
    ...(providerContext !== undefined ? { context: providerContext } : {}),
  };
  const result = await runFulfilment(
    ambient.fulfilment,
    {},
    'server.context.ambient',
    providerDeps,
  );
  if (!result.ok) return result;
  const { visible } = splitResultMeta(result.output);
  const canonical = canonicalizeContext(visible);
  if (!canonical.ok) {
    return {
      ok: false,
      error: {
        code: 'output_invalid',
        message: canonical.issue.message,
        path: canonical.issue.path,
      },
    };
  }
  const outputError = validateAgainstSchema(
    canonical.value,
    ambient.outputSchema,
    'context.ambient',
    'output_invalid',
    'ambient context',
  );
  if (outputError !== null) return { ok: false, error: outputError };
  return { ok: true, output: canonical.value };
}
