import { describe, expect, it } from 'vitest';
import { SKILL_REFERENCES } from '../src/skill-content.js';

// Durable drift guard for connector operation-mapping syntax in the shipped `noodle-seed` skill.
//
// Why this exists: `noodle validate` compiles `${response.body.x}` and `request: { query: {...} }`
// without error (`response` is a valid expression root and `.body`/`query` are just unchecked property
// segments; `request` is opaque `z.unknown()`), and the snippet gate only compiles full-server blocks.
// So a connector fragment can teach syntax the runtime does not support and ship green — the exact
// failure a developer hit building a Todoist app (validate passed, tool returned `undefined`). The
// runtime binds the parsed JSON body to `${response}` (no `.body` envelope), declares query params as an
// operation-level `query: ['argName']` array, and treats the whole `request` object as the JSON body.
// This test forbids the wrong shapes textually across every rendered reference, catching exactly what
// the compiler cannot.
const RENDERED = SKILL_REFERENCES.map((ref) => ({
  relPath: ref.relPath,
  text: ref.render(),
}));

const FORBIDDEN: ReadonlyArray<{ label: string; pattern: RegExp; correct: string }> = [
  {
    label:
      '`${response.body...}` — runtime binds the parsed body to `${response}`, there is no `.body`',
    pattern: /\$\{response\.body\b/,
    correct: '${response.<path>}',
  },
  {
    label:
      '`request: { query: {...} }` — query params are the operation-level `query: [...]` array',
    pattern: /request:\s*\{\s*query\b/,
    correct: "query: ['argName']",
  },
  {
    label: '`request: { body: {...} }` — `request` IS the JSON body, do not nest it under `body`',
    pattern: /request:\s*\{\s*body\b/,
    correct: 'request: { field: ... }',
  },
  {
    label:
      'a `.<digit>` numeric path segment inside a `${...}` expression — use bracket index `[0]`',
    // `${...}` expressions only; a dot immediately followed by a digit is a mis-written array index.
    // Version strings like "1.0.0" are outside `${}` and never match.
    pattern: /\$\{[^}]*\.\d/,
    correct: '${response.items[0].id}',
  },
  {
    label: 'the retired flat field-map operation signature — use Zod object schemas',
    pattern: /\b(?:input|output):\s*\{\s*[A-Za-z0-9_]+\s*:\s*\{\s*type:/,
    correct: 'input/output: z.object({ ... })',
  },
];

describe('connector mapping syntax guard', () => {
  for (const ref of RENDERED) {
    for (const rule of FORBIDDEN) {
      it(`${ref.relPath} does not teach ${rule.label}`, () => {
        const match = ref.text.match(rule.pattern);
        const at = match?.index ?? 0;
        const context = match
          ? `Found forbidden mapping syntax near: "${ref.text
              .slice(Math.max(0, at - 20), at + 40)
              .replace(/\n/g, ' ')}". Use ${rule.correct} instead.`
          : undefined;
        expect(match, context).toBeNull();
      });
    }
  }

  it('authoring workflow still teaches the correct `${response...}` and operation-level `query`', () => {
    const authoring = RENDERED.find((r) => r.relPath.endsWith('authoring-workflow.md'));
    if (!authoring) throw new Error('authoring-workflow.md reference not found');
    // Positive guard: the correct forms must remain present so a future edit cannot silently drop them.
    expect(authoring.text).toMatch(/\$\{response\./);
    expect(authoring.text).toMatch(/query:\s*\[/);
  });

  it('connect-an-api teaches a Zod array schema for list operation output', () => {
    const connect = RENDERED.find((r) => r.relPath.endsWith('connect-an-api.md'));
    if (!connect) throw new Error('connect-an-api.md reference not found');
    expect(connect.text).toContain('output: z.object({ places: z.array(z.unknown()) })');
  });
});
