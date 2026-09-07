import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type {
  HostDistributionMetadataV1,
  HostPackageAssetInput,
  HostPackageRequest,
  ProductSkillPackageInput,
} from '@noodle-borg/agent-packaging';
import { describe, expect, it } from 'vitest';
import { packageAnthropicConnector } from '../src/index.js';
import { PRODUCT_SKILL_INPUT } from './fixtures/product-skill-input.js';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);
const JPEG_1X1 = Buffer.from([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, 0x03, 0x01, 0x11, 0x00, 0x02,
  0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9,
]);
const SCREENSHOT = readFileSync(new URL('./fixtures/anthropic-screenshot.png', import.meta.url));
const ICON_PATH = 'assets/icon.png';
const SCREENSHOT_PATHS = ['assets/menu.png', 'assets/cart.png', 'assets/checkout.png'] as const;

function logicalId(sourcePath: string): string {
  return createHash('sha256').update(sourcePath).digest('hex').slice(0, 16);
}

function appPackage(overrides: Partial<ProductSkillPackageInput> = {}): ProductSkillPackageInput {
  return {
    ...PRODUCT_SKILL_INPUT,
    surface: {
      ...PRODUCT_SKILL_INPUT.surface,
      tools: PRODUCT_SKILL_INPUT.surface.tools.map((tool) => ({
        ...tool,
        title: tool.title ?? tool.name.replaceAll('_', ' '),
      })),
    },
    ...overrides,
  };
}

function distribution(
  overrides: Partial<HostDistributionMetadataV1> = {},
): HostDistributionMetadataV1 {
  return {
    schemaVersion: 1,
    listing: {
      summary: 'Plan and complete shared team work.',
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
      screenshots: SCREENSHOT_PATHS.map((sourcePath, index) => ({
        source: { kind: 'asset' as const, sourcePath, logicalId: logicalId(sourcePath) },
        alt: `Acme Tasks MCP App state ${index + 1}`,
        prompt: [
          'Show my task board.',
          'Open the task details.',
          'Prepare this task for completion.',
        ][index] as string,
      })),
    },
    review: {
      instructions: 'Use the seeded reviewer workspace. Credentials are supplied out of band.',
      scenarios: [
        {
          id: 'review_tasks',
          prompt: 'Review my open tasks.',
          expected: 'The current task list is returned.',
          shouldInvoke: true,
        },
        {
          id: 'inspect_task',
          prompt: 'Open the highest priority task.',
          expected: 'The selected task details are returned.',
          shouldInvoke: true,
        },
        {
          id: 'complete_task',
          prompt: 'Complete the task I selected.',
          expected: 'The selected task is completed after confirmation.',
          shouldInvoke: true,
        },
      ],
    },
    ...overrides,
  };
}

function assets(): readonly HostPackageAssetInput[] {
  return [
    { logicalId: logicalId(ICON_PATH), sourcePath: ICON_PATH, content: PNG_1X1 },
    ...SCREENSHOT_PATHS.map((sourcePath) => ({
      logicalId: logicalId(sourcePath),
      sourcePath,
      content: SCREENSHOT,
    })),
  ];
}

function request(overrides: Partial<HostPackageRequest> = {}): HostPackageRequest {
  return {
    appPackage: appPackage(),
    distribution: distribution(),
    mcpServer: { url: 'https://mcp.acme.com/tasks', transport: 'streamable-http' },
    assets: assets(),
    ...overrides,
  };
}

function textFile(result: ReturnType<typeof packageAnthropicConnector>, path: string): string {
  if (!result.ok) throw new Error('expected successful Anthropic connector dossier');
  const file = result.files.find((candidate) => candidate.path === path);
  if (file === undefined) throw new Error(`missing ${path}`);
  return new TextDecoder().decode(file.content);
}

function dossier(result: ReturnType<typeof packageAnthropicConnector>): Record<string, unknown> {
  return JSON.parse(textFile(result, 'submission/anthropic-connector.json')) as Record<
    string,
    unknown
  >;
}

const OPTIONS = {
  auth: 'oauth-dcr',
  categories: ['Productivity'],
  allowedLinks: ['https://app.acme.com'],
} as const;

