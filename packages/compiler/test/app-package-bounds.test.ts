import { describe, expect, it } from 'vitest';
import { appPackageArtifactV1Schema, compileManifest } from '../src/index.js';

const SHA = 'a'.repeat(64);

function tool(name: string, patch: Record<string, unknown> = {}) {
  return {
    name,
    description: `Use ${name}.`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    fulfilment: { steps: [], output: { ok: true } },
    ...patch,
  };
}

function guidedManifest(tools: readonly Record<string, unknown>[], workflowId = 'use_tool') {
  return {
    manifestVersion: '2',
    server: {
      name: 'bounded_package',
      title: 'Bounded Package',
      version: '1.0.0',
      agentGuide: {
        description: 'Use the bounded package.',
        useWhen: ['A bounded operation is required.'],
        workflows: [
          {
            id: workflowId,
            title: 'Use the package',
            steps: [{ capability: { kind: 'tool', name: String(tools[0]?.name) } }],
          },
        ],
        boundaries: [],
        examples: [{ prompt: 'Use it.', workflow: workflowId }],
      },
    },
    tools,
  };
}

function artifact(toolCount = 1) {
  return {
    schemaVersion: '1',
    app: { name: 'bounded_package', title: 'Bounded Package', version: '1.0.0' },
    skill: {
      description: 'Use the bounded package.',
      useWhen: ['A bounded operation is required.'],
      workflows: [
        {
          id: 'use_tool',
          title: 'Use the package',
          steps: [{ capability: { kind: 'tool', name: 'tool_0' } }],
        },
      ],
      boundaries: [],
      examples: [{ prompt: 'Use it.', workflow: 'use_tool' }],
    },
    surface: {
      auth: { required: false },
      tools: Array.from({ length: toolCount }, (_, index) => ({
        kind: 'tool',
        name: `tool_${index}`,
        description: `Use tool ${index}.`,
        input: { type: 'object', fields: [] },
        behavior: {
          readOnly: true,
          destructive: false,
          idempotent: true,
          openWorld: false,
          confirmationRequired: false,
        },
        visibility: ['model', 'app'],
      })),
      resources: [],
      prompts: [],
      widgets: [],
    },
    provenance: {
      sourceManifestSha256: SHA,
      mcpSurfaceSha256: SHA,
      compilerVersion: '1',
    },
  };
}

describe('App Package V1 bounds', () => {
  it('accepts package identifiers at 200 characters and rejects 201', () => {
    const exact = 'a'.repeat(200);
    const tooLong = 'a'.repeat(201);
    expect(
      appPackageArtifactV1Schema.safeParse({
        ...artifact(),
        skill: {
          ...artifact().skill,
          workflows: [{ ...artifact().skill.workflows[0], id: exact }],
          examples: [],
        },
      }).success,
    ).toBe(true);
    expect(
      appPackageArtifactV1Schema.safeParse({
        ...artifact(),
        skill: {
          ...artifact().skill,
          workflows: [{ ...artifact().skill.workflows[0], id: tooLong }],
          examples: [],
        },
      }).success,
    ).toBe(false);

    const exactCompile = compileManifest(guidedManifest([tool('tool_0')], exact));
    expect(exactCompile.ok).toBe(true);
  });

  it('preserves a valid Core server name above the package identifier bound', () => {
    const coreName = 'a'.repeat(201);
    expect(
      appPackageArtifactV1Schema.safeParse({
        ...artifact(),
        app: { ...artifact().app, name: coreName },
      }).success,
    ).toBe(true);

    const source = guidedManifest([tool('tool_0')]);
    const compiled = compileManifest({
      ...source,
      server: { ...source.server, name: coreName },
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.appPackage?.app.name).toBe(coreName);
  });

  it('accepts prose at 4,000 characters and rejects 4,001', () => {
    expect(
      appPackageArtifactV1Schema.safeParse({
        ...artifact(),
        skill: { ...artifact().skill, description: 'x'.repeat(4_000) },
      }).success,
    ).toBe(true);
    expect(
      appPackageArtifactV1Schema.safeParse({
        ...artifact(),
        skill: { ...artifact().skill, description: 'x'.repeat(4_001) },
      }).success,
    ).toBe(false);
  });

  it('accepts 256 surface items and rejects 257 in both schema and projection', () => {
    expect(appPackageArtifactV1Schema.safeParse(artifact(256)).success).toBe(true);
    expect(appPackageArtifactV1Schema.safeParse(artifact(257)).success).toBe(false);

    const exact = compileManifest(
      guidedManifest(Array.from({ length: 256 }, (_, index) => tool(`tool_${index}`))),
    );
    const tooMany = compileManifest(
      guidedManifest(Array.from({ length: 257 }, (_, index) => tool(`tool_${index}`))),
    );
    expect(exact.ok).toBe(true);
    expect(tooMany).toEqual({
      ok: false,
      errors: [
        {
          code: 'agent_guide_invalid',
          path: 'server.agentGuide',
          message: 'agent guide package is outside App Package V1 bounds',
        },
      ],
    });
  });

  it.each([
    [
      'authorization arrays',
      () => {
        const scopes = Array.from(
          { length: 128 },
          (_, index) => `s${String(index).padStart(3, '0')}_${'a'.repeat(507)}`,
        );
        return guidedManifest(
          Array.from({ length: 5 }, (_, index) =>
            tool(`tool_${index}`, { authorization: { requiredScopes: scopes } }),
          ),
        );
      },
    ],
    [
      'schema summaries',
      () => {
        const properties = Object.fromEntries(
          Array.from({ length: 64 }, (_, index) => [
            `field_${index}`,
            { type: 'string', description: 'x'.repeat(4_000) },
          ]),
        );
        return guidedManifest(
          Array.from({ length: 2 }, (_, index) =>
            tool(`tool_${index}`, {
              inputSchema: { type: 'object', properties, additionalProperties: false },
            }),
          ),
        );
      },
    ],
  ])('rejects a canonical artifact over 256 KiB built from bounded %s', (_label, build) => {
    expect(compileManifest(build())).toEqual({
      ok: false,
      errors: [
        {
          code: 'agent_guide_invalid',
          path: 'server.agentGuide',
          message: 'agent guide package is outside App Package V1 bounds',
        },
      ],
    });
  });

  it('rejects an oversized direct artifact even when each nested field is within its own bound', () => {
    const oversized = {
      ...artifact(),
      skill: {
        ...artifact().skill,
        boundaries: Array.from({ length: 64 }, () => 'x'.repeat(4_000)),
        examples: Array.from({ length: 64 }, () => ({
          prompt: 'x'.repeat(4_000),
          workflow: 'use_tool',
        })),
      },
    };
    expect(appPackageArtifactV1Schema.safeParse(oversized).success).toBe(false);
    expect(
      appPackageArtifactV1Schema.safeParse({
        ...artifact(),
        surface: {
          ...artifact().surface,
          tools: [{ ...artifact().surface.tools[0], authorization: {} }],
        },
      }).success,
    ).toBe(false);
  });
});
