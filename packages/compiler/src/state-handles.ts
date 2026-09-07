import type { ArtifactState, JsonSchema } from './artifact/types.js';
import type { CompileError } from './errors.js';
import { withDialect } from './fulfilment-emit.js';
import { findExternalRef } from './fulfilment-structural.js';
import type { Manifest } from './manifest/schema.js';
import { resolveSchemaUses } from './manifest/schema-refs.js';

interface ManifestStateHandle {
  readonly kind: ArtifactState['handles'][string]['kind'];
  readonly schema: JsonSchema;
  readonly version: string;
  readonly scope?: ArtifactState['handles'][string]['scope'];
  readonly ttlSeconds?: number;
  readonly claimOnAuthentication?: true;
}

export function compileState(
  manifest: Manifest,
  schemasMap: Record<string, JsonSchema>,
  errors: CompileError[],
): ArtifactState | undefined {
  if (manifest.state === undefined) return undefined;
  const handles: Record<string, ArtifactState['handles'][string]> = {};
  const manifestHandles = manifest.state.handles as Record<string, ManifestStateHandle>;
  for (const [name, handle] of Object.entries(manifestHandles)) {
    const path = `state.handles.${name}.schema`;
    const resolved = resolveSchemaUses(handle.schema, schemasMap, path);
    errors.push(...resolved.errors);
    const externalRef = findExternalRef(resolved.schema, path);
    if (externalRef) errors.push(externalRef);
    const secretPath = findSecretLikeSchemaPath(resolved.schema, path);
    if (secretPath !== undefined) {
      errors.push({
        code: 'state_secret_field',
        path: secretPath,
        message:
          'state handles must not store secrets, tokens, passwords, API keys, cookies, or credentials',
      });
    }
    handles[name] = {
      kind: handle.kind,
      schema: withDialect(resolved.schema),
      version: handle.version,
      scope: handle.scope ?? 'deployment',
      ...(handle.ttlSeconds !== undefined ? { ttlSeconds: handle.ttlSeconds } : {}),
      ...(handle.claimOnAuthentication === true ? { claimOnAuthentication: true } : {}),
    };
  }
  return { handles };
}

const SECRET_LIKE_FIELD = /(secret|token|api[_-]?key|password|credential|authorization|cookie)/i;

function findSecretLikeSchemaPath(schema: unknown, path: string): string | undefined {
  if (!schema || typeof schema !== 'object') return undefined;
  if (Array.isArray(schema)) {
    for (let i = 0; i < schema.length; i++) {
      const found = findSecretLikeSchemaPath(schema[i], `${path}.${i}`);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  for (const [key, value] of Object.entries(schema)) {
    const childPath = `${path}.${key}`;
    if (SECRET_LIKE_FIELD.test(key)) return childPath;
    if (typeof value === 'string' && SECRET_LIKE_FIELD.test(value)) return childPath;
    const found = findSecretLikeSchemaPath(value, childPath);
    if (found !== undefined) return found;
  }
  return undefined;
}
