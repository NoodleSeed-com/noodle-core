import {
  type HostPackageAdapterInput,
  type HostPackageFile,
  type ResolvedHostPackageImage,
  skillSlug,
} from '@noodle-borg/agent-packaging';
import type { NormalizedOpenAiPluginOptions } from './openai-plugin-types.js';
import { renderOpenAiSubmissionArtifacts } from './openai-submission-render.js';
import { renderProductSkillMarkdown } from './product-skill-markdown.js';

export function renderOpenAiPlugin(
  input: HostPackageAdapterInput,
  options: NormalizedOpenAiPluginOptions,
): readonly HostPackageFile[] {
  const slug = skillSlug(input.appPackage.app.name);
  const pluginPrefix = options.state === 'local' ? `plugins/${slug}/` : '';
  const pluginPath = (path: string): string => `${pluginPrefix}${path}`;
  const iconPath = `assets/icon.${extension(input.assets.icon)}`;
  const logoPath =
    input.assets.logo === undefined ? iconPath : `assets/logo.${extension(input.assets.logo)}`;
  const screenshotPaths = input.assets.screenshots.map(
    (image, index) => `assets/screenshot-${String(index + 1).padStart(2, '0')}.${extension(image)}`,
  );
  const markdown = renderProductSkillMarkdown(input.appPackage);
  const skillPath = `skills/${slug}/SKILL.md`;
  const referencePath = `skills/${slug}/references/mcp-surface.md`;
  const pluginFiles: HostPackageFile[] = [
    {
      role: 'manifest',
      path: pluginPath('.codex-plugin/plugin.json'),
      content: json(pluginManifest(input, options, iconPath, logoPath, screenshotPaths)),
    },
    {
      role: 'mcp',
      path: pluginPath('.mcp.json'),
      content: json(mcpManifest(input, slug)),
    },
    { role: 'skill', path: pluginPath(skillPath), content: markdown.skill },
    { role: 'skill', path: pluginPath(referencePath), content: markdown.reference },
    { role: 'branding', path: pluginPath(iconPath), content: input.assets.icon.content },
    ...(input.assets.logo === undefined
      ? []
      : [
          {
            role: 'branding' as const,
            path: pluginPath(logoPath),
            content: input.assets.logo.content,
          },
        ]),
    ...input.assets.screenshots.map((image, index) => ({
      role: 'branding' as const,
      path: pluginPath(screenshotPaths[index] as string),
      content: image.content,
    })),
  ];

  if (options.state === 'local') {
    return [
      ...pluginFiles,
      {
        role: 'mcp',
        path: pluginPath('.app.json'),
        content: json({
          apps: {
            [slug]: { id: options.registeredAppId, category: options.category },
          },
        }),
      },
      {
        role: 'manifest',
        path: '.agents/plugins/marketplace.json',
        content: json(localMarketplace(slug, options.category)),
      },
    ];
  }

  return [...pluginFiles, ...renderOpenAiSubmissionArtifacts(input, options, markdown)];
}

function pluginManifest(
  input: HostPackageAdapterInput,
  options: NormalizedOpenAiPluginOptions,
  iconPath: string,
  logoPath: string,
  screenshotPaths: readonly string[],
): object {
  const branding = input.appPackage.app.branding;
  return {
    name: skillSlug(input.appPackage.app.name),
    version: input.appPackage.app.version,
    description: input.distribution.listing.summary,
    author: {
      name: input.distribution.publisher.name,
      url: input.distribution.publisher.websiteUrl,
    },
    homepage: input.distribution.support.documentationUrl,
    ...(input.distribution.listing.keywords === undefined
      ? {}
      : { keywords: input.distribution.listing.keywords }),
    skills: './skills/',
    mcpServers: './.mcp.json',
    ...(options.state === 'local' ? { apps: './.app.json' } : {}),
    interface: {
      displayName: input.appPackage.app.title,
      shortDescription: input.distribution.listing.summary,
      longDescription: input.distribution.listing.description,
      developerName: input.distribution.publisher.name,
      category: options.category,
      capabilities: capabilities(input),
      websiteURL: input.distribution.publisher.websiteUrl,
      privacyPolicyURL: input.distribution.legal.privacyPolicyUrl,
      supportURL: input.distribution.support.supportUrl,
      ...(input.distribution.legal.termsOfServiceUrl === undefined
        ? {}
        : { termsOfServiceURL: input.distribution.legal.termsOfServiceUrl }),
      defaultPrompt: starterPrompts(input),
      ...(branding?.accent !== undefined && /^#[a-f0-9]{6}$/i.test(branding.accent)
        ? { brandColor: branding.accent.toUpperCase() }
        : {}),
      composerIcon: `./${iconPath}`,
      logo: `./${logoPath}`,
      screenshots: screenshotPaths.map((path) => `./${path}`),
    },
  };
}

function mcpManifest(input: HostPackageAdapterInput, slug: string): object {
  return {
    [slug]: {
      url: input.mcpServer.url,
    },
  };
}

function localMarketplace(slug: string, category: string): object {
  return {
    name: 'noodle-openai-local',
    interface: { displayName: 'Noodle Seed OpenAI Local' },
    plugins: [
      {
        name: slug,
        source: { source: 'local', path: `./plugins/${slug}` },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        category,
      },
    ],
  };
}

function capabilities(input: HostPackageAdapterInput): readonly string[] {
  return [
    ...(input.appPackage.surface.widgets.length > 0 ? ['Interactive'] : []),
    ...(input.appPackage.surface.tools.some((tool) => tool.behavior.readOnly) ? ['Read'] : []),
    ...(input.appPackage.surface.tools.some((tool) => !tool.behavior.readOnly) ? ['Write'] : []),
  ];
}

function starterPrompts(input: HostPackageAdapterInput): readonly string[] {
  return input.appPackage.skill.examples.slice(0, 3).map((example) => example.prompt);
}

function extension(image: ResolvedHostPackageImage): 'jpg' | 'png' | 'webp' {
  if (image.mimeType === 'image/jpeg') return 'jpg';
  if (image.mimeType === 'image/webp') return 'webp';
  return 'png';
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
