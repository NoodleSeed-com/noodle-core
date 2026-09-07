import { createHash } from 'node:crypto';
import {
  deterministicZip,
  type HostPackageAdapterInput,
  type HostPackageFile,
  type ProductSkillMarkdown,
  type ProductSkillTool,
  type RenderedHostPackageFile,
  skillSlug,
} from '@noodle-borg/agent-packaging';
import type { NormalizedOpenAiPluginOptions } from './openai-plugin-types.js';

const OPENAI_SUBMISSION_SCHEMA =
  'https://developers.openai.com/apps-sdk/schemas/chatgpt-app-submission.v1.json';

interface SubmissionTool {
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly openWorldHint: boolean;
    readonly destructiveHint: boolean;
  };
  readonly justifications: {
    readonly read_only_justification: string;
    readonly open_world_justification: string;
    readonly destructive_justification: string;
  };
}

interface SubmissionTestCase {
  readonly description: string;
  readonly user_prompt: string;
  readonly file_attachment_urls: null;
  readonly tools_triggered: string | null;
  readonly expected_output: string;
  readonly expected_output_url: null;
}

interface ChatGptAppSubmission {
  readonly $schema: typeof OPENAI_SUBMISSION_SCHEMA;
  readonly schema_version: 1;
  readonly app_info: {
    readonly display_name: string;
    readonly subtitle: string;
    readonly description: string;
    readonly category?: OpenAiSubmissionCategory;
  };
  readonly tools: Readonly<Record<string, SubmissionTool>>;
  readonly test_cases: readonly SubmissionTestCase[];
  readonly negative_test_cases: readonly SubmissionTestCase[];
}

type OpenAiSubmissionCategory =
  | 'BUSINESS'
  | 'COLLABORATION'
  | 'DESIGN'
  | 'DEVELOPER_TOOLS'
  | 'EDUCATION'
  | 'ENTERTAINMENT'
  | 'FINANCE'
  | 'FOOD'
  | 'LIFESTYLE'
  | 'NEWS'
  | 'PRODUCTIVITY'
  | 'SHOPPING'
  | 'TRAVEL';

export function renderOpenAiSubmissionArtifacts(
  input: HostPackageAdapterInput,
  options: NormalizedOpenAiPluginOptions,
  markdown: ProductSkillMarkdown,
): readonly HostPackageFile[] {
  const slug = skillSlug(input.appPackage.app.name);
  const skillArchivePath = `submission/${slug}-skill.zip`;
  return [
    {
      role: 'documentation',
      path: 'submission/README.md',
      content: submissionReadme(input, skillArchivePath, slug),
    },
    {
      role: 'skill',
      path: skillArchivePath,
      content: renderSkillArchive(markdown, slug),
    },
    {
      role: 'test',
      path: 'submission/chatgpt-app-submission.json',
      content: json(chatGptSubmission(input, options.category)),
    },
  ];
}

function chatGptSubmission(input: HostPackageAdapterInput, category: string): ChatGptAppSubmission {
  const positive = input.distribution.review.scenarios
    .filter((scenario) => scenario.shouldInvoke)
    .slice(0, 5);
  const negative = input.distribution.review.scenarios
    .filter((scenario) => !scenario.shouldInvoke)
    .slice(0, 3);
  const submissionCategory = submissionCategoryFor(category);
  return {
    $schema: OPENAI_SUBMISSION_SCHEMA,
    schema_version: 1,
    app_info: {
      display_name: input.appPackage.app.title,
      subtitle: input.distribution.listing.summary,
      description: input.distribution.listing.description,
      ...(submissionCategory === undefined ? {} : { category: submissionCategory }),
    },
    tools: Object.fromEntries(
      [...input.appPackage.surface.tools]
        .sort((left, right) => compare(left.name, right.name))
        .map((tool) => [tool.name, submissionTool(tool)]),
    ),
    test_cases: positive.map(reviewCase),
    negative_test_cases: negative.map(reviewCase),
  };
}

