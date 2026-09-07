import {
  type ArtifactVariableDeclaration,
  canonicalJson,
  MAX_VARIABLE_VALUE_BYTES,
  type RuntimeArtifact,
  validateJsonSchema,
} from '@noodle-borg/compiler';
import type { ExecutionError } from './result.js';

export type VariableEnvironmentResult =
  | {
      readonly ok: true;
      readonly env: Record<string, unknown>;
      readonly missing: readonly string[];
    }
  | { readonly ok: false; readonly error: ExecutionError };

/** Decode the authoritative string store once at an invocation boundary. No implicit coercion. */
export function resolveVariableEnvironment(
  declarations: readonly ArtifactVariableDeclaration[],
  rawConfig: Readonly<Record<string, unknown>>,
  toolName?: string,
): VariableEnvironmentResult {
  const env: Record<string, unknown> = { ...rawConfig };
  const missing: string[] = [];
  for (const declaration of declarations) {
    const raw = Object.hasOwn(rawConfig, declaration.name)
      ? rawConfig[declaration.name]
      : undefined;
    if (raw === undefined && !Object.hasOwn(declaration, 'default')) {
      missing.push(declaration.name);
      delete env[declaration.name];
      continue;
    }
    let value: unknown;
    try {
      if (raw === undefined) value = structuredClone(declaration.default);
      else if (typeof raw === 'string') {
        if (Buffer.byteLength(raw) > MAX_VARIABLE_VALUE_BYTES) return invalidVariable();
        value = JSON.parse(raw);
      } else value = structuredClone(raw);
      if (Buffer.byteLength(canonicalJson(value)) > MAX_VARIABLE_VALUE_BYTES)
        return invalidVariable();
    } catch {
      return invalidVariable();
    }
    if (validateJsonSchema(declaration.valueSchema, value).length > 0) return invalidVariable();
    Object.defineProperty(env, declaration.name, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  if (
    toolName !== undefined &&
    declarations.some(
      (declaration) =>
        missing.includes(declaration.name) && declaration.requiredFor.includes(toolName),
    )
  ) {
    return {
      ok: false,
      error: {
        code: 'configuration_required',
        message: 'This capability needs business settings before it can run.',
      },
    };
  }
  return { ok: true, env, missing };
}

/** A resumed intent cannot silently continue under changed effective business configuration. */
export function validateVariableContinuation(
  artifact: RuntimeArtifact,
  previousEnv: Readonly<Record<string, unknown>>,
  current: VariableEnvironmentResult,
): ExecutionError | undefined {
  if (!current.ok) return current.error;
  const names = (artifact.server.variables ?? []).map((declaration) => declaration.name);
  const project = (env: Readonly<Record<string, unknown>>) =>
    Object.fromEntries(names.map((name) => [name, env[name]]));
  if (canonicalJson(project(previousEnv)) !== canonicalJson(project(current.env)))
    return {
      code: 'configuration_changed',
      message: 'Business settings changed. Prepare and confirm the action again.',
    };
  return undefined;
}

function invalidVariable(): VariableEnvironmentResult {
  return {
    ok: false,
    error: {
      code: 'configuration_invalid',
      message: 'Business settings are unavailable or invalid.',
    },
  };
}
