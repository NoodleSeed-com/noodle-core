import { createHash } from 'node:crypto';
import type {
  HostDistributionMetadataV1,
  HostPackageAssetInput,
  HostPackageRequest,
} from '@noodle-borg/agent-packaging';
import { describe, expect, it } from 'vitest';
import { packageOpenAiPlugin } from '../src/index.js';
import { PRODUCT_SKILL_INPUT } from './fixtures/product-skill-input.js';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);
const JPEG_1X1 = Buffer.from([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, 0x03, 0x01, 0x11, 0x00, 0x02,
  0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9,
]);
const ICON_PATH = 'assets/icon.png';
const SCREENSHOT_PATH = 'assets/task-list.png';
const REGISTERED_APP_ID = `plugin_asdk_app_${'1'.repeat(32)}`;

function logicalId(sourcePath: string): string {
  return createHash('sha256').update(sourcePath).digest('hex').slice(0, 16);
}

function reviewScenarios(): HostDistributionMetadataV1['review']['scenarios'] {
  return [
    ...Array.from({ length: 5 }, (_, index) => ({
      id: `positive_${index + 1}`,
      prompt: `Review task group ${index + 1}.`,
      expected: 'The matching tasks are returned before any write.',
      shouldInvoke: true,
      tools: ['list_tasks'],
    })),
    ...Array.from({ length: 3 }, (_, index) => ({
      id: `negative_${index + 1}`,
      prompt: `Unrelated request ${index + 1}.`,
      expected: 'Acme Tasks is not invoked.',
      shouldInvoke: false,
    })),
  ];
}

function distribution(
  overrides: Partial<HostDistributionMetadataV1> = {},
): HostDistributionMetadataV1 {
  return {
    schemaVersion: 1,
    listing: {
      summary: 'Plan and complete team work.',
      description:
        'Acme Tasks helps teams review, prioritize, capture, and complete shared work from an agent.',
      keywords: ['tasks', 'productivity'],
    },
    publisher: { name: 'Acme, Inc.', websiteUrl: 'https://acme.com' },
    support: {
      documentationUrl: 'https://docs.acme.com/tasks',
      supportUrl: 'https://support.acme.com/tasks',
    },
    legal: {
      privacyPolicyUrl: 'https://acme.com/privacy',
      termsOfServiceUrl: 'https://acme.com/terms',
    },
    assets: {
      icon: {
        source: { kind: 'asset', sourcePath: ICON_PATH, logicalId: logicalId(ICON_PATH) },
        alt: 'Acme Tasks icon',
      },
      screenshots: [
        {
          source: {
            kind: 'asset',
            sourcePath: SCREENSHOT_PATH,
            logicalId: logicalId(SCREENSHOT_PATH),
          },
          alt: 'Prioritized Acme task list',
        },
      ],
    },
    review: {
      instructions: 'Use the seeded reviewer workspace. Credentials are supplied out of band.',
      scenarios: reviewScenarios(),
    },
    ...overrides,
  };
}

function assets(): readonly HostPackageAssetInput[] {
  return [
    { logicalId: logicalId(ICON_PATH), sourcePath: ICON_PATH, content: PNG_1X1 },
    {
      logicalId: logicalId(SCREENSHOT_PATH),
      sourcePath: SCREENSHOT_PATH,
      content: PNG_1X1,
    },
  ];
}

function request(overrides: Partial<HostPackageRequest> = {}): HostPackageRequest {
  return {
    appPackage: PRODUCT_SKILL_INPUT,
    distribution: distribution(),
    mcpServer: { url: 'https://mcp.acme.com/tasks', transport: 'streamable-http' },
    assets: assets(),
    ...overrides,
  };
}

function textFile(result: ReturnType<typeof packageOpenAiPlugin>, path: string): string {
  if (!result.ok) throw new Error('expected successful OpenAI package');
  const file = result.files.find((candidate) => candidate.path === path);
  if (file === undefined) throw new Error(`missing ${path}`);
  return new TextDecoder().decode(file.content);
}

function jsonFile<T>(result: ReturnType<typeof packageOpenAiPlugin>, path: string): T {
  return JSON.parse(textFile(result, path)) as T;
}

function binaryFile(result: ReturnType<typeof packageOpenAiPlugin>, path: string): Uint8Array {
  if (!result.ok) throw new Error('expected successful OpenAI package');
  const file = result.files.find((candidate) => candidate.path === path);
  if (file === undefined) throw new Error(`missing ${path}`);
  return file.content;
}

