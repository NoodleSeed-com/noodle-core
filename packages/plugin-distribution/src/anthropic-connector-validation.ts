import type { HostPackageAdapterInput, HostPackageTargetIssue } from '@noodle-borg/agent-packaging';
import type {
  AnthropicConnectorOptions,
  NormalizedAnthropicConnectorOptions,
} from './anthropic-connector-types.js';
import { isPublicHttpsUrl } from './public-url.js';

const CATEGORY = /^[A-Za-z0-9][A-Za-z0-9 &/()+.,'-]{0,99}$/;
const MAX_NAME_CHARS = 100;
const MAX_TAGLINE_CHARS = 55;
const MAX_DESCRIPTION_CHARS = 2_000;
const MAX_TOOL_NAME_CHARS = 64;
const MIN_USE_CASES = 3;
const MIN_APP_SCREENSHOTS = 3;
const MAX_APP_SCREENSHOTS = 5;
const MIN_SCREENSHOT_WIDTH = 1_000;

interface OptionsValidation {
  readonly options?: NormalizedAnthropicConnectorOptions;
  readonly issues: readonly HostPackageTargetIssue[];
}

export function validateAnthropicConnectorOptions(
  options: AnthropicConnectorOptions,
): OptionsValidation {
  if (!isRecord(options)) {
    return {
      issues: [
        issue('anthropic_options_invalid', 'options', 'Anthropic connector options are invalid.'),
      ],
    };
  }
  const issues: HostPackageTargetIssue[] = [];
  if (!hasOnlyKeys(options, ['auth', 'categories', 'allowedLinks'])) {
    issues.push(
      issue(
        'anthropic_options_invalid',
        'options',
        'Anthropic connector options contain an unsupported field.',
      ),
    );
  }
  if (options.auth !== 'none' && options.auth !== 'oauth-dcr') {
    issues.push(
      issue(
        'anthropic_auth_invalid',
        'options.auth',
        'Choose none or oauth-dcr for Anthropic connector authentication.',
      ),
    );
  }
  if (
    !Array.isArray(options.categories) ||
    options.categories.length < 1 ||
    options.categories.length > 5 ||
    options.categories.some(
      (category) => typeof category !== 'string' || !CATEGORY.test(category),
    ) ||
    new Set(options.categories).size !== options.categories.length
  ) {
    issues.push(
      issue(
        'anthropic_categories_invalid',
        'options.categories',
        'Choose one to five unique bounded Anthropic Connector Directory categories.',
      ),
    );
  }
  if (
    !Array.isArray(options.allowedLinks) ||
    options.allowedLinks.some((candidate) => !validHttpsOrigin(candidate)) ||
    new Set(options.allowedLinks).size !== options.allowedLinks.length
  ) {
    issues.push(
      issue(
        'anthropic_allowed_links_invalid',
        'options.allowedLinks',
        'Allowed-link candidates must be unique HTTPS origins without credentials, paths, or queries.',
      ),
    );
  }
  if (
    issues.length > 0 ||
    (options.auth !== 'none' && options.auth !== 'oauth-dcr') ||
    !Array.isArray(options.categories) ||
    !Array.isArray(options.allowedLinks)
  ) {
    return { issues };
  }
  return {
    options: {
      auth: options.auth === 'oauth-dcr' ? 'oauth_dcr' : 'none',
      categories: [...options.categories],
      allowedLinks: [...options.allowedLinks].sort(compare),
    },
    issues,
  };
}

export function validateAnthropicConnectorInput(
  input: HostPackageAdapterInput,
  options: NormalizedAnthropicConnectorOptions | undefined,
): readonly HostPackageTargetIssue[] {
  if (options === undefined) return [];
  const issues: HostPackageTargetIssue[] = [];
  const listing = input.distribution.listing;
  if (input.appPackage.app.title.length > MAX_NAME_CHARS) {
    issues.push(
      issue(
        'anthropic_listing_name_invalid',
        'appPackage.app.title',
        'The Anthropic connector name must be at most 100 characters.',
      ),
    );
  }
  if (listing.summary.length > MAX_TAGLINE_CHARS) {
    issues.push(
      issue(
        'anthropic_listing_tagline_invalid',
        'distribution.listing.summary',
        'The Anthropic connector tagline must be at most 55 characters.',
      ),
    );
  }
  if (listing.description.length > MAX_DESCRIPTION_CHARS) {
    issues.push(
      issue(
        'anthropic_listing_description_invalid',
        'distribution.listing.description',
        'The Anthropic connector description must be at most 2,000 characters.',
      ),
    );
  }
  if (!isPublicHttpsUrl(input.mcpServer.url)) {
    issues.push(
      issue(
        'anthropic_connector_public_url_required',
        'mcpServer.url',
        'Anthropic Connector Directory submission requires a public production HTTPS MCP URL.',
      ),
    );
  }
  for (const [path, url] of publicListingUrls(input)) {
    if (isPublicHttpsUrl(url)) continue;
    issues.push(
      issue(
        'anthropic_listing_public_url_required',
        path,
        'Anthropic listing, documentation, support, and policy URLs must be public HTTPS URLs.',
      ),
    );
  }

  const authRequired = options.auth !== 'none';
  if (input.appPackage.surface.auth.required !== authRequired) {
    issues.push(
      issue(
        'anthropic_auth_mismatch',
        'options.auth',
        'The selected Anthropic authentication mode must match the compiled app authentication requirement.',
      ),
    );
  }

  for (const tool of input.appPackage.surface.tools) {
    if (tool.name.length > MAX_TOOL_NAME_CHARS) {
      issues.push(
        issue(
          'anthropic_tool_name_invalid',
          `appPackage.surface.tools.${tool.name}`,
          'Anthropic connector tool names must be at most 64 characters.',
        ),
      );
    }
    if (tool.title === undefined || tool.title.trim().length === 0) {
      issues.push(
        issue(
          'anthropic_tool_title_required',
          `appPackage.surface.tools.${tool.name}.title`,
          'Every Anthropic connector tool requires a human-readable title.',
        ),
      );
    }
  }

  const positive = input.distribution.review.scenarios.filter((scenario) => scenario.shouldInvoke);
  if (positive.length < MIN_USE_CASES) {
    issues.push(
      issue(
        'anthropic_use_cases_missing',
        'distribution.review.scenarios',
        'Anthropic Connector Directory submission requires at least three working use cases.',
      ),
    );
  }

  const screenshots = input.assets.screenshots;
  const hasApp = input.appPackage.surface.widgets.length > 0;
  if (
    (hasApp &&
      (screenshots.length < MIN_APP_SCREENSHOTS || screenshots.length > MAX_APP_SCREENSHOTS)) ||
    (!hasApp && screenshots.length > 0 && screenshots.length < MIN_APP_SCREENSHOTS)
  ) {
    issues.push(
      issue(
        'anthropic_app_screenshot_count_invalid',
        'distribution.assets.screenshots',
        'An Anthropic MCP App submission requires three to five screenshots.',
      ),
    );
  }
  for (const [index, screenshot] of screenshots.entries()) {
    if (screenshot.mimeType !== 'image/png') {
      issues.push(
        issue(
          'anthropic_app_screenshot_format_invalid',
          `distribution.assets.screenshots.${index}`,
          'Anthropic MCP App screenshots must be PNG images.',
        ),
      );
    }
    if (screenshot.width < MIN_SCREENSHOT_WIDTH) {
      issues.push(
        issue(
          'anthropic_app_screenshot_width_invalid',
          `distribution.assets.screenshots.${index}`,
          'Anthropic MCP App screenshots must be at least 1,000 pixels wide.',
        ),
      );
    }
    if (screenshot.prompt === undefined || screenshot.prompt.trim().length === 0) {
      issues.push(
        issue(
          'anthropic_app_screenshot_prompt_required',
          `distribution.assets.screenshots.${index}.prompt`,
          'Each Anthropic MCP App screenshot requires the separate user prompt that produced it.',
        ),
      );
    }
  }
  return issues;
}

function publicListingUrls(input: HostPackageAdapterInput): readonly (readonly [string, string])[] {
  return [
    ['distribution.publisher.websiteUrl', input.distribution.publisher.websiteUrl],
    ['distribution.support.documentationUrl', input.distribution.support.documentationUrl],
    ['distribution.support.supportUrl', input.distribution.support.supportUrl],
    ['distribution.legal.privacyPolicyUrl', input.distribution.legal.privacyPolicyUrl],
    ...(input.distribution.legal.termsOfServiceUrl === undefined
      ? []
      : ([
          ['distribution.legal.termsOfServiceUrl', input.distribution.legal.termsOfServiceUrl],
        ] as const)),
  ];
}

function validHttpsOrigin(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

function issue(code: string, path: string, message: string): HostPackageTargetIssue {
  return { severity: 'error', code, path, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
