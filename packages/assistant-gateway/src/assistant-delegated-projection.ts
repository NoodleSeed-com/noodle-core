import type { ArtifactFulfilment, ArtifactTool, RuntimeArtifact } from '@noodle-borg/compiler';
import type { ConnectorCompileError, SecretBinding } from '@noodle-borg/connector-defs';

/**
 * The connector-auth-kind half of anonymous-behavior classification (ADR 0201, amended 2026-08-19).
 *
 * `anonymousBehavior` classifies on `${user}` references and ADR 0185 `authorization` — data the
 * compiler owns. Whether a tool's connector authenticates *as the signed-in user* lives in the
 * deploy plane's `SecretBinding`s, which the compiler's catalog contract deliberately excludes, so
 * that classification joins here: at deploy for `public` surfaces (below — an inevitable runtime
 * `credential_unavailable`, rejected like the delegated-exchange identity preflight beside it) and
 * at runtime for `mixed` surfaces, where the same tool is not an error but the sign-in trigger.
 *
 * Diagnostics identify connector operations but never auth endpoints or secrets.
 */

const DELEGATED_AUTH_KINDS: ReadonlySet<string> = new Set([
  'delegatedOAuth',
  'delegatedSessionCookie',
  'delegatedTokenExchange',
]);

/** Join keys for caller-derived bindings: `connectorId|operation`, `connectorId|*` for defaults. */
export function delegatedAuthOperationKeys(
  bindings: readonly SecretBinding[],
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const binding of bindings) {
    if (binding.authKind === undefined || !DELEGATED_AUTH_KINDS.has(binding.authKind)) continue;
    keys.add(`${binding.connectorId}|${binding.operation ?? '*'}`);
  }
  return keys;
}

function fulfilmentOperationRefs(fulfilment: ArtifactFulfilment) {
  if (fulfilment.kind === 'operation') return [fulfilment.operationRef];
  return fulfilment.steps.flatMap((step) => (step.kind === 'operation' ? [step.operationRef] : []));
}

/** Whether any operation this tool fulfils through is bound to caller-derived connector auth. */
export function toolTouchesDelegatedAuth(
  tool: Pick<ArtifactTool, 'fulfilment'>,
  keys: ReadonlySet<string>,
): boolean {
  return fulfilmentOperationRefs(tool.fulfilment).some(
    (ref) =>
      ref.resolved === true &&
      (keys.has(`${ref.connectorId}|${ref.operation}`) || keys.has(`${ref.connectorId}|*`)),
  );
}

interface SurfaceShape {
  readonly mode?: unknown;
  readonly capabilities?: unknown;
}

/**
 * Reject delegated-auth tools projected to `public` surfaces. A `mixed` surface deliberately
 * projects them — reaching one raises the sign-in card — so only pure `public` is an error.
 */
export function publicSurfaceDelegatedAuthErrors(
  artifact: Pick<RuntimeArtifact, 'tools' | 'server'>,
  bindings: readonly SecretBinding[],
): readonly ConnectorCompileError[] {
  const keys = delegatedAuthOperationKeys(bindings);
  if (keys.size === 0) return [];
  const surfaces = (artifact.server.assistant as { surfaces?: unknown } | undefined)?.surfaces;
  if (!Array.isArray(surfaces)) return [];
  const errors: ConnectorCompileError[] = [];
  surfaces.forEach((entry: SurfaceShape, index) => {
    if (entry?.mode !== 'public' || !Array.isArray(entry.capabilities)) return;
    for (const capability of entry.capabilities as ReadonlyArray<{
      readonly kind?: unknown;
      readonly name?: unknown;
    }>) {
      if (capability?.kind !== 'tool' || typeof capability.name !== 'string') continue;
      const tool = artifact.tools.find((candidate) => candidate.name === capability.name);
      if (tool === undefined || !toolTouchesDelegatedAuth(tool, keys)) continue;
      errors.push({
        code: 'assistant_public_delegated_auth',
        path: `server.assistant.surfaces[${index}].capabilities`,
        message: `tool "${tool.name}" reaches a connector operation that authenticates as the signed-in user; a public surface has no sign-in, so the call can never execute. Project it to a mixed surface (publicWebsite({ signIn: true })) or an authenticated one`,
      });
    }
  });
  return errors;
}
