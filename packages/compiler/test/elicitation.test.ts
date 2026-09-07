import { describe, expect, it } from 'vitest';
import { compile } from '../src/compile.js';

function manifest(requestedSchema: string): string {
  return `manifestVersion: "1"
server:
  name: input_demo
  version: 1.0.0
  title: Input demo
tools:
  - name: ask
    description: Ask for one missing value.
    inputSchema:
      type: object
    fulfilment:
      steps:
        - id: choose_team
          elicit:
            message: Which team should receive this request?
            requestedSchema:
${requestedSchema
  .split('\n')
  .map((line) => `              ${line}`)
  .join('\n')}
      output:
        team: \${steps.choose_team.team}
`;
}

describe('Core v1.x elicitation step', () => {
  it('compiles the portable form subset into an internal elicit step', () => {
    const result = compile(
      manifest(`type: object
properties:
  team:
    type: string
    enum: [noodle, platform]
required: [team]
additionalProperties: false`),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.tools[0]?.fulfilment).toMatchObject({
      kind: 'flow',
      steps: [
        {
          id: 'choose_team',
          kind: 'elicit',
          message: 'Which team should receive this request?',
          requestedSchema: {
            type: 'object',
            properties: { team: { type: 'string', enum: ['noodle', 'platform'] } },
            required: ['team'],
          },
        },
      ],
    });
  });

  it.each([
    [
      'nested objects',
      `type: object
properties:
  nested:
    type: object
    properties:
      value: { type: string }`,
    ],
    [
      'credential-shaped fields',
      `type: object
properties:
  apiKey: { type: string }`,
    ],
    [
      'unsupported string formats',
      `type: object
properties:
  value: { type: string, format: password }`,
    ],
  ])('rejects %s with invalid_elicitation_schema', (_label, schema) => {
    const result = compile(manifest(schema));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'invalid_elicitation_schema',
        path: expect.stringContaining('requestedSchema'),
      }),
    );
  });

  it('rejects an elicitation after an operation in every interactive flow', () => {
    const result = compile(`
manifestVersion: "1"
server:
  name: unsafe_order
  version: 1.0.0
  title: Unsafe order
tools:
  - name: submit
    description: Submit after asking for input too late.
    annotations:
      confirm: true
    inputSchema:
      type: object
    fulfilment:
      steps:
        - id: write
          use: orders.submit
        - id: choose_team
          elicit:
            message: Which team?
            requestedSchema:
              type: object
              properties:
                team: { type: string }
              required: [team]
      output:
        team: \${steps.choose_team.team}
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual({
      code: 'invalid_elicitation_flow',
      path: 'tools.0.fulfilment.steps.1.elicit',
      message: 'interactive flows must collect all elicited input before the first operation',
    });
  });

  it('preserves the Core v1 at-most-one-operation confirmation contract', () => {
    const result = compile(`
manifestVersion: "1"
server:
  name: unsafe_batch
  version: 1.0.0
  title: Unsafe batch
tools:
  - name: submit
    description: Never approve hidden later operations.
    annotations:
      confirm: true
    inputSchema: { type: object }
    fulfilment:
      steps:
        - id: first
          use: orders.prepare
        - id: second
          use: orders.submit
      output:
        ok: true
`);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual({
      code: 'invalid_confirmation_flow',
      path: 'tools.0.fulfilment.steps.1.use',
      message: 'confirmed Core v1 flows may contain at most one connector operation',
    });
  });

  it('allows Core v2 conditional action candidates followed by a read', () => {
    const result = compile(`
manifestVersion: "2"
server:
  name: routed_action
  version: 1.0.0
  title: Routed action
tools:
  - name: submit
    description: Route exactly one account action and merge the result.
    annotations:
      confirm: true
    inputSchema:
      type: object
      properties:
        account: { type: string }
      required: [account]
    fulfilment:
      steps:
        - id: personal
          if: \${input.account === "personal"}
          use: orders.submit_personal
        - id: work
          if: \${input.account === "work"}
          use: orders.submit_work
        - id: merge
          use: orders.read_result
      output:
        ok: true
`);

    expect(result.ok).toBe(true);
  });

  it('preserves a map and repeated-elicitation prefix before a confirmable operation', () => {
    const result = compile(`
manifestVersion: "1"
server:
  name: prepared_order
  version: 1.0.0
  title: Prepared order
tools:
  - name: submit
    description: Collect and shape every reviewed value before writing.
    annotations:
      confirm: true
    inputSchema:
      type: object
      properties:
        days: { type: integer }
      required: [days]
    fulfilment:
      steps:
        - id: copy_days
          map:
            days: \${input.days}
        - id: choose_reason
          elicit:
            message: Why are you taking leave?
            requestedSchema:
              type: object
              properties:
                reason: { type: string }
              required: [reason]
        - id: copy_reason
          map:
            reason: \${steps.choose_reason.reason}
        - id: choose_team
          elicit:
            message: Which team?
            requestedSchema:
              type: object
              properties:
                team: { type: string }
              required: [team]
        - id: write
          use: orders.submit
          args:
            days: \${steps.copy_days.days}
            reason: \${steps.copy_reason.reason}
            team: \${steps.choose_team.team}
      output:
        requestId: \${steps.write.requestId}
`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const fulfilment = result.artifact.tools[0]?.fulfilment;
    expect(fulfilment?.kind).toBe('flow');
    if (fulfilment?.kind !== 'flow') return;
    expect(fulfilment.steps.map((step) => [step.id, step.kind])).toEqual([
      ['copy_days', 'map'],
      ['choose_reason', 'elicit'],
      ['copy_reason', 'map'],
      ['choose_team', 'elicit'],
      ['write', 'operation'],
    ]);
  });

  it('rejects operation-before-elicitation even when confirmation is explicitly disabled', () => {
    const result = compile(`
manifestVersion: "1"
server:
  name: direct_order
  version: 1.0.0
  title: Direct order
tools:
  - name: submit
    description: A direct adapter-owned interaction.
    annotations:
      confirm: false
    inputSchema:
      type: object
    fulfilment:
      steps:
        - id: read
          use: orders.read
        - id: choose_team
          elicit:
            message: Which team?
            requestedSchema:
              type: object
              properties:
                team: { type: string }
              required: [team]
      output:
        team: \${steps.choose_team.team}
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual({
      code: 'invalid_elicitation_flow',
      path: 'tools.0.fulfilment.steps.1.elicit',
      message: 'interactive flows must collect all elicited input before the first operation',
    });
  });
});
