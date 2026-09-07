import { describe, expect, it } from 'vitest';
import { compile } from '../src/compile.js';

/**
 * Core v1 reserved step verb (ADR 0150): `compute` remains named by the spec but unavailable. `elicit`
 * landed as an additive v1.x verb and is covered by elicitation.test.ts.
 */

function manifestWithSteps(steps: string): string {
  return `manifestVersion: "1"
server:
  name: acme_support
  version: 1.0.0
  title: Acme Support
tools:
  - name: track_order
    description: Track an order.
    inputSchema:
      type: object
    fulfilment:
      steps:
${steps
  .split('\n')
  .map((line) => `        ${line}`)
  .join('\n')}
      output:
        ok: true
`;
}

describe('reserved step verbs (Core v1)', () => {
  it('rejects a compute step with reserved_for_future_version at the step path', () => {
    const result = compile(
      manifestWithSteps(`- id: derive
  compute:
    expr: 1 + 1`),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'reserved_for_future_version',
        path: 'tools.0.fulfilment.steps.0.compute',
      }),
    );
  });

  it('reports every reserved compute occurrence across tools, resources, and prompts', () => {
    const result = compile(`manifestVersion: "1"
server:
  name: acme_support
  version: 1.0.0
  title: Acme Support
tools:
  - name: track_order
    description: Track an order.
    inputSchema:
      type: object
    fulfilment:
      steps:
        - id: confirm
          compute:
            expr: 1
      output:
        ok: true
resources:
  - name: order_doc
    uri: doc://orders
    fulfilment:
      steps:
        - id: derive
          compute:
            expr: 1
      output:
        ok: true
prompts:
  - name: order_prompt
    fulfilment:
      steps:
        - id: ask
          compute:
            expr: 1
      output:
        ok: true
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const reserved = result.errors.filter((e) => e.code === 'reserved_for_future_version');
    expect(reserved.map((e) => e.path).sort()).toEqual([
      'prompts.0.fulfilment.steps.0.compute',
      'resources.0.fulfilment.steps.0.compute',
      'tools.0.fulfilment.steps.0.compute',
    ]);
    for (const error of reserved) {
      expect(error.message).toMatch(/reserved for a future core version/);
    }
  });

  it('does not affect manifests using only v1 verbs', () => {
    const result = compile(
      manifestWithSteps(`- id: shaped
  map:
    ok: true`),
    );
    expect(result.ok).toBe(true);
  });
});
