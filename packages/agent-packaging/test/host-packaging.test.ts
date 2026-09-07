import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  HOST_PACKAGING_LIMITS,
  type HostDistributionMetadataV1,
  type HostPackageAdapter,
  type HostPackageAdapterInput,
  type HostPackageFile,
  type ProductSkillPackageInput,
  packageHostTarget,
} from '../src/index.js';

const PRODUCT_SKILL_INPUT = {
  schemaVersion: '1',
  app: { name: 'acme_tasks', title: 'Acme Tasks', version: '1.0.0' },
  skill: {
    description: 'Use Acme Tasks to review work.',
    useWhen: ['The user asks to review work.'],
    workflows: [
      {
        id: 'review_tasks',
        title: 'Review tasks',
        steps: [{ capability: { kind: 'tool', name: 'list_tasks' } }],
      },
    ],
    boundaries: ['Do not invent task IDs.'],
    examples: [{ prompt: 'Review my tasks.', workflow: 'review_tasks' }],
  },
  surface: {
    auth: { required: false },
    tools: [
      {
        kind: 'tool',
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
        visibility: ['model'],
      },
    ],
    resources: [],
    prompts: [],
    widgets: [],
  },
  provenance: {
    sourceManifestSha256: 'a'.repeat(64),
    mcpSurfaceSha256: 'b'.repeat(64),
    compilerVersion: '1',
  },
} as const satisfies ProductSkillPackageInput;

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);
const JPEG_1X1 = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVL//2Q==',
  'base64',
);

function logicalId(sourcePath: string): string {
  return createHash('sha256')
    .update(sourcePath.replace(/\\/g, '/').replace(/^\.\/+/, ''))
    .digest('hex')
    .slice(0, 16);
}

const ICON_PATH = 'assets/icon.png';
const SCREENSHOT_PATH = 'assets/task-list.png';

function metadata(overrides: Partial<HostDistributionMetadataV1> = {}): HostDistributionMetadataV1 {
  return {
    schemaVersion: 1,
    listing: {
      summary: 'Plan and complete team work with Acme Tasks.',
      description:
        'Acme Tasks helps teams review, prioritize, capture, and complete shared work from an agent.',
      keywords: ['tasks', 'productivity'],
    },
    publisher: { name: 'Acme, Inc.', websiteUrl: 'https://acme.example' },
    support: {
      documentationUrl: 'https://docs.acme.example/tasks',
      supportUrl: 'https://support.acme.example/tasks',
    },
    legal: {
      privacyPolicyUrl: 'https://acme.example/privacy',
      termsOfServiceUrl: 'https://acme.example/terms',
    },
    assets: {
      icon: {
        source: { kind: 'asset', sourcePath: `./${ICON_PATH}`, logicalId: logicalId(ICON_PATH) },
        alt: 'Acme Tasks icon',
      },
      screenshots: [
        {
          source: {
            kind: 'asset',
            sourcePath: `./${SCREENSHOT_PATH}`,
            logicalId: logicalId(SCREENSHOT_PATH),
          },
          alt: 'Prioritized Acme task list',
          prompt: 'Show my prioritized Acme task list.',
        },
      ],
    },
    review: {
      instructions: 'Use the seeded reviewer workspace. Credentials are supplied out of band.',
      scenarios: [
        {
          id: 'review_tasks',
          prompt: 'Show my tasks for today.',
          expected: 'The current task list is returned without changing it.',
          shouldInvoke: true,
          tools: ['list_tasks'],
        },
        {
          id: 'unrelated_weather',
          prompt: 'Will it rain tomorrow?',
          expected: 'Acme Tasks is not invoked.',
          shouldInvoke: false,
        },
      ],
    },
    ...overrides,
  };
}

function resolvedAssets() {
  return [
    {
      logicalId: logicalId(ICON_PATH),
      sourcePath: ICON_PATH,
      content: new Uint8Array(PNG_1X1),
    },
    {
      logicalId: logicalId(SCREENSHOT_PATH),
      sourcePath: SCREENSHOT_PATH,
      content: new Uint8Array(PNG_1X1),
    },
  ];
}