describe('Anthropic Connector Directory adapter', () => {
  it('renders a deterministic, credential-free operator dossier separate from a Claude plugin', () => {
    const first = packageAnthropicConnector(request(), OPTIONS);
    const second = packageAnthropicConnector(request({ assets: [...assets()].reverse() }), OPTIONS);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.target).toBe('anthropic-connector');
    expect(first.archive.bytes).toEqual(second.archive.bytes);
    expect(first.files.map((file) => file.path)).toEqual([
      'assets/icon.png',
      'assets/screenshot-01.png',
      'assets/screenshot-02.png',
      'assets/screenshot-03.png',
      'submission/README.md',
      'submission/anthropic-connector.json',
    ]);
    expect(first.files.some((file) => file.path.startsWith('.claude-plugin/'))).toBe(false);

    expect(dossier(first)).toMatchObject({
      format: 'noodle-anthropic-connector-dossier',
      schemaVersion: 1,
      portalUploadable: false,
      target: 'anthropic-connector-directory',
      listing: {
        name: 'Acme Tasks',
        tagline: 'Plan and complete shared team work.',
        categories: ['Productivity'],
      },
      connection: {
        url: 'https://mcp.acme.com/tasks',
        transport: 'streamable-http',
        authentication: 'oauth_dcr',
      },
      allowedLinks: {
        candidates: ['https://app.acme.com'],
        ownershipAttestationIncluded: false,
      },
      testAccount: { credentialsIncluded: false },
    });
    expect(dossier(first).testAccount).toEqual({ credentialsIncluded: false });
    expect(dossier(first)).toHaveProperty('screenshots', [
      expect.objectContaining({
        path: 'assets/screenshot-01.png',
        prompt: 'Show my task board.',
        width: 1200,
        height: 800,
      }),
      expect.objectContaining({
        path: 'assets/screenshot-02.png',
        prompt: 'Open the task details.',
      }),
      expect.objectContaining({
        path: 'assets/screenshot-03.png',
        prompt: 'Prepare this task for completion.',
      }),
    ]);
    expect(textFile(first, 'submission/anthropic-connector.json')).not.toContain('client_secret');
    expect(textFile(first, 'submission/anthropic-connector.json')).not.toContain(
      distribution().review.instructions,
    );
    expect(textFile(first, 'submission/README.md')).toContain('Anthropic submission portal');
  });

  it('never serializes free-form reviewer instructions into the credential-free dossier', () => {
    const instructions = 'Reviewer password: short-secret';
    const result = packageAnthropicConnector(
      request({
        distribution: distribution({
          review: { ...distribution().review, instructions },
        }),
      }),
      OPTIONS,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(dossier(result).testAccount).toEqual({ credentialsIncluded: false });
    expect(textFile(result, 'submission/anthropic-connector.json')).not.toContain(instructions);
  });

  it('rejects credential-bearing MCP and public listing URLs', () => {
    const mcpUrls = [
      'https://reviewer:short-secret@mcp.acme.com/tasks',
      'https://mcp.acme.com/tasks?access_token=short-secret',
    ];
    for (const url of mcpUrls) {
      const result = packageAnthropicConnector(
        request({ mcpServer: { url, transport: 'streamable-http' } }),
        OPTIONS,
      );
      expect(result.ok, url).toBe(false);
      expect(
        result.issues.map((issue) => issue.code),
        url,
      ).toContain('host_package_invalid_mcp_url');
    }

    const listingUrls = [
      'https://reviewer:short-secret@docs.acme.com/tasks',
      'https://docs.acme.com/tasks?access_token=short-secret',
    ];
    for (const [index, documentationUrl] of listingUrls.entries()) {
      const result = packageAnthropicConnector(
        request({
          distribution: distribution({
            support: { ...distribution().support, documentationUrl },
          }),
        }),
        OPTIONS,
      );
      expect(result.ok, documentationUrl).toBe(false);
      expect(
        result.issues.map((issue) => issue.code),
        documentationUrl,
      ).toContain(
        index === 0 ? 'host_package_invalid_metadata' : 'anthropic_listing_public_url_required',
      );
    }
  });

  it('fails closed when required directory evidence is incomplete', () => {
    const missingTitles = packageAnthropicConnector(
      request({ appPackage: PRODUCT_SKILL_INPUT }),
      OPTIONS,
    );
    expect(missingTitles.ok).toBe(false);
    expect(missingTitles.issues.map((issue) => issue.code)).toContain(
      'anthropic_tool_title_required',
    );

    const twoScreenshots = packageAnthropicConnector(
      request({
        distribution: distribution({
          assets: {
            ...distribution().assets,
            screenshots: distribution().assets.screenshots?.slice(0, 2),
          },
        }),
        assets: assets().slice(0, 3),
      }),
      OPTIONS,
    );
    expect(twoScreenshots.ok).toBe(false);
    expect(twoScreenshots.issues.map((issue) => issue.code)).toContain(
      'anthropic_app_screenshot_count_invalid',
    );

    const noPrompts = packageAnthropicConnector(
      request({
        distribution: distribution({
          assets: {
            ...distribution().assets,
            screenshots: distribution().assets.screenshots?.map(({ source, alt }) => ({
              source,
              alt,
            })),
          },
        }),
      }),
      OPTIONS,
    );
    expect(noPrompts.ok).toBe(false);
    expect(noPrompts.issues.map((issue) => issue.code)).toContain(
      'anthropic_app_screenshot_prompt_required',
    );
  });

  it('rejects incompatible auth, categories, URLs, screenshots, and use cases', () => {
    const auth = packageAnthropicConnector(request(), { ...OPTIONS, auth: 'none' });
    expect(auth.ok).toBe(false);
    expect(auth.issues.map((issue) => issue.code)).toContain('anthropic_auth_mismatch');

    const categories = packageAnthropicConnector(request(), { ...OPTIONS, categories: [] });
    expect(categories.ok).toBe(false);
    expect(categories.issues.map((issue) => issue.code)).toContain('anthropic_categories_invalid');

    const listingBounds = packageAnthropicConnector(
      request({
        appPackage: appPackage({
          app: { ...PRODUCT_SKILL_INPUT.app, title: 'A'.repeat(101) },
        }),
        distribution: distribution({
          listing: { ...distribution().listing, summary: 'T'.repeat(56) },
        }),
      }),
      OPTIONS,
    );
    expect(listingBounds.ok).toBe(false);
    expect(listingBounds.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'anthropic_listing_name_invalid',
        'anthropic_listing_tagline_invalid',
      ]),
    );

    const local = packageAnthropicConnector(
      request({ mcpServer: { url: 'http://127.0.0.1:8787/mcp', transport: 'streamable-http' } }),
      OPTIONS,
    );
    expect(local.ok).toBe(false);
    expect(local.issues.map((issue) => issue.code)).toContain(
      'anthropic_connector_public_url_required',
    );

    const invalidAllowedLinks = packageAnthropicConnector(request(), {
      ...OPTIONS,
      allowedLinks: ['https://app.acme.com/tasks'],
    });
    expect(invalidAllowedLinks.ok).toBe(false);
    expect(invalidAllowedLinks.issues.map((issue) => issue.code)).toContain(
      'anthropic_allowed_links_invalid',
    );

    const undersized = packageAnthropicConnector(
      request({
        assets: assets().map((asset, index) =>
          index === 1 ? { ...asset, content: PNG_1X1 } : asset,
        ),
      }),
      OPTIONS,
    );
    expect(undersized.ok).toBe(false);
    expect(undersized.issues.map((issue) => issue.code)).toContain(
      'anthropic_app_screenshot_width_invalid',
    );

    const jpeg = packageAnthropicConnector(
      request({
        assets: assets().map((asset, index) =>
          index === 1 ? { ...asset, content: JPEG_1X1 } : asset,
        ),
      }),
      OPTIONS,
    );
    expect(jpeg.ok).toBe(false);
    expect(jpeg.issues.map((issue) => issue.code)).toContain(
      'anthropic_app_screenshot_format_invalid',
    );

    const useCases = packageAnthropicConnector(
      request({
        distribution: distribution({
          review: {
            instructions: 'Use fixture data.',
            scenarios: distribution().review.scenarios.slice(0, 2),
          },
        }),
      }),
      OPTIONS,
    );
    expect(useCases.ok).toBe(false);
    expect(useCases.issues.map((issue) => issue.code)).toContain('anthropic_use_cases_missing');
  });
});
