import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { appPackageArtifactV1Schema, compileAppPackage, compileManifest } from '../src/index.js';
import type { Manifest } from '../src/manifest/schema.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'app-package');
interface GuidedGuideFixture extends Record<string, unknown> {
  readonly workflows: readonly (Record<string, unknown> & {
    readonly steps: readonly Record<string, unknown>[];
  })[];
  readonly examples: readonly Record<string, unknown>[];
}

interface GuidedServerFixture extends Record<string, unknown> {
  readonly agentGuide: GuidedGuideFixture;
}

const guided = parse(readFileSync(join(fixtures, 'guided-v2.yaml'), 'utf8')) as Record<
  string,
  unknown
> & { readonly server: GuidedServerFixture };
const guidedServer = guided.server;
const guidedGuide = guidedServer.agentGuide;
const golden = JSON.parse(readFileSync(join(fixtures, 'guided-v2.golden.json'), 'utf8'));
const hostedAssets = {
  assets: [
    {
      logicalId: 'acme_logo',
      sourcePath: 'assets/acme-logo.png',
      contentHash: 'sha256:acme-logo',
      mimeType: 'image/png',
      byteLength: 1,
      width: 1,
      height: 1,
      publicUrl: 'https://cdn.acme.example/assets/acme-logo.png',
      objectKey: 'assets/acme-logo.png',
    },
    {
      logicalId: 'acme_logo_dark',
      sourcePath: 'assets/acme-logo-dark.png',
      contentHash: 'sha256:acme-logo-dark',
      mimeType: 'image/png',
      byteLength: 1,
      width: 1,
      height: 1,
      publicUrl: 'https://cdn.acme.example/assets/acme-logo-dark.png',
      objectKey: 'assets/acme-logo-dark.png',
    },
  ],
};

function compileGuide(
  agentGuide: Record<string, unknown> = guidedGuide as Record<string, unknown>,
) {
  const result = compileManifest(
    {
      ...guided,
      server: { ...guidedServer, agentGuide },
    },
    { hostedAssets },
  );
  if (result.ok && result.appPackage !== undefined) {
    expect(appPackageArtifactV1Schema.safeParse(result.appPackage).success).toBe(true);
  }
  return result;
}

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .reverse()
      .map(([key, child]) => [key, reverseObjectKeys(child)]),
  );
}