describe('host distribution screenshot evidence', () => {
  it('preserves an optional authored prompt on the resolved screenshot', () => {
    let resolvedPrompt: string | undefined;
    const adapter: HostPackageAdapter = {
      target: 'prompt-fixture',
      version: '1.0.0',
      validate: (input) => {
        resolvedPrompt = input.assets.screenshots[0]?.prompt;
        return [];
      },
      render: files,
    };

    const result = packageHostTarget(
      {
        appPackage: PRODUCT_SKILL_INPUT,
        distribution: metadata(),
        mcpServer: { url: 'https://mcp.acme.example/tasks', transport: 'streamable-http' },
        assets: resolvedAssets(),
      },
      adapter,
    );

    expect(result.ok).toBe(true);
    expect(resolvedPrompt).toBe('Show my prioritized Acme task list.');
  });
});

function files(input: HostPackageAdapterInput): readonly HostPackageFile[] {
  return [
    {
      role: 'manifest',
      path: 'plugin.json',
      content: `${JSON.stringify({ name: input.appPackage.app.name })}\n`,
    },
    {
      role: 'mcp',
      path: 'mcp.json',
      content: `${JSON.stringify({ url: input.mcpServer.url })}\n`,
    },
    {
      role: 'skill',
      path: 'skills/acme-tasks/SKILL.md',
      content: `# Acme Tasks\n\n${input.appPackage.skill.description}\n`,
    },
    {
      role: 'branding',
      path: 'assets/icon.png',
      content: input.assets.icon.content,
    },
    {
      role: 'legal',
      path: 'LEGAL.md',
      content: `Privacy: ${input.distribution.legal.privacyPolicyUrl}\n`,
    },
    {
      role: 'documentation',
      path: 'README.md',
      content: `${input.distribution.listing.description}\n`,
    },
    {
      role: 'test',
      path: 'review/scenarios.json',
      content: `${JSON.stringify(input.distribution.review.scenarios)}\n`,
    },
  ];
}

function adapter(overrides: Partial<HostPackageAdapter> = {}): HostPackageAdapter {
  return {
    target: 'fixture-host',
    version: '1.0.0',
    validate: () => [],
    render: files,
    ...overrides,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    appPackage: PRODUCT_SKILL_INPUT,
    distribution: metadata(),
    mcpServer: { url: 'https://acme.example/mcp', transport: 'streamable-http' as const },
    assets: resolvedAssets(),
    ...overrides,
  };
}

function issueCodes(result: ReturnType<typeof packageHostTarget>): readonly string[] {
  return result.issues.map((issue) => issue.code);
}

