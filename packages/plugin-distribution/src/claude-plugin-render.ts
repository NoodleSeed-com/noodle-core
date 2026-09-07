import {
  type HostPackageAdapterInput,
  type HostPackageFile,
  type ResolvedHostPackageImage,
  skillSlug,
} from '@noodle-borg/agent-packaging';
import { renderProductSkillMarkdown } from './product-skill-markdown.js';

export function renderClaudePlugin(input: HostPackageAdapterInput): readonly HostPackageFile[] {
  const slug = skillSlug(input.appPackage.app.name);
  const iconPath = `assets/icon.${extension(input.assets.icon)}`;
  const markdown = renderProductSkillMarkdown(input.appPackage);
  return [
    {
      role: 'manifest',
      path: '.claude-plugin/plugin.json',
      content: json({
        $schema: 'https://json.schemastore.org/claude-code-plugin-manifest.json',
        name: slug,
        displayName: input.appPackage.app.title,
        version: input.appPackage.app.version,
        description: input.distribution.listing.summary,
        author: { name: input.distribution.publisher.name },
        homepage: input.distribution.support.documentationUrl,
        ...(input.distribution.listing.keywords === undefined
          ? {}
          : { keywords: input.distribution.listing.keywords }),
        defaultEnabled: false,
        skills: './skills/',
        mcpServers: './.mcp.json',
      }),
    },
    {
      role: 'mcp',
      path: '.mcp.json',
      content: json({
        mcpServers: {
          [slug]: { type: 'http', url: input.mcpServer.url },
        },
      }),
    },
    {
      role: 'documentation',
      path: 'README.md',
      content: readme(input, slug, iconPath),
    },
    { role: 'branding', path: iconPath, content: input.assets.icon.content },
    { role: 'skill', path: `skills/${slug}/SKILL.md`, content: markdown.skill },
    {
      role: 'skill',
      path: `skills/${slug}/references/mcp-surface.md`,
      content: markdown.reference,
    },
  ];
}

function readme(input: HostPackageAdapterInput, slug: string, iconPath: string): string {
  return `# ${input.appPackage.app.title}

${input.distribution.listing.description}

This repository is an installable Claude Code plugin generated from the app's canonical Noodle Seed \`server.ts\`.

## Validate and test

\`\`\`bash
claude plugin validate . --strict
claude --plugin-dir .
\`\`\`

The plugin connects \`${slug}\` to \`${input.mcpServer.url}\`. Because the remote MCP server is opt-in, the manifest sets \`defaultEnabled\` to \`false\`; authenticate from Claude's MCP flow when the server requires it.

The bundled product skill lives at \`skills/${slug}/SKILL.md\`, its MCP reference is generated from the same App Package, and the repository icon is \`${iconPath}\`.

## Support and policies

- Documentation: ${input.distribution.support.documentationUrl}
- Support: ${input.distribution.support.supportUrl}
- Privacy: ${input.distribution.legal.privacyPolicyUrl}
${
  input.distribution.legal.termsOfServiceUrl === undefined
    ? ''
    : `- Terms: ${input.distribution.legal.termsOfServiceUrl}\n`
}
Publish this directory through a public Git repository only after the strict validator and live MCP connection both pass. Connector Directory submission evidence is intentionally generated as a different archive.
`;
}

function extension(image: ResolvedHostPackageImage): 'jpg' | 'png' | 'webp' {
  if (image.mimeType === 'image/jpeg') return 'jpg';
  if (image.mimeType === 'image/webp') return 'webp';
  return 'png';
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