function zipPaths(bytes: Uint8Array): readonly string[] {
  const buffer = Buffer.from(bytes);
  const paths: string[] = [];
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    paths.push(buffer.toString('utf8', offset + 30, offset + 30 + nameLength));
    offset += 30 + nameLength + extraLength + compressedSize;
  }
  return paths;
}

function issueCodes(result: ReturnType<typeof packageOpenAiPlugin>): readonly string[] {
  return result.issues.map((issue) => issue.code);
}

describe('OpenAI host package adapter', () => {
  it('renders a deterministic submission kit with two portal-ready upload artifacts', () => {
    const original = request();
    const before = JSON.stringify(original);
    const first = packageOpenAiPlugin(original, {
      state: 'submission',
      category: 'Productivity',
    });
    const second = packageOpenAiPlugin(request({ assets: [...assets()].reverse() }), {
      state: 'submission',
      category: 'Productivity',
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(JSON.stringify(original)).toBe(before);
    if (!first.ok || !second.ok) return;
    expect(first.target).toBe('openai');
    expect(first.archive.bytes).toEqual(second.archive.bytes);
    expect(first.archive.sha256).toBe(second.archive.sha256);
    expect(first.files.map((file) => file.path)).toEqual([
      '.codex-plugin/plugin.json',
      '.mcp.json',
      'assets/icon.png',
      'assets/screenshot-01.png',
      'skills/acme-tasks/SKILL.md',
      'skills/acme-tasks/references/mcp-surface.md',
      'submission/README.md',
      'submission/acme-tasks-skill.zip',
      'submission/chatgpt-app-submission.json',
    ]);

    const manifest = jsonFile<{
      name: string;
      version: string;
      author: { name: string; url: string };
      homepage: string;
      skills: string;
      mcpServers: string;
      apps?: string;
      interface: {
        displayName: string;
        category: string;
        capabilities: readonly string[];
        defaultPrompt: readonly string[];
        composerIcon: string;
        logo: string;
        screenshots: readonly string[];
      };
    }>(first, '.codex-plugin/plugin.json');
    expect(manifest).toMatchObject({
      name: 'acme-tasks',
      version: '1.0.0',
      author: { name: 'Acme, Inc.', url: 'https://acme.com' },
      homepage: 'https://docs.acme.com/tasks',
      skills: './skills/',
      mcpServers: './.mcp.json',
      interface: {
        displayName: 'Acme Tasks',
        category: 'Productivity',
        capabilities: ['Interactive', 'Read', 'Write'],
        defaultPrompt: ['Review my open task.'],
        composerIcon: './assets/icon.png',
        logo: './assets/icon.png',
        screenshots: ['./assets/screenshot-01.png'],
      },
    });
    expect(manifest).not.toHaveProperty('apps');

    expect(jsonFile(first, '.mcp.json')).toEqual({
      'acme-tasks': {
        url: 'https://mcp.acme.com/tasks',
      },
    });

    const submission = jsonFile<{
      $schema: string;
      schema_version: number;
      app_info: {
        display_name: string;
        subtitle: string;
        description: string;
        category: string;
      };
      tools: Readonly<
        Record<
          string,
          {
            annotations: {
              readOnlyHint: boolean;
              openWorldHint: boolean;
              destructiveHint: boolean;
            };
            justifications: Record<string, string>;
          }
        >
      >;
      test_cases: readonly { tools_triggered: string }[];
      negative_test_cases: readonly { tools_triggered: null }[];
    }>(first, 'submission/chatgpt-app-submission.json');
    expect(submission.$schema).toBe(
      'https://developers.openai.com/apps-sdk/schemas/chatgpt-app-submission.v1.json',
    );
    expect(submission.schema_version).toBe(1);
    expect(submission.app_info).toEqual({
      display_name: 'Acme Tasks',
      subtitle: 'Plan and complete team work.',
      description:
        'Acme Tasks helps teams review, prioritize, capture, and complete shared work from an agent.',
      category: 'PRODUCTIVITY',
    });
    expect(Object.keys(submission.tools)).toEqual([
      'complete_task',
      'list_tasks',
      'refresh_widget',
    ]);
    expect(submission.tools.list_tasks?.annotations).toEqual({
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    });
    for (const tool of Object.values(submission.tools)) {
      expect(Object.values(tool.justifications).every((value) => value.trim().length > 0)).toBe(
        true,
      );
    }
    expect(submission.test_cases).toHaveLength(5);
    expect(
      submission.test_cases.every((testCase) => testCase.tools_triggered === 'list_tasks'),
    ).toBe(true);
    expect(submission.negative_test_cases).toHaveLength(3);
    expect(
      submission.negative_test_cases.every((testCase) => testCase.tools_triggered === null),
    ).toBe(true);
    expect(zipPaths(binaryFile(first, 'submission/acme-tasks-skill.zip'))).toEqual([
      'acme-tasks/SKILL.md',
      'acme-tasks/references/mcp-surface.md',
    ]);
    expect(textFile(first, 'submission/README.md')).toContain('Do not upload the outer export ZIP');
    expect(textFile(first, 'submission/README.md')).toContain('`acme-tasks/SKILL.md`');
    expect(textFile(first, 'submission/chatgpt-app-submission.json')).not.toContain(
      REGISTERED_APP_ID,
    );
  });

  it('renders a separate repo-marketplace package with the exact registered app ID', () => {
    const result = packageOpenAiPlugin(
      request({
        mcpServer: { url: 'http://127.0.0.1:8787/mcp', transport: 'streamable-http' },
        distribution: distribution({
          legal: { privacyPolicyUrl: 'https://acme.com/privacy' },
          review: {
            instructions: 'Use local fixture data.',
            scenarios: reviewScenarios().slice(0, 2),
          },
        }),
      }),
      { state: 'local', category: 'Productivity', registeredAppId: REGISTERED_APP_ID },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files.map((file) => file.path)).toEqual([
      '.agents/plugins/marketplace.json',
      'plugins/acme-tasks/.app.json',
      'plugins/acme-tasks/.codex-plugin/plugin.json',
      'plugins/acme-tasks/.mcp.json',
      'plugins/acme-tasks/assets/icon.png',
      'plugins/acme-tasks/assets/screenshot-01.png',
      'plugins/acme-tasks/skills/acme-tasks/SKILL.md',
      'plugins/acme-tasks/skills/acme-tasks/references/mcp-surface.md',
    ]);
    expect(jsonFile(result, '.agents/plugins/marketplace.json')).toEqual({
      name: 'noodle-openai-local',
      interface: { displayName: 'Noodle Seed OpenAI Local' },
      plugins: [
        {
          name: 'acme-tasks',
          source: { source: 'local', path: './plugins/acme-tasks' },
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
          category: 'Productivity',
        },
      ],
    });
    expect(jsonFile(result, 'plugins/acme-tasks/.app.json')).toEqual({
      apps: { 'acme-tasks': { id: REGISTERED_APP_ID, category: 'Productivity' } },
    });
    expect(
      jsonFile<{ apps?: string }>(result, 'plugins/acme-tasks/.codex-plugin/plugin.json'),
    ).toHaveProperty('apps', './.app.json');
  });

  it('fails closed on incomplete submission evidence and unsafe target options', () => {
    const incomplete = packageOpenAiPlugin(
      request({
        mcpServer: { url: 'http://127.0.0.1:8787/mcp', transport: 'streamable-http' },
        distribution: distribution({
          legal: { privacyPolicyUrl: 'https://acme.com/privacy' },
          review: { instructions: 'Review safely.', scenarios: reviewScenarios().slice(0, 2) },
        }),
      }),
      { state: 'submission', category: 'Productivity' },
    );
    expect(incomplete.ok).toBe(false);
    expect(issueCodes(incomplete)).toEqual(
      expect.arrayContaining([
        'openai_submission_https_required',
        'openai_submission_public_endpoint_required',
        'openai_submission_terms_required',
        'openai_submission_positive_tests_missing',
        'openai_submission_negative_tests_missing',
      ]),
    );

    const local = packageOpenAiPlugin(request(), {
      state: 'local',
      category: 'Productivity',
      registeredAppId: 'not-an-openai-app-id',
    });
    expect(local.ok).toBe(false);
    expect(issueCodes(local)).toContain('openai_local_registered_app_invalid');

    const category = packageOpenAiPlugin(request(), {
      state: 'submission',
      category: 'bad\ncategory',
    });
    expect(category.ok).toBe(false);
    expect(issueCodes(category)).toContain('openai_category_invalid');

    const privateUrl = packageOpenAiPlugin(
      request({ mcpServer: { url: 'https://127.0.0.1/mcp', transport: 'streamable-http' } }),
      { state: 'submission', category: 'Productivity' },
    );
    expect(privateUrl.ok).toBe(false);
    expect(issueCodes(privateUrl)).toContain('openai_submission_public_endpoint_required');

    const privateListing = packageOpenAiPlugin(
      request({
        distribution: distribution({
          publisher: { name: 'Acme, Inc.', websiteUrl: 'https://localhost' },
        }),
      }),
      { state: 'submission', category: 'Productivity' },
    );
    expect(privateListing.ok).toBe(false);
    expect(issueCodes(privateListing)).toContain('openai_submission_public_url_required');
  });

  it('rejects OpenAI-incompatible identity and starter-prompt shapes', () => {
    const longerDisplayName = packageOpenAiPlugin(
      request({
        appPackage: {
          ...PRODUCT_SKILL_INPUT,
          app: {
            ...PRODUCT_SKILL_INPUT.app,
            title: 'A useful display name over thirty characters',
          },
        },
      }),
      { state: 'submission', category: 'Productivity' },
    );
    expect(longerDisplayName.ok).toBe(true);

    const version = packageOpenAiPlugin(
      request({
        appPackage: { ...PRODUCT_SKILL_INPUT, app: { ...PRODUCT_SKILL_INPUT.app, version: 'v1' } },
      }),
      { state: 'submission', category: 'Productivity' },
    );
    expect(version.ok).toBe(false);
    expect(issueCodes(version)).toContain('openai_plugin_version_invalid');

    const prompt = packageOpenAiPlugin(
      request({
        appPackage: {
          ...PRODUCT_SKILL_INPUT,
          skill: {
            ...PRODUCT_SKILL_INPUT.skill,
            examples: [{ prompt: 'x'.repeat(129), workflow: 'review_then_complete' }],
          },
        },
      }),
      { state: 'submission', category: 'Productivity' },
    );
    expect(prompt.ok).toBe(false);
    expect(issueCodes(prompt)).toContain('openai_starter_prompt_invalid');

    const jpegPath = 'assets/task-list.jpg';
    const jpegScreenshot = packageOpenAiPlugin(
      request({
        distribution: distribution({
          assets: {
            icon: distribution().assets.icon,
            screenshots: [
              {
                source: {
                  kind: 'asset',
                  sourcePath: jpegPath,
                  logicalId: logicalId(jpegPath),
                },
                alt: 'Prioritized Acme task list',
              },
            ],
          },
        }),
        assets: [
          { logicalId: logicalId(ICON_PATH), sourcePath: ICON_PATH, content: PNG_1X1 },
          { logicalId: logicalId(jpegPath), sourcePath: jpegPath, content: JPEG_1X1 },
        ],
      }),
      { state: 'submission', category: 'Productivity' },
    );
    expect(jpegScreenshot.ok).toBe(false);
    expect(issueCodes(jpegScreenshot)).toContain('openai_screenshot_format_invalid');
  });

  it('rejects missing, unknown, or negative-case tool mappings before rendering uploads', () => {
    const scenarios = reviewScenarios();
    const missing = packageOpenAiPlugin(
      request({
        distribution: distribution({
          review: {
            instructions: 'Review safely.',
            scenarios: scenarios.map((scenario, index) =>
              index === 0 ? { ...scenario, tools: undefined } : scenario,
            ),
          },
        }),
      }),
      { state: 'submission', category: 'Productivity' },
    );
    expect(issueCodes(missing)).toContain('openai_submission_test_tools_missing');

    const unknown = packageOpenAiPlugin(
      request({
        distribution: distribution({
          review: {
            instructions: 'Review safely.',
            scenarios: scenarios.map((scenario, index) =>
              index === 0 ? { ...scenario, tools: ['invented_tool'] } : scenario,
            ),
          },
        }),
      }),
      { state: 'submission', category: 'Productivity' },
    );
    expect(issueCodes(unknown)).toContain('openai_submission_test_tool_unknown');

    const negative = packageOpenAiPlugin(
      request({
        distribution: distribution({
          review: {
            instructions: 'Review safely.',
            scenarios: scenarios.map((scenario, index) =>
              index === 5 ? { ...scenario, tools: ['list_tasks'] } : scenario,
            ),
          },
        }),
      }),
      { state: 'submission', category: 'Productivity' },
    );
    expect(issueCodes(negative)).toContain('host_package_invalid_metadata');
  });
});
