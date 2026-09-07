import { describe, expect, it } from 'vitest';
import { compile } from '../src/compile.js';

const BASE = `
manifestVersion: "1"
server:
  name: required_caps
  version: 1.0.0
  title: Required Caps
tools:
  - name: ping
    description: Ping.
    inputSchema:
      type: object
    fulfilment:
      steps: []
      output:
        ok: true
`;

describe('manifest capability requirements', () => {
  it('emits allowed infrastructure requirements into the runtime artifact', () => {
    const result = compile(`
${BASE}
requires:
  audit: true
  identity: true
  controls: true
`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.requirements?.capabilities).toEqual(['identity', 'controls', 'audit']);
  });

  it('rejects deprecated app-author aliases with canonical suggestions', () => {
    const result = compile(`
${BASE}
requires:
  customerAuth: true
  rateLimits: true
`);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'invalid_capability_requirement',
        path: 'requires.customerAuth',
        didYouMean: 'identity',
      }),
    );
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'invalid_capability_requirement',
        path: 'requires.rateLimits',
        didYouMean: 'controls',
      }),
    );
  });

  it('rejects module/package names in requirements', () => {
    const result = compile(`
${BASE}
requires:
  "@vendor/module-audit": true
`);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'invalid_capability_requirement',
        path: 'requires.@vendor/module-audit',
        didYouMean: 'audit',
      }),
    );
  });

  it('rejects tenant attempts to declare module loading in the manifest', () => {
    const result = compile(`
${BASE}
modules:
  - package: "@vendor/module-audit"
requires:
  audit: true
`);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'invalid_shape',
        path: 'modules',
      }),
    );
  });

  it('rejects non-requirable product capabilities with explanations', () => {
    const result = compile(`
${BASE}
requires:
  builder: true
  observability: true
  connectors: true
  secrets: true
`);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    for (const name of ['builder', 'observability', 'connectors', 'secrets']) {
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'invalid_capability_requirement',
          path: `requires.${name}`,
        }),
      );
    }
  });
});
