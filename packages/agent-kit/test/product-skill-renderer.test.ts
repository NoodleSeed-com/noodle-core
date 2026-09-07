import { describe, expect, it } from 'vitest';
import {
  contentSha256,
  createProductSkillState,
  decodeProductSkillState,
  PRODUCT_SKILL_VALIDATION_LIMITS,
  ProductSkillRenderError,
  renderProductSkillBundle,
} from '../src/index.js';

const SHA = 'a'.repeat(64);

interface RenderedProductSkillFileMutation {
  path: string;
}

function input(overrides: Record<string, unknown> = {}) {
  const value = {
    schemaVersion: '1' as const,
    app: { name: 'acme_tasks', title: 'Acme Tasks', version: '1.0.0' },
    skill: {
      description: 'Use Acme Tasks to review work.',
      useWhen: ['A user asks to review work.'],
      workflows: [
        {
          id: 'review_tasks',
          title: 'Review tasks',
          steps: [{ capability: { kind: 'tool' as const, name: 'list_tasks' } }],
        },
      ],
      boundaries: ['Do not invent task IDs.'],
      examples: [{ prompt: 'Review my tasks.', workflow: 'review_tasks' }],
    },
    surface: {
      auth: { required: false },
      tools: [
        {
          kind: 'tool' as const,
          name: 'list_tasks',
          description: 'List current tasks.',
          input: { type: 'object' },
          behavior: {
            readOnly: true,
            destructive: false,
            idempotent: true,
            openWorld: false,
            confirmationRequired: false,
          },
          visibility: ['model' as const],
        },
      ],
      resources: [],
      prompts: [],
      widgets: [],
    },
    provenance: {
      sourceManifestSha256: SHA,
      mcpSurfaceSha256: 'b'.repeat(64),
      compilerVersion: '1' as const,
    },
  };
  return { ...value, ...overrides };
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

function expectRenderError(value: unknown, code: ProductSkillRenderError['code']) {
  try {
    renderProductSkillBundle(value as ReturnType<typeof input>);
    throw new Error('expected render to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(ProductSkillRenderError);
    expect((error as ProductSkillRenderError).code).toBe(code);
  }
}

function countStrings(value: unknown): number {
  if (typeof value === 'string') return 1;
  if (Array.isArray(value)) return value.reduce((total, entry) => total + countStrings(entry), 0);
  if (value === null || typeof value !== 'object') return 0;
  return Object.values(value).reduce((total, entry) => total + countStrings(entry), 0);
}

describe('product skill bundle rendering', () => {
  it('renders byte-identical Codex and Claude projections with complete hashes', () => {
    const first = renderProductSkillBundle(input());
    const second = renderProductSkillBundle(input());

    expect(first).toEqual(second);
    expect(first.schemaVersion).toBe(1);
    expect(first.files.map((file) => file.path)).toEqual([
      '.agents/skills/acme-tasks/SKILL.md',
      '.agents/skills/acme-tasks/references/mcp-surface.md',
      '.claude/skills/acme-tasks/SKILL.md',
      '.claude/skills/acme-tasks/references/mcp-surface.md',
    ]);
    expect(first.files.map((file) => file.target)).toEqual([
      'codex',
      'codex',
      'claude-code',
      'claude-code',
    ]);
    expect(first.files[0]?.content).toBe(first.files[2]?.content);
    expect(first.files[1]?.content).toBe(first.files[3]?.content);
    for (const file of first.files) {
      expect(file.sha256).toBe(contentSha256(file.content));
      expect(file.byteLength).toBe(Buffer.byteLength(file.content, 'utf8'));
    }
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.files)).toBe(true);
    expect(Object.isFrozen(first.files[0])).toBe(true);
  });

  it('binds V2 ownership to the bundle-v1 slug and previews valid V1 migration', () => {
    const artifact = input();
    const bundle = renderProductSkillBundle(artifact);
    const state = createProductSkillState({
      target: 'codex',
      artifact,
      bundle,
      files: bundle.files.filter((file) => file.target === 'codex'),
    });

    expect(decodeProductSkillState(state, 'codex')).toEqual({
      state,
      migrationRequired: false,
    });
    const { bundleSchemaVersion: _bundleSchemaVersion, ...legacy } = state;
    expect(decodeProductSkillState({ ...legacy, schemaVersion: 1 }, 'codex')).toMatchObject({
      state,
      migrationRequired: true,
    });
    expect(
      decodeProductSkillState(
        { ...state, app: { name: state.app.name, skillSlug: 'unowned-skill' } },
        'codex',
      ),
    ).toBeUndefined();
  });

  it('binds ownership state to the bounded fallback slug used by rendered files', () => {
    const artifact = input({ app: { ...input().app, name: 'a'.repeat(65) } });
    const bundle = renderProductSkillBundle(artifact);
    const files = bundle.files.filter((file) => file.target === 'codex');
    const state = createProductSkillState({ target: 'codex', artifact, bundle, files });

    expect(state.app.skillSlug).toMatch(/^n-h[a-f0-9]{59}-n$/);
    expect(files.every((file) => file.path.includes(`/${state.app.skillSlug}/`))).toBe(true);
    expect(decodeProductSkillState(state, 'codex')).toEqual({
      state,
      migrationRequired: false,
    });
  });

  it('is deterministic under input object-key reordering and sensitive to rendered content and provenance', () => {
    const original = renderProductSkillBundle(input());
    const reordered = renderProductSkillBundle(
      reverseObjectKeys(input()) as ReturnType<typeof input>,
    );
    const changedContent = renderProductSkillBundle(
      input({ skill: { ...input().skill, description: 'Use Acme Tasks to complete work.' } }),
    );
    const changedProvenance = renderProductSkillBundle(
      input({
        provenance: { ...input().provenance, sourceManifestSha256: 'c'.repeat(64) },
      }),
    );

    expect(reordered).toEqual(original);
    expect(changedContent.files[0]?.sha256).not.toBe(original.files[0]?.sha256);
    expect(changedContent.bundleSha256).not.toBe(original.bundleSha256);
    expect(changedProvenance.bundleSha256).not.toBe(original.bundleSha256);
  });

  it('does not retain mutable input references and rejects nested output mutation', () => {
    const value = input();
    const rendered = renderProductSkillBundle(value);
    value.skill.boundaries[0] = 'Mutated after render.';

    expect(rendered.files[0]?.content).toContain('Do not invent task IDs.');
    expect(rendered.files[0]?.content).not.toContain('Mutated after render.');
    expect(() => {
      (rendered.files as RenderedProductSkillFileMutation[]).push(
        {} as RenderedProductSkillFileMutation,
      );
    }).toThrow(TypeError);
    expect(() => {
      (rendered.files[0] as RenderedProductSkillFileMutation).path = 'mutated';
    }).toThrow(TypeError);
  });

  it('rejects a rendered SKILL.md above the 500-line host budget', () => {
    const workflow = input().skill.workflows[0];
    expectRenderError(
      input({
        skill: {
          ...input().skill,
          workflows: Array.from({ length: 8 }, (_, index) => ({
            ...workflow,
            id: `review_tasks_${index}`,
            steps: Array.from({ length: 64 }, () => workflow?.steps[0]),
          })),
          examples: [],
        },
      }),
      'app_package_file_too_large',
    );
  });

  it('classifies traversal-budget exhaustion as invalid input, not sensitive content', () => {
    const sourceTool = input().surface.tools[0];
    const value = input({
      surface: {
        ...input().surface,
        tools: Array.from({ length: 80 }, (_, toolIndex) => ({
          ...sourceTool,
          name: `tool_${toolIndex}`,
          authorization: { requiredScopes: Array.from({ length: 128 }, () => 's') },
        })),
      },
    });

    expect(countStrings(value)).toBeGreaterThan(10_000);
    expect(Buffer.byteLength(JSON.stringify(value), 'utf8')).toBeLessThanOrEqual(
      PRODUCT_SKILL_VALIDATION_LIMITS.artifactBytes,
    );
    expectRenderError(value, 'app_package_invalid');
  });

  it('keeps ordinary Bearer authorization prose aligned with compiler acceptance', () => {
    expect(() =>
      renderProductSkillBundle(
        input({
          skill: {
            ...input().skill,
            description: 'Use a Bearer authorization header when the product requires one.',
          },
        }),
      ),
    ).not.toThrow();
  });

  it.each([
    ['an invalid schema version', input({ schemaVersion: '2' }), 'app_package_invalid'],
    [
      'a traversal server name',
      input({ app: { name: '../../escape' } }),
      'app_package_unsafe_path',
    ],
    ['an absolute server name', input({ app: { name: '/absolute' } }), 'app_package_unsafe_path'],
    ['a NUL server name', input({ app: { name: 'acme\0tasks' } }), 'app_package_unsafe_path'],
    [
      'blank skill content',
      input({ skill: { ...input().skill, description: '' } }),
      'app_package_invalid',
    ],
    [
      'an empty when-to-use list',
      input({ skill: { ...input().skill, useWhen: [] } }),
      'app_package_invalid',
    ],
    [
      'a nested reference path',
      input({ app: { name: 'acme_tasks/references/nested' } }),
      'app_package_unsafe_path',
    ],
    [
      'a file over 64 KiB',
      input({
        skill: {
          ...input().skill,
          boundaries: Array.from({ length: 17 }, () => 'x'.repeat(3_900)),
        },
      }),
      'app_package_file_too_large',
    ],
    [
      'aggregate output over 256 KiB',
      input({
        skill: {
          ...input().skill,
          boundaries: Array.from({ length: 17 }, () => 'x'.repeat(3_900)),
        },
        surface: {
          ...input().surface,
          tools: Array.from({ length: 17 }, (_, index) => ({
            ...input().surface.tools[0],
            name: index === 0 ? 'list_tasks' : `list_tasks_${index}`,
            description: 'x'.repeat(3_900),
          })),
        },
      }),
      'app_package_total_too_large',
    ],
  ])('rejects %s', (_label, value, code) => {
    expectRenderError(value, code as ProductSkillRenderError['code']);
  });

  it.each([
    ['GitHub token', `ghp_${'a'.repeat(36)}`],
    ['alphabetic Bearer credential', 'Bearer abcdefghijklmnop'],
    ['bare JWT', ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ1c2VyIn0', 'signature'].join('.')],
    [
      'assignment-delimited JWT',
      `jwt=${['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ1c2VyIn0', 'signature'].join('.')}`,
    ],
    [
      'parenthesized JWT',
      `(${['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ1c2VyIn0', 'signature'].join('.')})`,
    ],
    ['quoted JWT', `"${['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ1c2VyIn0', 'signature'].join('.')}"`],
  ])('rejects credential-shaped %s without echoing it', (_label, secret) => {
    try {
      renderProductSkillBundle(input({ skill: { ...input().skill, boundaries: [secret] } }));
      throw new Error('expected render to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ProductSkillRenderError);
      expect((error as ProductSkillRenderError).code).toBe('app_package_sensitive_content');
      expect(JSON.stringify(error)).not.toContain(secret);
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it.each([
    ['duplicate model visibility', ['model', 'model']],
    ['duplicate app visibility', ['app', 'app']],
    ['unbounded visibility', ['model', 'app', 'model']],
    ['non-canonical visibility order', ['app', 'model']],
  ])('rejects direct Agent Kit input with %s', (_label, visibility) => {
    expectRenderError(
      input({
        surface: {
          ...input().surface,
          tools: [{ ...input().surface.tools[0], visibility }],
        },
      }),
      'app_package_invalid',
    );
  });

  it.each([
    ['_a', 'n-h34fb716034edaa881d9e64134f6c40f245d7b187d221ec6c63670c428a0-n'],
    ['a_', 'n-h571fb0e30b4dd94baf8b337b9e622e5b7300ef7329f2c778a2ba5559199-n'],
    ['a__b', 'n-h63e5c1c455d01d5cbcbadd205443a58a924850e94899983d18552517a82-n'],
    ['___', 'n-hbda251550bf0478f4172a8aeb291d6543fea090150b82c3e2881a53721e-n'],
    [`n_h${'a'.repeat(59)}_n`, 'n-h1c13c06b5a16c3fd702d61b29db7cc6fb30e5ef0b482c0da2849593c8ad-n'],
    ['a'.repeat(65), 'n-h635361c48bb9eab14198e76ea8ab7f1a41685d6ad62aa9146d301d4f17e-n'],
    ['acme_tasks', 'acme-tasks'],
  ])('maps the valid Core name %s to the safe total host slug', (name, slug) => {
    const bundle = renderProductSkillBundle(input({ app: { ...input().app, name } }));
    expect(bundle.files.map(({ path }) => path)).toEqual([
      `.agents/skills/${slug}/SKILL.md`,
      `.agents/skills/${slug}/references/mcp-surface.md`,
      `.claude/skills/${slug}/SKILL.md`,
      `.claude/skills/${slug}/references/mcp-surface.md`,
    ]);
  });

  it('maps a Core app name above 200 characters through the bounded host-slug fallback', () => {
    const bundle = renderProductSkillBundle(
      input({ app: { ...input().app, name: 'a'.repeat(201) } }),
    );

    expect(bundle.files[0]?.path).toMatch(/^\.agents\/skills\/n-h[a-f0-9]{59}-n\/SKILL\.md$/);
  });

  it('accepts bounded TypeScript property names in derived surface facts', () => {
    expect(() =>
      renderProductSkillBundle(
        input({
          surface: {
            ...input().surface,
            tools: [
              {
                ...input().surface.tools[0],
                input: {
                  type: 'object',
                  fields: [{ name: 'expectedRevision', type: 'number', required: true }],
                },
              },
            ],
            prompts: [
              {
                kind: 'prompt',
                name: 'plan_order',
                arguments: [{ name: 'requestedDate', required: true }],
              },
            ],
          },
        }),
      ),
    ).not.toThrow();
  });

  it('keeps every fallback path distinct', () => {
    const names = ['_a', 'a_', 'a__b', '___', `n_h${'a'.repeat(59)}_n`, 'a'.repeat(65)];
    const roots = names.map(
      (name) => renderProductSkillBundle(input({ app: { ...input().app, name } })).files[0]?.path,
    );
    expect(new Set(roots).size).toBe(names.length);
  });

  it.each([
    [
      'a guide identifier over 200 characters',
      input({
        skill: {
          ...input().skill,
          workflows: [{ ...input().skill.workflows[0], id: 'a'.repeat(201) }],
        },
      }),
    ],
    [
      'prose over 4,000 characters',
      input({ skill: { ...input().skill, description: 'x'.repeat(4_001) } }),
    ],
    [
      '33 use-when entries',
      input({ skill: { ...input().skill, useWhen: Array.from({ length: 33 }, () => 'Use it.') } }),
    ],
    [
      '33 workflows',
      input({
        skill: {
          ...input().skill,
          workflows: Array.from({ length: 33 }, (_, index) => ({
            ...input().skill.workflows[0],
            id: `workflow_${index}`,
          })),
        },
      }),
    ],
    [
      '65 workflow steps',
      input({
        skill: {
          ...input().skill,
          workflows: [
            {
              ...input().skill.workflows[0],
              steps: Array.from({ length: 65 }, () => input().skill.workflows[0]?.steps[0]),
            },
          ],
        },
      }),
    ],
    [
      '65 boundaries',
      input({
        skill: { ...input().skill, boundaries: Array.from({ length: 65 }, () => 'Bound.') },
      }),
    ],
    [
      '65 examples',
      input({
        skill: {
          ...input().skill,
          examples: Array.from({ length: 65 }, () => input().skill.examples[0]),
        },
      }),
    ],
    [
      '257 tools',
      input({
        surface: {
          ...input().surface,
          tools: Array.from({ length: 257 }, (_, index) => ({
            ...input().surface.tools[0],
            name: `tool_${index}`,
          })),
        },
      }),
    ],
    [
      '65 schema fields',
      input({
        surface: {
          ...input().surface,
          tools: [
            {
              ...input().surface.tools[0],
              input: {
                type: 'object',
                fields: Array.from({ length: 65 }, (_, index) => ({
                  name: `field_${index}`,
                  type: 'string',
                  required: false,
                })),
              },
            },
          ],
        },
      }),
    ],
    [
      '65 prompt arguments',
      input({
        surface: {
          ...input().surface,
          prompts: [
            {
              kind: 'prompt',
              name: 'use_tool',
              arguments: Array.from({ length: 65 }, (_, index) => ({
                name: `argument_${index}`,
                required: false,
              })),
            },
          ],
        },
      }),
    ],
    [
      '129 authorization values',
      input({
        surface: {
          ...input().surface,
          tools: [
            {
              ...input().surface.tools[0],
              authorization: {
                requiredScopes: Array.from({ length: 129 }, (_, index) => `scope_${index}`),
              },
            },
          ],
        },
      }),
    ],
    [
      'a serialized artifact over 256 KiB',
      input({
        skill: {
          ...input().skill,
          boundaries: Array.from({ length: 64 }, () => 'x'.repeat(4_000)),
          examples: Array.from({ length: 64 }, () => ({
            prompt: 'x'.repeat(4_000),
            workflow: 'review_tasks',
          })),
        },
      }),
    ],
  ])('rejects direct input with %s before Markdown materialization', (_label, value) => {
    expectRenderError(value, 'app_package_invalid');
  });
});
