import type {
  ArtifactVariableDeclaration,
  CompileError,
  RuntimeArtifact,
} from '@noodle-borg/compiler';
import { resolveVariableEnvironment } from './business-variables.js';

const MANAGED_ORIGIN = /^\$\{env\.([A-Za-z0-9_]+)\}$/;

interface ManagedOriginError extends CompileError {
  readonly variableName: string;
  readonly reason: 'missing' | 'invalid';
}

export type ManagedOriginResolutionResult =
  | { readonly ok: true; readonly artifact: RuntimeArtifact }
  | { readonly ok: false; readonly errors: readonly ManagedOriginError[] };

/** Bind operator-owned exact origins into every runtime authority and host projection. */
export function resolveManagedOrigins(
  artifact: RuntimeArtifact,
  variables: Readonly<Record<string, unknown>>,
  options: { readonly allowUnconfiguredPortal?: boolean } = {},
): ManagedOriginResolutionResult {
  const errors: ManagedOriginError[] = [];
  const replacements = new Map<string, string>();
  const resolveList = (values: readonly string[], path: string, allowLoopback: boolean): string[] =>
    values.flatMap((value, index) =>
      resolveManagedOrigin(
        value,
        variables,
        `${path}.${index}`,
        allowLoopback,
        replacements,
        errors,
        artifact.server.variables?.find(
          (declaration) => declaration.name === MANAGED_ORIGIN.exec(value)?.[1],
        ),
        options.allowUnconfiguredPortal === true,
      ),
    );

  const assistant = artifact.server.assistant;
  const resolvedAssistant =
    assistant === undefined
      ? undefined
      : {
          ...assistant,
          allowedOrigins: resolveList(
            assistant.allowedOrigins,
            'server.assistant.allowedOrigins',
            true,
          ),
          ...(assistant.surfaces === undefined
            ? {}
            : {
                surfaces: assistant.surfaces.map((surface, index) => ({
                  ...surface,
                  origins: resolveList(
                    surface.origins,
                    `server.assistant.surfaces.${index}.origins`,
                    true,
                  ),
                })),
              }),
        };
  const handoff = artifact.server.handoff;
  const resolvedHandoff =
    handoff === undefined
      ? undefined
      : {
          ...handoff,
          allowedDomains: resolveList(handoff.allowedDomains, 'handoff.allowedDomains', false),
        };
  const owners = new Map<string, number>();
  resolvedAssistant?.surfaces?.forEach((surface, index) => {
    for (const origin of surface.origins) {
      const prior = owners.get(origin);
      if (prior !== undefined && prior !== index)
        errors.push({
          code: 'invalid_shape',
          path: `server.assistant.surfaces.${index}.origins`,
          variableName: '',
          reason: 'invalid',
          message: 'Assistant surfaces must have distinct configured origins.',
        });
      owners.set(origin, index);
    }
  });
  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    artifact: {
      ...artifact,
      server: {
        ...artifact.server,
        ...(resolvedAssistant === undefined ? {} : { assistant: resolvedAssistant }),
        ...(resolvedHandoff === undefined ? {} : { handoff: resolvedHandoff }),
      },
      ...(artifact.resources === undefined
        ? {}
        : {
            resources: artifact.resources.map(
              (resource) => replaceValue(resource, replacements) as typeof resource,
            ),
          }),
    },
  };
}

function resolveManagedOrigin(
  value: string,
  variables: Readonly<Record<string, unknown>>,
  path: string,
  allowLoopback: boolean,
  replacements: Map<string, string>,
  errors: ManagedOriginError[],
  declaration: ArtifactVariableDeclaration | undefined,
  allowUnconfiguredPortal: boolean,
): string | readonly [] {
  const match = MANAGED_ORIGIN.exec(value);
  if (match?.[1] === undefined) return value;
  const decoded =
    declaration === undefined ? undefined : resolveVariableEnvironment([declaration], variables);
  const resolved = decoded?.ok ? decoded.env[match[1]] : variables[match[1]];
  if (resolved === undefined && decoded?.ok !== false) {
    if (allowUnconfiguredPortal && declaration?.portal !== undefined) {
      replacements.set(value, '');
      return [];
    }
    errors.push({
      code: 'invalid_shape',
      variableName: match[1],
      reason: 'missing',
      path,
      message: `managed origin variable "${match[1]}" is not configured`,
    });
    return value;
  }
  if (
    decoded?.ok === false ||
    typeof resolved !== 'string' ||
    !isCanonicalOrigin(resolved, allowLoopback)
  ) {
    errors.push({
      code: 'invalid_shape',
      variableName: match[1],
      reason: 'invalid',
      path,
      message: allowLoopback
        ? `managed origin variable "${match[1]}" must resolve to a canonical bare HTTPS origin (loopback HTTP is allowed for development)`
        : `managed origin variable "${match[1]}" must resolve to a canonical bare HTTPS origin`,
    });
    return value;
  }
  replacements.set(value, resolved);
  return resolved;
}

function isCanonicalOrigin(value: string, allowLoopback: boolean): boolean {
  try {
    const url = new URL(value);
    if (url.origin !== value || url.username !== '' || url.password !== '') return false;
    if (url.protocol === 'https:') return true;
    return (
      allowLoopback &&
      url.protocol === 'http:' &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
    );
  } catch {
    return false;
  }
}

function replaceValue(value: unknown, replacements: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') return replaceStrings(value, replacements);
  if (Array.isArray(value))
    return value.flatMap((item) =>
      typeof item === 'string' && replacements.get(item) === ''
        ? []
        : [replaceValue(item, replacements)],
    );
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceValue(item, replacements)]),
    );
  }
  return value;
}

function replaceStrings(value: string, replacements: ReadonlyMap<string, string>): string {
  let result = value;
  for (const [expression, origin] of replacements) result = result.replaceAll(expression, origin);
  return result;
}
