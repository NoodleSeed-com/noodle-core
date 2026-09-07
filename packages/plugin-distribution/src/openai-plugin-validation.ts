import {
  type HostPackageAdapterInput,
  type HostPackageTargetIssue,
  skillSlug,
} from '@noodle-borg/agent-packaging';
import type { NormalizedOpenAiPluginOptions, OpenAiPluginOptions } from './openai-plugin-types.js';
import { isPublicHttpsUrl } from './public-url.js';

const STRICT_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const CATEGORY = /^[A-Za-z0-9][A-Za-z0-9 &/()-]{0,99}$/;
const REGISTERED_APP_ID = /^plugin_asdk_app_[a-f0-9]{32}$/;
const MAX_PLUGIN_NAME_CHARS = 64;
const MAX_STARTER_PROMPT_CHARS = 128;
const MAX_SUBMISSION_SUBTITLE_CHARS = 30;
const MAX_SUBMISSION_DESCRIPTION_CHARS = 4_000;

interface OptionsValidation {
  readonly options?: NormalizedOpenAiPluginOptions;
  readonly issues: readonly HostPackageTargetIssue[];
}

export function validateOpenAiPluginOptions(options: OpenAiPluginOptions): OptionsValidation {
  if (!isRecord(options)) {
    return {
      issues: [
        issue(
          'openai_distribution_state_invalid',
          'options.state',
          'Choose the local or submission OpenAI distribution state.',
        ),
      ],
    };
  }
  const issues: HostPackageTargetIssue[] = [];
  const state = options.state;
  if (state !== 'local' && state !== 'submission') {
    issues.push(
      issue(
        'openai_distribution_state_invalid',
        'options.state',
        'Choose the local or submission OpenAI distribution state.',
      ),
    );
  }
  const category = options.category;
  if (typeof category !== 'string' || !CATEGORY.test(category)) {
    issues.push(
      issue(
        'openai_category_invalid',
        'options.category',
        'Choose a bounded OpenAI category label.',
      ),
    );
  }

  if (state === 'local') {
    if (!hasOnlyKeys(options, ['state', 'category', 'registeredAppId'])) {
      issues.push(
        issue(
          'openai_options_invalid',
          'options',
          'The OpenAI local package options contain an unsupported field.',
        ),
      );
    }
    if (
      typeof options.registeredAppId !== 'string' ||
      !REGISTERED_APP_ID.test(options.registeredAppId)
    ) {
      issues.push(
        issue(
          'openai_local_registered_app_invalid',
          'options.registeredAppId',
          'Local ChatGPT testing requires a registered developer-mode app ID.',
        ),
      );
    }
  } else if (state === 'submission') {
    if (!hasOnlyKeys(options, ['state', 'category'])) {
      issues.push(
        issue(
          'openai_submission_registered_app_forbidden',
          'options',
          'Public submission must use the MCP URL rather than an existing registration ID.',
        ),
      );
    }
  }

  if (issues.length > 0 || (state !== 'local' && state !== 'submission')) return { issues };
  if (typeof category !== 'string') return { issues };
  return {
    options:
      state === 'local'
        ? { state, category, registeredAppId: options.registeredAppId }
        : { state, category },
    issues,
  };
}

