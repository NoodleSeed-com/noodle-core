import { createHash } from 'node:crypto';
import {
  type HostPackageAdapterInput,
  type HostPackageFile,
  skillSlug,
} from '@noodle-borg/agent-packaging';
import type { NormalizedAnthropicConnectorOptions } from './anthropic-connector-types.js';
import { renderProductSkillMarkdown } from './product-skill-markdown.js';

export function renderAnthropicConnector(
  input: HostPackageAdapterInput,
  options: NormalizedAnthropicConnectorOptions,
): readonly HostPackageFile[] {
  const screenshotPaths = input.assets.screenshots.map(
    (_, index) => `assets/screenshot-${String(index + 1).padStart(2, '0')}.png`,
  );
  const iconPath = `assets/icon.${iconExtension(input.assets.icon.mimeType)}`;
  return [
    { role: 'branding', path: iconPath, content: input.assets.icon.content },
    ...input.assets.screenshots.map((screenshot, index) => ({
      role: 'branding' as const,
      path: screenshotPaths[index] as string,
      content: screenshot.content,
    })),
    {
      role: 'documentation',
      path: 'submission/README.md',
      content: readme(input, options),
    },
    {
      role: 'test',
      path: 'submission/anthropic-connector.json',
      content: json(dossier(input, options, iconPath, screenshotPaths)),
    },
  ];
}

function dossier(
  input: HostPackageAdapterInput,
  options: NormalizedAnthropicConnectorOptions,
  iconPath: string,
  screenshotPaths: readonly string[],
): object {
  const slug = skillSlug(input.appPackage.app.name);
  const positive = input.distribution.review.scenarios.filter((scenario) => scenario.shouldInvoke);
  const markdown = renderProductSkillMarkdown(input.appPackage);
  return {
    format: 'noodle-anthropic-connector-dossier',
    schemaVersion: 1,
    portalUploadable: false,
    target: 'anthropic-connector-directory',
    listing: {
      name: input.appPackage.app.title,
      permanentSlug: slug,
      tagline: input.distribution.listing.summary,
      description: input.distribution.listing.description,
      categories: options.categories,
      publisher: input.distribution.publisher,
      support: input.distribution.support,
      legal: input.distribution.legal,
      icon: { path: iconPath, alt: input.assets.icon.alt, sha256: input.assets.icon.sha256 },
    },
    connection: {
      url: input.mcpServer.url,
      transport: input.mcpServer.transport,
      authentication: options.auth,
    },
    capabilities: {
      read: input.appPackage.surface.tools.some((tool) => tool.behavior.readOnly),
      write: input.appPackage.surface.tools.some((tool) => !tool.behavior.readOnly),
      mcpApp: input.appPackage.surface.widgets.length > 0,
    },
    tools: [...input.appPackage.surface.tools].sort(byName).map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      annotations: {
        readOnlyHint: tool.behavior.readOnly,
        destructiveHint: tool.behavior.destructive,
        idempotentHint: tool.behavior.idempotent,
        openWorldHint: tool.behavior.openWorld,
      },
    })),
    resources: [...input.appPackage.surface.resources].sort(byName),
    prompts: [...input.appPackage.surface.prompts].sort(byName),
    useCases: positive.map((scenario) => ({
      id: scenario.id,
      prompt: scenario.prompt,
      expected: scenario.expected,
    })),
    allowedLinks: {
      candidates: options.allowedLinks,
      ownershipAttestationIncluded: false,
    },
    screenshots: input.assets.screenshots.map((screenshot, index) => ({
      path: screenshotPaths[index],
      prompt: screenshot.prompt,
      alt: screenshot.alt,
      width: screenshot.width,
      height: screenshot.height,
      sha256: screenshot.sha256,
      cropAttestationIncluded: false,
    })),
    testAccount: { credentialsIncluded: false },
    agentGuideSnapshot: [
      { path: `skills/${slug}/SKILL.md`, sha256: sha256(markdown.skill) },
      {
        path: `skills/${slug}/references/mcp-surface.md`,
        sha256: sha256(markdown.reference),
      },
    ],
    operatorRequired: [
      'anthropic_connector_directory_access',
      'verify_allowed_link_ownership',
      ...(options.auth === 'oauth_dcr'
        ? ['verify_oauth_discovery_and_dynamic_client_registration']
        : []),
      ...(input.appPackage.surface.auth.required
        ? ['provide_test_account_credentials_out_of_band']
        : []),
      ...(input.appPackage.surface.widgets.length > 0
        ? ['confirm_each_screenshot_is_cropped_to_the_mcp_app_response']
        : []),
      'complete_company_data_and_compliance_answers_in_portal',
      'human_review_and_submit_in_portal',
    ],
  };
}

function readme(
  input: HostPackageAdapterInput,
  options: NormalizedAnthropicConnectorOptions,
): string {
  return `# ${input.appPackage.app.title} — Anthropic Connector Directory dossier

This archive is operator evidence for the Anthropic submission portal. It is not an installable Claude Code plugin and cannot be uploaded as one file.

## Before submission

1. Test the production MCP URL \`${input.mcpServer.url}\` and every declared tool.
2. Confirm the selected authentication mode is \`${options.auth}\`.
3. Verify ownership of every allowed-link candidate.
4. Confirm each PNG is cropped to the MCP App response only and matches its separately listed prompt.
5. Supply any test-account credentials directly in the portal, never in this archive or source control.
6. Copy the dossier fields into the Anthropic submission portal, complete company/data/compliance answers, and submit for human review.

Documentation: ${input.distribution.support.documentationUrl}
Privacy policy: ${input.distribution.legal.privacyPolicyUrl}
Support: ${input.distribution.support.supportUrl}
`;
}

function byName(left: { readonly name: string }, right: { readonly name: string }): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function iconExtension(mimeType: string): 'jpg' | 'png' | 'webp' {
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/webp') return 'webp';
  return 'png';
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
