import type { core } from 'zod';
import type { CompileError } from './errors.js';
import { docAnchorFor } from './suggest.js';

/** A readable description of a value's runtime type, for the `got` field (never the value itself). */
function describeType(input: unknown): string {
  if (input === null) return 'null';
  if (Array.isArray(input)) return 'array';
  return typeof input;
}

/** Format a Zod primitive literal (enum/`literal` option) for the `expected`/`got` fields. */
function formatPrimitive(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  return String(value);
}

/**
 * Map a Zod issue to a {@link CompileError}, deriving a stable error code from its path and the
 * generation-friendly `expected`/`got`/`docAnchor` fields from the issue kind. Union issues read only
 * their immediate option set (depth 1) — nested `unionErrors` are never walked, so the payload stays
 * bounded. `got` carries a value's *type* (or a primitive enum literal), never an arbitrary raw value.
 */
export function translateIssue(issue: core.$ZodIssue): CompileError {
  const path = issue.path.map(String).join('.');
  const leaf = issue.path.length > 0 ? String(issue.path[issue.path.length - 1]) : '';
  let code: CompileError['code'] = 'invalid_shape';
  if (path === 'manifestVersion') code = 'unsupported_manifest_version';
  else if (path === 'server.agentGuide' || path.startsWith('server.agentGuide.'))
    code = 'agent_guide_invalid';
  else if (leaf === 'name') code = 'invalid_name';
  else if (
    issue.code === 'too_big' &&
    (path.endsWith('.html') || path.endsWith('.view.compiledHtml'))
  )
    code = 'widget_html_too_large';

  let expected: string | undefined;
  let got: string | undefined;
  switch (issue.code) {
    case 'invalid_type':
      expected = issue.expected;
      got = describeType(issue.input);
      break;
    case 'invalid_value':
      expected = issue.values.map(formatPrimitive).join(' | ');
      got = formatPrimitive(issue.input);
      break;
    case 'invalid_union':
      // Only the no-match variant carries an immediate `options` set; never walk nested `errors`.
      if ('options' in issue && issue.options !== undefined)
        expected = issue.options.map(formatPrimitive).join(' | ');
      got = describeType(issue.input);
      break;
    case 'unrecognized_keys':
      got = issue.keys.join(', ');
      break;
  }

  return {
    code,
    path,
    message: issue.message,
    ...(expected !== undefined ? { expected } : {}),
    ...(got !== undefined ? { got } : {}),
    docAnchor: docAnchorFor(code),
  };
}