function submissionTool(tool: ProductSkillTool): SubmissionTool {
  return {
    annotations: {
      readOnlyHint: tool.behavior.readOnly,
      openWorldHint: tool.behavior.openWorld,
      destructiveHint: tool.behavior.destructive,
    },
    justifications: {
      read_only_justification: tool.behavior.readOnly
        ? `${tool.name} only reads or computes information and does not change state.`
        : `${tool.name} can change application state through its documented operation.`,
      open_world_justification: tool.behavior.openWorld
        ? `${tool.name} can affect systems outside the private application boundary.`
        : `${tool.name} does not publish content or change public internet state.`,
      destructive_justification: tool.behavior.destructive
        ? `${tool.name} can cause an irreversible or difficult-to-reverse side effect.`
        : `${tool.name} does not delete, overwrite, revoke access, or cause another irreversible side effect.`,
    },
  };
}

function reviewCase(
  scenario: HostPackageAdapterInput['distribution']['review']['scenarios'][number],
): SubmissionTestCase {
  return {
    description: `${humanize(scenario.id)}.`,
    user_prompt: scenario.prompt,
    file_attachment_urls: null,
    tools_triggered: scenario.shouldInvoke ? (scenario.tools ?? []).join(', ') : null,
    expected_output: scenario.expected,
    expected_output_url: null,
  };
}

function renderSkillArchive(markdown: ProductSkillMarkdown, slug: string): Uint8Array {
  return deterministicZip([
    renderedSkillFile(`${slug}/SKILL.md`, markdown.skill),
    renderedSkillFile(`${slug}/references/mcp-surface.md`, markdown.reference),
  ]);
}

function renderedSkillFile(path: string, content: string): RenderedHostPackageFile {
  const bytes = new TextEncoder().encode(content);
  return {
    role: 'skill',
    path,
    content: bytes,
    sha256: sha256(bytes),
    byteLength: bytes.byteLength,
  };
}

function submissionReadme(
  input: HostPackageAdapterInput,
  skillArchivePath: string,
  skillRoot: string,
): string {
  const skillArchiveName = skillArchivePath.slice('submission/'.length);
  return `# OpenAI submission uploads

This outer export ZIP is a review kit. Extract it before using the OpenAI Platform submission form.

1. Upload \`chatgpt-app-submission.json\` to the Codex-assisted submission import field.
2. Upload \`${skillArchiveName}\` to the **With MCP → Skills** field.
3. Enter the production MCP URL: \`${input.mcpServer.url}\`.
4. Review every imported value, complete portal-only identity and policy fields, and submit manually.

Do not upload the outer export ZIP to the Skills field. It contains the plugin reference package, branding, and these separate upload artifacts, so it is not one skill root.

The skill ZIP contains exactly one named skill root: \`${skillRoot}/SKILL.md\` plus \`${skillRoot}/references/mcp-surface.md\`. Credentials, domain-verification tokens, submission IDs, and policy attestations are intentionally not generated.
`;
}

function submissionCategoryFor(value: string): OpenAiSubmissionCategory | undefined {
  return OPENAI_SUBMISSION_CATEGORIES[value];
}

const OPENAI_SUBMISSION_CATEGORIES: Readonly<Record<string, OpenAiSubmissionCategory>> = {
  Business: 'BUSINESS',
  'Business & Operations': 'BUSINESS',
  Collaboration: 'COLLABORATION',
  Communication: 'COLLABORATION',
  Creativity: 'DESIGN',
  Design: 'DESIGN',
  'Developer Tools': 'DEVELOPER_TOOLS',
  Education: 'EDUCATION',
  'Education & Research': 'EDUCATION',
  Entertainment: 'ENTERTAINMENT',
  Finance: 'FINANCE',
  Food: 'FOOD',
  'Food & Drink': 'FOOD',
  Lifestyle: 'LIFESTYLE',
  News: 'NEWS',
  Productivity: 'PRODUCTIVITY',
  Shopping: 'SHOPPING',
  Travel: 'TRAVEL',
};

function humanize(value: string): string {
  const words = value.replace(/[_-]+/g, ' ');
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
