import { createHash } from 'node:crypto';
import type {
  HostDistributionMetadataV1,
  HostPackageAssetInput,
  HostPackageRequest,
} from '@noodle-borg/agent-packaging';
import { describe, expect, it } from 'vitest';
import { packageClaudePlugin, renderProductSkillMarkdown } from '../src/index.js';
import { PRODUCT_SKILL_INPUT } from './fixtures/product-skill-input.js';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);
const ICON_PATH = 'assets/icon.png';

function logicalId(sourcePath: string): string {
  return createHash('sha256').update(sourcePath).digest('hex').slice(0, 16);
}

function distribution(): HostDistributionMetadataV1 {
  return {
    schemaVersion: 1,
    listing: {
      summary: 'Plan and complete team work with Acme Tasks.',
      description: 'Acme Tasks helps teams review and complete shared work from Claude.',
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
    },
    review: {
      instructions: 'Use the seeded reviewer workspace. Credentials are supplied out of band.',
      scenarios: [
        {
          id: 'review_tasks',
          prompt: 'Review my tasks.',
          expected: 'The matching tasks are returned.',
          shouldInvoke: true,
        },
      ],
    },
  };
}

function request(overrides: Partial<HostPackageRequest> = {}): HostPackageRequest {
  return {
    appPackage: PRODUCT_SKILL_INPUT,
    distribution: distribution(),
    mcpServer: { url: 'https://mcp.acme.com/tasks', transport: 'streamable-http' },
    assets: [
      { logicalId: logicalId(ICON_PATH), sourcePath: ICON_PATH, content: PNG_1X1 },
    ] satisfies readonly HostPackageAssetInput[],
    ...overrides,
  };
}

function textFile(result: ReturnType<typeof packageClaudePlugin>, path: string): string {
  if (!result.ok) throw new Error('expected successful Claude plugin package');
  const file = result.files.find((candidate) => candidate.path === path);
  if (file === undefined) throw new Error(`missing ${path}`);
  return new TextDecoder().decode(file.content);
}

function jsonFile<T>(result: ReturnType<typeof packageClaudePlugin>, path: string): T {
  return JSON.parse(textFile(result, path)) as T;
}

describe('Claude Code plugin adapter', () => {
  it('renders a deterministic installable repository without connector-submission files', () => {
    const first = packageClaudePlugin(request());
    const second = packageClaudePlugin(request());

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.target).toBe('claude');
    expect(first.archive.bytes).toEqual(second.archive.bytes);
    expect(first.files.map((file) => file.path)).toEqual([
      '.claude-plugin/plugin.json',
      '.mcp.json',
      'README.md',
      'assets/icon.png',
      'skills/acme-tasks/SKILL.md',
      'skills/acme-tasks/references/mcp-surface.md',
    ]);
    expect(first.files.some((file) => file.path.startsWith('submission/'))).toBe(false);

    expect(
      jsonFile<{
        $schema: string;
        name: string;
        displayName: string;
        version: string;
        defaultEnabled: boolean;
        skills: string;
        mcpServers: string;
      }>(first, '.claude-plugin/plugin.json'),
    ).toEqual(
      expect.objectContaining({
        $schema: 'https://json.schemastore.org/claude-code-plugin-manifest.json',
        name: 'acme-tasks',
        displayName: 'Acme Tasks',
        version: '1.0.0',
        defaultEnabled: false,
        skills: './skills/',
        mcpServers: './.mcp.json',
      }),
    );
    expect(jsonFile(first, '.mcp.json')).toEqual({
      mcpServers: {
        'acme-tasks': {
          type: 'http',
          url: 'https://mcp.acme.com/tasks',
        },
      },
    });
    expect(textFile(first, 'README.md')).toContain('claude plugin validate . --strict');
    expect(textFile(first, 'README.md')).toContain('claude --plugin-dir .');
    const canonicalSkill = renderProductSkillMarkdown(PRODUCT_SKILL_INPUT);
    expect(textFile(first, 'skills/acme-tasks/SKILL.md')).toBe(canonicalSkill.skill);
    expect(textFile(first, 'skills/acme-tasks/references/mcp-surface.md')).toBe(
      canonicalSkill.reference,
    );
  });

  it('rejects a non-public MCP URL and invalid plugin version', () => {
    const local = packageClaudePlugin(
      request({ mcpServer: { url: 'http://127.0.0.1:8787/mcp', transport: 'streamable-http' } }),
    );
    expect(local.ok).toBe(false);
    expect(local.issues.map((issue) => issue.code)).toContain('claude_plugin_public_url_required');

    const invalidVersion = packageClaudePlugin(
      request({
        appPackage: {
          ...PRODUCT_SKILL_INPUT,
          app: { ...PRODUCT_SKILL_INPUT.app, version: 'v1' },
        },
      }),
    );
    expect(invalidVersion.ok).toBe(false);
    expect(invalidVersion.issues.map((issue) => issue.code)).toContain(
      'claude_plugin_version_invalid',
    );
  });

  it.each([
    'acme__tasks',
    'a'.repeat(65),
  ])('projects the valid Core name %s into a bounded Claude plugin and skill name', (name) => {
    const result = packageClaudePlugin(
      request({
        appPackage: {
          ...PRODUCT_SKILL_INPUT,
          app: { ...PRODUCT_SKILL_INPUT.app, name },
        },
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const manifest = jsonFile<{ name: string }>(result, '.claude-plugin/plugin.json');
    expect(manifest.name).toMatch(/^n-h[a-f0-9]{59}-n$/);
    expect(manifest.name).toHaveLength(64);
    expect(result.files.map((file) => file.path)).toContain(`skills/${manifest.name}/SKILL.md`);
    expect(textFile(result, `skills/${manifest.name}/SKILL.md`)).toContain(
      `name: ${manifest.name}`,
    );
  });
});
