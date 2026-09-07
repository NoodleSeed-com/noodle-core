import {
  AGENT_GUIDE_MAX_BOUNDARIES,
  AGENT_GUIDE_MAX_EXAMPLES,
  AGENT_GUIDE_MAX_STEPS,
  AGENT_GUIDE_MAX_USE_WHEN,
  AGENT_GUIDE_MAX_WORKFLOWS,
} from '@noodle-borg/app-package';
import { describe, expect, it } from 'vitest';
import { compileManifest } from '../src/index.js';

const tool = {
  name: 'whoami',
  description: 'Show the caller',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  fulfilment: { steps: [], output: { ok: true } },
};

describe('Core v2 boundary', () => {
  it('accepts a valid product agent guide only in Core v2', () => {
    const result = compileManifest(manifestWithAgentGuide(validAgentGuide()));

    expect(result.ok).toBe(true);
  });

  it('keeps Core v1 forward-compatible by stripping a product agent guide', () => {
    const result = compileManifest({
      ...manifestWithAgentGuide(validAgentGuide()),
      manifestVersion: '1',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(result.artifact)).not.toContain('agentGuide');
  });

  it.each([
    ['empty description', { description: '' }, 'server.agentGuide.description'],
    ['empty useWhen', { useWhen: [] }, 'server.agentGuide.useWhen'],
    ['empty workflows', { workflows: [] }, 'server.agentGuide.workflows'],
    [
      'empty workflow steps',
      { workflows: [{ ...validAgentGuide().workflows[0], steps: [] }] },
      'server.agentGuide.workflows.0.steps',
    ],
    [
      'blank guidance',
      {
        workflows: [
          {
            ...validAgentGuide().workflows[0],
            steps: [{ capability: { kind: 'tool', name: 'whoami' }, guidance: '   ' }],
          },
        ],
      },
      'server.agentGuide.workflows.0.steps.0.guidance',
    ],
    [
      'blank example prompt',
      { examples: [{ prompt: ' ', workflow: 'review_tasks' }] },
      'server.agentGuide.examples.0.prompt',
    ],
  ])('rejects an agent guide with %s at its exact path', (_label, partial, path) => {
    const result = compileManifest(manifestWithAgentGuide({ ...validAgentGuide(), ...partial }));

    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: 'agent_guide_invalid', path }),
    );
  });

  it.each([
    [
      'useWhen',
      {
        useWhen: Array.from(
          { length: AGENT_GUIDE_MAX_USE_WHEN + 1 },
          (_, index) => `Use case ${index}`,
        ),
      },
      'server.agentGuide.useWhen',
    ],
    [
      'workflows',
      {
        workflows: Array.from({ length: AGENT_GUIDE_MAX_WORKFLOWS + 1 }, (_, index) => ({
          ...validAgentGuide().workflows[0],
          id: `workflow_${index}`,
        })),
      },
      'server.agentGuide.workflows',
    ],
    [
      'steps',
      {
        workflows: [
          {
            ...validAgentGuide().workflows[0],
            steps: Array.from({ length: AGENT_GUIDE_MAX_STEPS + 1 }, () => ({
              capability: { kind: 'tool', name: 'whoami' },
            })),
          },
        ],
      },
      'server.agentGuide.workflows.0.steps',
    ],
    [
      'boundaries',
      {
        boundaries: Array.from(
          { length: AGENT_GUIDE_MAX_BOUNDARIES + 1 },
          (_, index) => `Boundary ${index}`,
        ),
      },
      'server.agentGuide.boundaries',
    ],
    [
      'examples',
      {
        examples: Array.from({ length: AGENT_GUIDE_MAX_EXAMPLES + 1 }, (_, index) => ({
          prompt: `Prompt ${index}`,
          workflow: 'review_tasks',
        })),
      },
      'server.agentGuide.examples',
    ],
  ])('rejects %s above the guide collection bound', (_label, partial, path) => {
    const result = compileManifest(manifestWithAgentGuide({ ...validAgentGuide(), ...partial }));

    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: 'agent_guide_invalid', path }),
    );
  });

  it.each([
    [
      'workflow identifier',
      { workflows: [{ ...validAgentGuide().workflows[0], id: 'Review Tasks' }] },
      'server.agentGuide.workflows.0.id',
    ],
    [
      'example workflow identifier',
      { examples: [{ prompt: 'Review the queue.', workflow: 'Review Tasks' }] },
      'server.agentGuide.examples.0.workflow',
    ],
  ])('requires lowercase underscore %s', (_label, partial, path) => {
    const result = compileManifest(manifestWithAgentGuide({ ...validAgentGuide(), ...partial }));

    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: 'agent_guide_invalid', path }),
    );
  });

  it('keeps a persisted Core-v1 generic bridge manifest valid', () => {
    expect(
      compileManifest({
        manifestVersion: '1',
        server: {
          name: 'legacy_bridge',
          title: 'Legacy Bridge',
          version: '1.0.0',
          auth: { kind: 'bridge', provider: 'custom', verifyUrl: 'https://app.example/verify' },
        },
        tools: [tool],
      }).ok,
    ).toBe(true);
  });

  it('rejects a generic bridge in Core v2 while accepting federated OIDC', () => {
    const generic = compileManifest({
      manifestVersion: '2',
      server: {
        name: 'new_bridge',
        title: 'New Bridge',
        version: '1.0.0',
        auth: { kind: 'bridge', provider: 'custom', verifyUrl: 'https://app.example/verify' },
      },
      tools: [tool],
    });
    expect(generic.ok).toBe(false);

    expect(
      compileManifest({
        manifestVersion: '2',
        server: {
          name: 'federated_app',
          title: 'Federated App',
          version: '1.0.0',
          auth: {
            kind: 'federatedOidc',
            issuers: [{ issuer: 'https://id.example', audience: 'api://federated-app' }],
          },
        },
        tools: [tool],
      }).ok,
    ).toBe(true);
  });

  it.each([
    ['exact duplicates', 'https://id.example', 'https://id.example'],
    ['trailing-slash-equivalent duplicates', 'https://id.example', 'https://id.example/'],
  ])('rejects %s in a federated OIDC issuer list', (_label, firstIssuer, secondIssuer) => {
    const result = compileManifest(manifestWithFederatedIssuers([firstIssuer, secondIssuer]));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected duplicate issuer validation to fail');
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'invalid_shape',
        path: 'server.auth.issuers.1.issuer',
        message: expect.stringContaining('unique'),
      }),
    );
  });

  it('preserves distinct federated OIDC issuers', () => {
    expect(
      compileManifest(
        manifestWithFederatedIssuers(['https://first.id.example', 'https://second.id.example/']),
      ).ok,
    ).toBe(true);
  });
});

