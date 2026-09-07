/**
 * Minimal URI-template support for MCP resources. We support **only** the RFC 6570 *simple* `{var}`
 * form — the shape MCP examples use (`tickets://{id}`, `users://{userId}/posts/{postId}`). Operator
 * forms (`{+var}`, `{#var}`, `{?q}`, `{var*}`, `{var:3}`, …) are rejected at compile time so behavior
 * stays predictable and bounded.
 *
 * A variable matches a single path segment (`[^/]+`); a template with no `{var}` is a fixed URI. Matching
 * is anchored and uses non-backtracking segment classes, so it is linear in the input length.
 */

/** Bounds (defense in depth against pathological templates). */
const MAX_URI_LENGTH = 2048;
const MAX_VARIABLES = 16;

/** A simple `{var}` name: letters, digits, underscores. */
const SIMPLE_VAR = /^[A-Za-z0-9_]+$/;

export interface FixedUri {
  readonly kind: 'fixed';
  readonly uri: string;
}

export interface TemplateUri {
  readonly kind: 'template';
  readonly variables: readonly string[];
  /** Match a concrete URI against this template; returns the extracted variables, or `null` on no match. */
  match(uri: string): Record<string, string> | null;
}

export type ParsedUri = FixedUri | TemplateUri;

export type ParseUriResult =
  | { readonly ok: true; readonly value: ParsedUri }
  | { readonly ok: false; readonly error: string };

/** Escape a literal slice of the template for safe inclusion in the matcher regex. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parse a resource `uri` into a fixed URI or a `{var}` template matcher. Returns an error string for an
 * unsupported template (operator forms, duplicate/empty variables, or an out-of-bounds template).
 */
export function parseUriTemplate(uri: string): ParseUriResult {
  if (uri.length > MAX_URI_LENGTH) {
    return { ok: false, error: `uri is too long (max ${MAX_URI_LENGTH} characters)` };
  }

  const variables: string[] = [];
  let pattern = '';
  let cursor = 0;
  const re = /\{([^}]*)\}/g;
  let m: RegExpExecArray | null = re.exec(uri);
  while (m !== null) {
    const expression = m[1] ?? '';
    if (!SIMPLE_VAR.test(expression)) {
      return {
        ok: false,
        error: `unsupported URI template expression "{${expression}}"; only the simple {var} form is supported`,
      };
    }
    if (variables.includes(expression)) {
      return { ok: false, error: `duplicate template variable "${expression}"` };
    }
    if (variables.length >= MAX_VARIABLES) {
      return { ok: false, error: `too many template variables (max ${MAX_VARIABLES})` };
    }
    variables.push(expression);
    pattern += escapeRegExp(uri.slice(cursor, m.index));
    pattern += '([^/]+)';
    cursor = m.index + m[0].length;
    m = re.exec(uri);
  }

  if (variables.length === 0) {
    return { ok: true, value: { kind: 'fixed', uri } };
  }

  pattern += escapeRegExp(uri.slice(cursor));
  const matcher = new RegExp(`^${pattern}$`);
  const captured = variables.slice();

  return {
    ok: true,
    value: {
      kind: 'template',
      variables: captured,
      match(concrete: string): Record<string, string> | null {
        if (concrete.length > MAX_URI_LENGTH) return null;
        const result = matcher.exec(concrete);
        if (!result) return null;
        const out: Record<string, string> = {};
        for (const [i, name] of captured.entries()) {
          try {
            out[name] = decodeURIComponent(result[i + 1] ?? '');
          } catch {
            return null;
          }
        }
        return out;
      },
    },
  };
}