describe('host packaging framework', () => {
  it('renders every framework file role into a deterministic ZIP with stable provenance', () => {
    const first = packageHostTarget(request(), adapter());
    const second = packageHostTarget(
      request({ assets: [...resolvedAssets()].reverse() }),
      adapter({ render: (input) => [...files(input)].reverse() }),
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.target).toBe('fixture-host');
    expect(first.adapterVersion).toBe('1.0.0');
    expect(first.files.map((file) => file.path)).toEqual(
      [...first.files.map((file) => file.path)].sort(),
    );
    expect(new Set(first.files.map((file) => file.role))).toEqual(
      new Set(['manifest', 'mcp', 'skill', 'branding', 'legal', 'documentation', 'test']),
    );
    expect(first.treeSha256).toBe(second.treeSha256);
    expect(first.archive.sha256).toBe(second.archive.sha256);
    expect(first.archive.bytes).toEqual(second.archive.bytes);
    expect(first.archive.format).toBe('zip');
    expect(Buffer.from(first.archive.bytes).readUInt32LE(0)).toBe(0x04034b50);
    expect(zipEntries(first.archive.bytes).map((entry) => entry.path)).toEqual(
      first.files.map((file) => file.path),
    );
    expect(zipEntries(first.archive.bytes).every((entry) => entry.modifiedTime === 0)).toBe(true);
  });

  it('changes both tree and archive identity when one generated byte changes', () => {
    const original = packageHostTarget(request(), adapter());
    const changed = packageHostTarget(
      request(),
      adapter({
        render: (input) =>
          files(input).map((file) =>
            file.path === 'README.md' ? { ...file, content: `${file.content}Changed.\n` } : file,
          ),
      }),
    );

    expect(original.ok && changed.ok).toBe(true);
    if (!original.ok || !changed.ok) return;
    expect(changed.treeSha256).not.toBe(original.treeSha256);
    expect(changed.archive.sha256).not.toBe(original.archive.sha256);
  });

  it('returns target issues without rendering and preserves non-blocking warnings', () => {
    const render = vi.fn(files);
    const blocked = packageHostTarget(
      request(),
      adapter({
        validate: () => [
          {
            severity: 'error',
            code: 'fixture_review_evidence_missing',
            path: 'review.scenarios',
            message: 'Fixture Host requires review evidence.',
          },
        ],
        render,
      }),
    );
    expect(blocked.ok).toBe(false);
    expect(render).not.toHaveBeenCalled();
    expect(blocked.issues).toContainEqual(
      expect.objectContaining({
        origin: 'target',
        target: 'fixture-host',
        code: 'fixture_review_evidence_missing',
      }),
    );

    const warned = packageHostTarget(
      request(),
      adapter({
        validate: () => [
          {
            severity: 'warning',
            code: 'fixture_description_short',
            path: 'listing.description',
            message: 'A longer description may improve discovery.',
          },
        ],
      }),
    );
    expect(warned.ok).toBe(true);
    expect(warned.issues).toContainEqual(
      expect.objectContaining({ severity: 'warning', origin: 'target' }),
    );
  });

  it.each([
    [
      'code',
      {
        code: `github_pat_${'q'.repeat(32)}`,
        path: 'review.instructions',
        message: 'The reviewer setup is invalid.',
      },
    ],
    [
      'path',
      {
        code: 'fixture_reviewer_setup_invalid',
        path: `review.Bearer ${'q'.repeat(32)}`,
        message: 'The reviewer setup is invalid.',
      },
    ],
    [
      'message',
      {
        code: 'fixture_reviewer_setup_invalid',
        path: 'review.instructions',
        message: `Reviewer token: Bearer ${'q'.repeat(32)}`,
      },
    ],
  ])('rejects credential-shaped adapter issue %s without echoing it', (_field, issue) => {
    const render = vi.fn(files);
    const result = packageHostTarget(
      request(),
      adapter({
        validate: () => [{ severity: 'warning', ...issue }],
        render,
      }),
    );

    expect(result.ok).toBe(false);
    expect(issueCodes(result)).toContain('host_package_adapter_issue_invalid');
    expect(JSON.stringify(result.issues)).not.toContain('q'.repeat(32));
    expect(render).not.toHaveBeenCalled();
  });

  it.each([
    ['relative traversal', '../escape.json'],
    ['absolute path', '/escape.json'],
    ['Windows drive path', 'C:/escape.json'],
    ['Windows separator', 'folder\\escape.json'],
    ['empty segment', 'folder//escape.json'],
  ])('rejects an unsafe generated path: %s', (_label, path) => {
    const result = packageHostTarget(
      request(),
      adapter({ render: () => [{ role: 'manifest', path, content: '{}\n' }] }),
    );
    expect(result.ok).toBe(false);
    expect(issueCodes(result)).toContain('host_package_unsafe_path');
  });

  it('rejects duplicate paths, oversized output, and credential-shaped generated text', () => {
    const duplicate = packageHostTarget(
      request(),
      adapter({
        render: () => [
          { role: 'manifest', path: 'plugin.json', content: '{}\n' },
          { role: 'documentation', path: 'plugin.json', content: '# Duplicate\n' },
        ],
      }),
    );
    expect(issueCodes(duplicate)).toContain('host_package_duplicate_path');

    const oversized = packageHostTarget(
      request(),
      adapter({
        render: () => [
          {
            role: 'documentation',
            path: 'README.md',
            content: 'x'.repeat(HOST_PACKAGING_LIMITS.fileBytes + 1),
          },
        ],
      }),
    );
    expect(issueCodes(oversized)).toContain('host_package_file_too_large');

    const sensitive = packageHostTarget(
      request(),
      adapter({
        render: () => [
          {
            role: 'test',
            path: 'review.md',
            content: `Bearer ${'a'.repeat(32)}\n`,
          },
        ],
      }),
    );
    expect(issueCodes(sensitive)).toContain('host_package_sensitive_content');
    expect(sensitive.issues.map((issue) => issue.message).join(' ')).not.toContain('a'.repeat(32));
  });

  it('validates bounded metadata, canonical MCP URLs, and secret-free review material', () => {
    const invalidUrl = packageHostTarget(
      request({
        mcpServer: { url: 'https://user:secret@acme.example/mcp', transport: 'streamable-http' },
      }),
      adapter(),
    );
    expect(issueCodes(invalidUrl)).toContain('host_package_invalid_mcp_url');

    const invalidMetadata = packageHostTarget(
      request({
        distribution: metadata({
          listing: {
            ...metadata().listing,
            summary: 'x'.repeat(HOST_PACKAGING_LIMITS.summaryChars + 1),
          },
        }),
      }),
      adapter(),
    );
    expect(issueCodes(invalidMetadata)).toContain('host_package_invalid_metadata');

    const sensitive = packageHostTarget(
      request({
        distribution: metadata({
          review: {
            ...metadata().review,
            instructions: `Use Bearer ${'b'.repeat(32)} for review.`,
          },
        }),
      }),
      adapter(),
    );
    expect(issueCodes(sensitive)).toContain('host_package_sensitive_content');

    const unknownMetadata = packageHostTarget(
      request({ distribution: { ...metadata(), debug: 'not part of Distribution V1' } }),
      adapter(),
    );
    expect(issueCodes(unknownMetadata)).toContain('host_package_invalid_metadata');

    const iconPrompt = packageHostTarget(
      request({
        distribution: {
          ...metadata(),
          assets: {
            ...metadata().assets,
            icon: { ...metadata().assets.icon, prompt: 'This field belongs on screenshots only.' },
          },
        },
      }),
      adapter(),
    );
    expect(issueCodes(iconPrompt)).toContain('host_package_invalid_metadata');

    const duplicateScenarioTool = packageHostTarget(
      request({
        distribution: metadata({
          review: {
            ...metadata().review,
            scenarios: metadata().review.scenarios.map((scenario, index) =>
              index === 0 ? { ...scenario, tools: ['list_tasks', 'list_tasks'] } : scenario,
            ),
          },
        }),
      }),
      adapter(),
    );
    expect(issueCodes(duplicateScenarioTool)).toContain('host_package_invalid_metadata');

    const negativeScenarioWithTools = packageHostTarget(
      request({
        distribution: metadata({
          review: {
            ...metadata().review,
            scenarios: metadata().review.scenarios.map((scenario, index) =>
              index === 1
                ? ({ ...scenario, tools: ['list_tasks'] } as unknown as typeof scenario)
                : scenario,
            ),
          },
        }),
      }),
      adapter(),
    );
    expect(issueCodes(negativeScenarioWithTools)).toContain('host_package_invalid_metadata');
  });

  it('rejects missing, extra, mismatched, and non-image distribution assets', () => {
    const missing = packageHostTarget(request({ assets: resolvedAssets().slice(0, 1) }), adapter());
    expect(issueCodes(missing)).toContain('host_package_asset_missing');

    const extra = packageHostTarget(
      request({
        assets: [
          ...resolvedAssets(),
          { logicalId: 'c'.repeat(16), sourcePath: 'assets/extra.png', content: PNG_1X1 },
        ],
      }),
      adapter(),
    );
    expect(issueCodes(extra)).toContain('host_package_asset_unreferenced');

    const mismatched = packageHostTarget(
      request({
        assets: resolvedAssets().map((candidate, index) =>
          index === 0 ? { ...candidate, logicalId: 'd'.repeat(16) } : candidate,
        ),
      }),
      adapter(),
    );
    expect(issueCodes(mismatched)).toEqual(
      expect.arrayContaining(['host_package_asset_missing', 'host_package_asset_unreferenced']),
    );

    const notImage = packageHostTarget(
      request({
        assets: resolvedAssets().map((candidate, index) =>
          index === 0
            ? { ...candidate, content: new TextEncoder().encode('not an image') }
            : candidate,
        ),
      }),
      adapter(),
    );
    expect(issueCodes(notImage)).toContain('host_package_asset_invalid');
  });

  it('resolves bounded JPEG branding before a target adapter renders it', () => {
    const jpegPath = 'assets/icon.jpg';
    const baseline = metadata();
    const result = packageHostTarget(
      request({
        distribution: metadata({
          assets: {
            ...baseline.assets,
            icon: {
              source: { kind: 'asset', sourcePath: jpegPath, logicalId: logicalId(jpegPath) },
              alt: 'Acme Tasks icon',
            },
          },
        }),
        assets: [
          {
            logicalId: logicalId(jpegPath),
            sourcePath: jpegPath,
            content: new Uint8Array(JPEG_1X1),
          },
          resolvedAssets()[1],
        ],
      }),
      adapter({
        validate: (input) =>
          input.assets.icon.mimeType === 'image/jpeg' &&
          input.assets.icon.width === 1 &&
          input.assets.icon.height === 1
            ? []
            : [
                {
                  severity: 'error',
                  code: 'fixture_invalid_jpeg',
                  path: 'assets.icon',
                  message: 'The fixture JPEG was not resolved correctly.',
                },
              ],
      }),
    );

    expect(result.ok).toBe(true);
  });

  it('normalizes cross-platform source asset separators before exact reference matching', () => {
    const baseline = metadata();
    const result = packageHostTarget(
      request({
        distribution: metadata({
          assets: {
            ...baseline.assets,
            icon: {
              source: {
                kind: 'asset',
                sourcePath: 'assets\\icon.png',
                logicalId: logicalId('assets\\icon.png'),
              },
              alt: 'Acme Tasks icon',
            },
          },
        }),
      }),
      adapter({
        validate: (input) =>
          input.assets.icon.sourcePath === ICON_PATH
            ? []
            : [
                {
                  severity: 'error',
                  code: 'fixture_asset_path_not_normalized',
                  path: 'assets.icon',
                  message: 'The source asset path was not normalized.',
                },
              ],
      }),
    );

    expect(result.ok).toBe(true);
  });

  it('sanitizes adapter exceptions and malformed target issue codes', () => {
    const thrown = packageHostTarget(
      request(),
      adapter({
        render: () => {
          throw new Error(`Bearer ${'z'.repeat(32)}`);
        },
      }),
    );
    expect(issueCodes(thrown)).toContain('host_package_adapter_failed');
    expect(thrown.issues.map((issue) => issue.message).join(' ')).not.toContain('z'.repeat(32));

    const malformed = packageHostTarget(
      request(),
      adapter({
        validate: () => [
          { severity: 'error', code: '../bad', path: '', message: 'Malformed target issue.' },
        ],
      }),
    );
    expect(issueCodes(malformed)).toContain('host_package_adapter_issue_invalid');
  });
});

function zipEntries(bytes: Uint8Array): Array<{ path: string; modifiedTime: number }> {
  const buffer = Buffer.from(bytes);
  const entries: Array<{ path: string; modifiedTime: number }> = [];
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const modifiedTime = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const path = buffer.toString('utf8', offset + 30, offset + 30 + nameLength);
    entries.push({ path, modifiedTime });
    offset += 30 + nameLength + extraLength + compressedSize;
  }
  return entries;
}