describe('App Package compilation', () => {
  it('matches the deterministic fixture golden across tools, resources, prompts, and widgets', () => {
    const result = compileGuide();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.appPackage).toEqual(golden);
    expect(result.appPackage?.surface).toMatchObject({
      tools: expect.arrayContaining([
        expect.objectContaining({ name: 'app_helper', visibility: ['app'] }),
        expect.objectContaining({ name: 'list_tasks' }),
        expect.objectContaining({ name: 'complete_task' }),
      ]),
      resources: [{ name: 'task_details' }],
      prompts: [{ name: 'summarize_task' }],
      widgets: [{ name: 'task_widget', tool: 'list_tasks' }],
    });
  });

  it('preserves existing duplicate-name validation before package emission', () => {
    const duplicate = compileManifest(
      {
        ...guided,
        tools: [
          ...(guided.tools as unknown[]),
          { ...(guided.tools as Record<string, unknown>[])[0] },
        ],
      },
      { hostedAssets },
    );
    expect(duplicate).toMatchObject({ ok: false });
    if (!duplicate.ok)
      expect(duplicate.errors).toContainEqual(expect.objectContaining({ code: 'duplicate_name' }));
  });

  it('normalizes declared visibility in fixed model/app order', () => {
    const result = compileManifest(
      {
        ...guided,
        tools: (guided.tools as Record<string, unknown>[]).map((tool) =>
          tool.name === 'complete_task' ? { ...tool, visibility: ['app', 'model'] } : tool,
        ),
      },
      { hostedAssets },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.appPackage?.surface.tools.find(({ name }) => name === 'complete_task')?.visibility,
    ).toEqual(['model', 'app']);
  });

  it('never emits a widget whose linked tool is absent from the projected surface', () => {
    const compiled = compileGuide();
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const linkedWidget = compiled.artifact.resources?.find(
      (resource) => resource.mimeType === 'text/html;profile=mcp-app',
    );
    expect(linkedWidget).toBeDefined();
    if (linkedWidget === undefined) return;

    const projected = compileAppPackage({
      manifest: guided as unknown as Manifest,
      sourceManifest: guided as unknown as Manifest,
      artifact: {
        ...compiled.artifact,
        resources: [
          ...(compiled.artifact.resources ?? []),
          { ...linkedWidget, name: 'orphan_widget', uri: 'ui://acme_tasks/orphan_widget' },
        ],
      },
    });

    expect(projected.errors).toEqual([]);
    expect(projected.appPackage?.surface.widgets).not.toContainEqual(
      expect.objectContaining({ name: 'orphan_widget' }),
    );
    for (const widget of projected.appPackage?.surface.widgets ?? []) {
      expect(projected.appPackage?.surface.tools.some((tool) => tool.name === widget.tool)).toBe(
        true,
      );
    }
  });

  it('omits a package without a guide and keeps the runtime artifact byte-stable', () => {
    const withGuide = compileGuide();
    const withoutGuide = compileManifest(
      {
        ...guided,
        server: { ...guidedServer, agentGuide: undefined },
      },
      { hostedAssets },
    );
    expect(withGuide.ok).toBe(true);
    expect(withoutGuide.ok).toBe(true);
    if (!withGuide.ok || !withoutGuide.ok) return;
    expect(withoutGuide.appPackage).toBeUndefined();
    expect(withoutGuide.artifact).toEqual(withGuide.artifact);
    expect(JSON.stringify(withGuide.artifact)).not.toMatch(
      /agentGuide|Use Acme Tasks|SKILL\.md|rendererVersion/,
    );
  });

  it.each([
    [
      'duplicate workflow',
      {
        ...guidedGuide,
        workflows: [...guidedGuide.workflows, { ...guidedGuide.workflows[0] }],
      },
      'agent_guide_duplicate_workflow',
      'server.agentGuide.workflows.1.id',
    ],
    [
      'duplicate example',
      {
        ...guidedGuide,
        examples: [...guidedGuide.examples, { ...guidedGuide.examples[0] }],
      },
      'agent_guide_duplicate_example',
      'server.agentGuide.examples.1',
    ],
  ])('reports %s before package emission', (_label, agentGuide, code, path) => {
    const result = compileGuide(agentGuide);
    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.errors).toContainEqual(expect.objectContaining({ code, path }));
  });

  it('reports missing, wrong-kind, and missing-workflow references with actionable corrections', () => {
    const missing = compileGuide({
      ...guidedGuide,
      workflows: [
        {
          ...guidedGuide.workflows[0],
          steps: [{ capability: { kind: 'tool', name: 'list_taks' } }],
        },
      ],
    });
    const wrongKind = compileGuide({
      ...guidedGuide,
      workflows: [
        {
          ...guidedGuide.workflows[0],
          steps: [{ capability: { kind: 'resource', name: 'list_tasks' } }],
        },
      ],
    });
    const missingWorkflow = compileGuide({
      ...guidedGuide,
      examples: [{ prompt: 'Review a task.', workflow: 'review_taks' }],
    });
    for (const [result, code] of [
      [missing, 'agent_guide_capability_missing'],
      [wrongKind, 'agent_guide_capability_kind'],
      [missingWorkflow, 'agent_guide_example_workflow_missing'],
    ] as const) {
      expect(result).toMatchObject({ ok: false });
      if (result.ok) continue;
      expect(result.errors).toContainEqual(expect.objectContaining({ code }));
    }
    if (!missing.ok)
      expect(missing.errors).toContainEqual(expect.objectContaining({ didYouMean: 'list_tasks' }));
    if (!wrongKind.ok)
      expect(wrongKind.errors).toContainEqual(
        expect.objectContaining({ expected: 'tool', got: 'resource' }),
      );
    if (!missingWorkflow.ok)
      expect(missingWorkflow.errors).toContainEqual(
        expect.objectContaining({ didYouMean: 'review_tasks' }),
      );
  });

  it('keeps key order irrelevant but authored step order significant', () => {
    const reordered = compileManifest(reverseObjectKeys(guided), { hostedAssets });
    const reversed = compileGuide({
      ...guidedGuide,
      workflows: [
        {
          ...guidedGuide.workflows[0],
          steps: [...guidedGuide.workflows[0].steps].reverse(),
        },
      ],
    });
    const original = compileGuide();
    expect(original.ok && reordered.ok && reversed.ok).toBe(true);
    if (!original.ok || !reordered.ok || !reversed.ok) return;
    expect(reordered.appPackage?.provenance).toEqual(original.appPackage?.provenance);
    expect(reversed.appPackage?.provenance.sourceManifestSha256).not.toBe(
      original.appPackage?.provenance.sourceManifestSha256,
    );
  });

  it('rejects guide credentials without echoing them and projects only public branding tokens and logical asset ids', () => {
    const value = ['ghp', 'a'.repeat(36)].join('_');
    const result = compileGuide({
      ...guidedGuide,
      description: `Do not use ${value}`,
    });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(JSON.stringify(result.errors)).not.toContain(value);
    const valid = compileGuide();
    expect(valid.ok).toBe(true);
    if (!valid.ok) return;
    expect(valid.appPackage?.app.branding).toEqual({
      name: 'Acme Tasks',
      accent: '#7C3AED',
      surface: '#F5F3FF',
      surfaceDark: '#161228',
      logo: {
        logicalId: 'acme_logo',
        darkLogicalId: 'acme_logo_dark',
        alt: 'Acme Tasks logo',
      },
      radius: 'lg',
      density: 'comfortable',
      typography: 'system',
      colorScheme: 'auto',
    });
    expect(JSON.stringify(valid.appPackage?.app.branding)).not.toMatch(
      /sourcePath|https?:\/\/|deployment\.acme\.example/,
    );
  });

  it.each([
    [
      'a missing capability name',
      (secret: string) => ({
        ...guidedGuide,
        workflows: [
          {
            ...guidedGuide.workflows[0],
            steps: [{ capability: { kind: 'tool', name: secret } }],
          },
        ],
      }),
    ],
    [
      'a duplicate workflow id',
      (secret: string) => ({
        ...guidedGuide,
        workflows: [
          { ...guidedGuide.workflows[0], id: secret },
          { ...guidedGuide.workflows[0], id: secret },
        ],
      }),
    ],
    [
      'a missing example workflow id',
      (secret: string) => ({
        ...guidedGuide,
        examples: [{ prompt: 'Review a task.', workflow: secret }],
      }),
    ],
  ])('preflight-rejects credential-shaped %s without semantic diagnostic echo', (_label, guide) => {
    const secret = `ghp_${'a'.repeat(36)}`;
    const result = compileGuide(guide(secret));
    expect(result).toEqual({
      ok: false,
      errors: [
        {
          code: 'app_package_sensitive_content',
          path: 'server.agentGuide',
          message: 'agent guide package contains credential-shaped content',
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('uses explicit code-unit ordering for every projected capability collection', () => {
    const baseTool = (guided.tools as Record<string, unknown>[])[0] as Record<string, unknown>;
    const baseResource = (guided.resources as Record<string, unknown>[])[0] as Record<
      string,
      unknown
    >;
    const basePrompt = (guided.prompts as Record<string, unknown>[])[0] as Record<string, unknown>;
    const names = ['_', 'a', '0'] as const;
    const result = compileManifest(
      {
        ...guided,
        server: {
          ...guidedServer,
          agentGuide: {
            ...guidedGuide,
            workflows: [
              {
                ...guidedGuide.workflows[0],
                steps: [{ capability: { kind: 'tool', name: 't0' } }],
              },
            ],
          },
        },
        tools: names.map((suffix) => ({ ...baseTool, name: `t${suffix}` })),
        resources: names.map((suffix) => ({
          ...baseResource,
          name: `r${suffix}`,
          uri: `tasks://${suffix === '_' ? 'underscore' : suffix}`,
        })),
        prompts: names.map((suffix) => ({ ...basePrompt, name: `p${suffix}` })),
        widgets: names.map((suffix) => ({
          name: `w${suffix}`,
          tool: `t${suffix}`,
          html: `<main>${suffix}</main>`,
        })),
      },
      { hostedAssets },
    );

    expect(result.ok).toBe(true);
    if (!result.ok || result.appPackage === undefined) return;
    expect(result.appPackage.surface.tools.map(({ name }) => name)).toEqual(['t0', 't_', 'ta']);
    expect(result.appPackage.surface.resources.map(({ name }) => name)).toEqual(['r0', 'r_', 'ra']);
    expect(result.appPackage.surface.prompts.map(({ name }) => name)).toEqual(['p0', 'p_', 'pa']);
    expect(result.appPackage.surface.widgets.map(({ name }) => name)).toEqual(['w0', 'w_', 'wa']);
  });

  it('sorts schema fields before truncation so reversed properties produce identical packages', () => {
    const fieldNames = Array.from(
      { length: 65 },
      (_, index) => `field_${String(index).padStart(2, '0')}`,
    );
    const properties = Object.fromEntries(
      fieldNames.map((name) => [name, { type: 'string', description: `Value for ${name}.` }]),
    );
    const reversedProperties = Object.fromEntries(Object.entries(properties).reverse());
    const withProperties = (value: Record<string, unknown>) => ({
      ...guided,
      tools: (guided.tools as Record<string, unknown>[]).map((tool, index) =>
        index === 0
          ? {
              ...tool,
              inputSchema: {
                type: 'object',
                properties: value,
                required: ['field_64'],
                additionalProperties: false,
              },
            }
          : tool,
      ),
    });

    const forward = compileManifest(withProperties(properties), { hostedAssets });
    const reversed = compileManifest(withProperties(reversedProperties), { hostedAssets });
    expect(forward.ok && reversed.ok).toBe(true);
    if (!forward.ok || !reversed.ok) return;
    expect(reversed.appPackage).toEqual(forward.appPackage);
    expect(
      forward.appPackage?.surface.tools
        .find(({ name }) => name === 'app_helper')
        ?.input.fields?.map(({ name }) => name),
    ).toEqual(fieldNames.slice(0, 64));
  });

  it('treats omitted and explicit undefined object properties as the same successful package', () => {
    const omitted = compileGuide();
    const explicit = compileManifest(
      {
        ...guided,
        server: {
          ...guidedServer,
          instructions: undefined,
        },
        tools: (guided.tools as Record<string, unknown>[]).map((tool) => ({
          ...tool,
          title: undefined,
        })),
      },
      { hostedAssets },
    );
    expect(omitted.ok && explicit.ok).toBe(true);
    if (!omitted.ok || !explicit.ok) return;
    expect(explicit.appPackage).toEqual(omitted.appPackage);
  });
});