function validAgentGuide() {
  return {
    description: 'Use Acme Tasks to inspect and update the team task list.',
    useWhen: ['The user asks about Acme work items.'],
    workflows: [
      {
        id: 'review_tasks',
        title: 'Review tasks',
        intent: 'Ground the requested task before changing it.',
        steps: [{ capability: { kind: 'tool', name: 'whoami' } }],
      },
    ],
    boundaries: ['Never invent a task identifier.'],
    examples: [{ prompt: 'Review today’s tasks.', workflow: 'review_tasks' }],
  };
}

function manifestWithAgentGuide(agentGuide: ReturnType<typeof validAgentGuide>) {
  return {
    manifestVersion: '2' as const,
    server: {
      name: 'guided_app',
      title: 'Guided App',
      version: '1.0.0',
      agentGuide,
    },
    tools: [tool],
  };
}

function manifestWithFederatedIssuers(issuers: readonly string[]) {
  return {
    manifestVersion: '2',
    server: {
      name: 'federated_app',
      title: 'Federated App',
      version: '1.0.0',
      auth: {
        kind: 'federatedOidc',
        issuers: issuers.map((issuer, index) => ({
          issuer,
          audience: `api://federated-app-${index}`,
        })),
      },
    },
    tools: [tool],
  };
}