export function validateOpenAiPluginInput(
  input: HostPackageAdapterInput,
  options: NormalizedOpenAiPluginOptions | undefined,
): readonly HostPackageTargetIssue[] {
  if (options === undefined) return [];
  const issues: HostPackageTargetIssue[] = [];
  const slug = skillSlug(input.appPackage.app.name);
  if (slug.length > MAX_PLUGIN_NAME_CHARS) {
    issues.push(
      issue(
        'openai_plugin_name_invalid',
        'appPackage.app.name',
        'The projected OpenAI plugin name exceeds the host limit.',
      ),
    );
  }
  if (!STRICT_SEMVER.test(input.appPackage.app.version)) {
    issues.push(
      issue(
        'openai_plugin_version_invalid',
        'appPackage.app.version',
        'The OpenAI plugin version must use strict semantic versioning.',
      ),
    );
  }
  const prompts = input.appPackage.skill.examples.slice(0, 3).map((example) => example.prompt);
  if (prompts.length === 0 || prompts.some((prompt) => prompt.length > MAX_STARTER_PROMPT_CHARS)) {
    issues.push(
      issue(
        'openai_starter_prompt_invalid',
        'appPackage.skill.examples',
        'OpenAI starter prompts must contain one to three entries of at most 128 characters.',
      ),
    );
  }
  if (input.assets.screenshots.some((screenshot) => screenshot.mimeType !== 'image/png')) {
    issues.push(
      issue(
        'openai_screenshot_format_invalid',
        'distribution.assets.screenshots',
        'OpenAI plugin screenshots must be PNG images.',
      ),
    );
  }
  if (options.state !== 'submission') return issues;

  if (input.distribution.listing.summary.length > MAX_SUBMISSION_SUBTITLE_CHARS) {
    issues.push(
      issue(
        'openai_submission_subtitle_invalid',
        'distribution.listing.summary',
        'OpenAI submission subtitles must be at most 30 characters.',
      ),
    );
  }
  if (input.distribution.listing.description.length > MAX_SUBMISSION_DESCRIPTION_CHARS) {
    issues.push(
      issue(
        'openai_submission_description_invalid',
        'distribution.listing.description',
        'OpenAI submission descriptions must be at most 4,000 characters.',
      ),
    );
  }

  const endpoint = new URL(input.mcpServer.url);
  if (endpoint.protocol !== 'https:') {
    issues.push(
      issue(
        'openai_submission_https_required',
        'mcpServer.url',
        'OpenAI submission requires a public production HTTPS MCP endpoint.',
      ),
    );
  }
  if (!isPublicHttpsUrl(input.mcpServer.url)) {
    issues.push(
      issue(
        'openai_submission_public_endpoint_required',
        'mcpServer.url',
        'OpenAI submission requires a publicly reachable production MCP hostname.',
      ),
    );
  }
  const publicListingUrls = [
    ['distribution.publisher.websiteUrl', input.distribution.publisher.websiteUrl],
    ['distribution.support.documentationUrl', input.distribution.support.documentationUrl],
    ['distribution.support.supportUrl', input.distribution.support.supportUrl],
    ['distribution.legal.privacyPolicyUrl', input.distribution.legal.privacyPolicyUrl],
    ...(input.distribution.legal.termsOfServiceUrl === undefined
      ? []
      : [['distribution.legal.termsOfServiceUrl', input.distribution.legal.termsOfServiceUrl]]),
  ] as const;
  for (const [path, url] of publicListingUrls) {
    if (isPublicHttpsUrl(url)) continue;
    issues.push(
      issue(
        'openai_submission_public_url_required',
        path,
        'OpenAI submission listing and policy URLs must use public HTTPS hostnames.',
      ),
    );
  }
  if (input.distribution.legal.termsOfServiceUrl === undefined) {
    issues.push(
      issue(
        'openai_submission_terms_required',
        'distribution.legal.termsOfServiceUrl',
        'OpenAI submission requires a public terms-of-service URL.',
      ),
    );
  }
  const positive = input.distribution.review.scenarios.filter((scenario) => scenario.shouldInvoke);
  const negative = input.distribution.review.scenarios.filter((scenario) => !scenario.shouldInvoke);
  if (positive.length < 5) {
    issues.push(
      issue(
        'openai_submission_positive_tests_missing',
        'distribution.review.scenarios',
        'OpenAI submission requires at least five positive review cases.',
      ),
    );
  }
  if (negative.length < 3) {
    issues.push(
      issue(
        'openai_submission_negative_tests_missing',
        'distribution.review.scenarios',
        'OpenAI submission requires at least three negative review cases.',
      ),
    );
  }
  const availableTools = new Set(input.appPackage.surface.tools.map((tool) => tool.name));
  for (const scenario of positive.slice(0, 5)) {
    if (scenario.tools === undefined || scenario.tools.length === 0) {
      issues.push(
        issue(
          'openai_submission_test_tools_missing',
          `distribution.review.scenarios.${scenario.id}.tools`,
          'Each positive OpenAI review case must name the MCP tools it expects to trigger.',
        ),
      );
      continue;
    }
    if (scenario.tools.some((tool) => !availableTools.has(tool))) {
      issues.push(
        issue(
          'openai_submission_test_tool_unknown',
          `distribution.review.scenarios.${scenario.id}.tools`,
          'OpenAI review cases may reference only tools in the compiled MCP surface.',
        ),
      );
    }
  }
  return issues;
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
