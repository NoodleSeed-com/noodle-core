import { createHash } from 'node:crypto';
import { ProtocolError, type Server } from '@modelcontextprotocol/server';
import { parseAppPackageSnapshotV1, projectAppPackageCapabilities } from '@noodle-borg/app-package';
import type { RuntimeArtifact } from '@noodle-borg/compiler';
import { renderProductSkillMarkdown } from '@noodle-borg/plugin-distribution';
import { z } from 'zod';
import { filterAuthorizedTools, type ToolAuthorizationCaller } from '../tool-authorization.js';

const SKILL_EXTENSION_ID = 'io.modelcontextprotocol/skills';
const SKILL_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const metaSchema = z.record(z.string(), z.unknown()).optional();
const skillResourceSchema = z
  .object({
    uri: z.string(),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
const skillEntrySchema = z
  .object({
    uri: z.string(),
    frontmatter: z.object({ name: z.string(), description: z.string() }).strict(),
    resources: z.array(skillResourceSchema),
  })
  .strict();
const skillsListParamsSchema = z
  .object({ cursor: z.string().optional(), _meta: metaSchema })
  .strict();
const skillsListResultSchema = z
  .object({
    skills: z.array(skillEntrySchema),
    ttlMs: z.literal(0),
    cacheScope: z.literal('private'),
  })
  .strict();
const skillsGetParamsSchema = z.object({ uri: z.string(), _meta: metaSchema }).strict();
const skillsGetResultSchema = z.object({ skill: skillEntrySchema }).strict();

interface McpSkillEntry {
  readonly uri: string;
  readonly frontmatter: { readonly name: string; readonly description: string };
  readonly resources: { readonly uri: string; readonly digest: string }[];
}

interface McpSkillResource {
  readonly uri: string;
  readonly mimeType: 'text/markdown';
  readonly text: string;
}

export interface McpSkillProjection {
  readonly extension: { readonly [SKILL_EXTENSION_ID]: Record<string, never> };
  readonly entry: McpSkillEntry;
  readonly resource: (uri: string) => McpSkillResource | undefined;
}

/** Project one immutable deployment package into the caller's minimal SEP-2640 draft surface. */
export function projectMcpSkill(
  snapshotValue: unknown,
  artifact: RuntimeArtifact,
  caller: ToolAuthorizationCaller | undefined,
): McpSkillProjection | undefined {
  const snapshot = parseAppPackageSnapshotV1(snapshotValue);
  if (snapshot === undefined) return undefined;
  const codexSkill = snapshot.files.find(
    (file) => file.target === 'codex' && file.path.endsWith('/SKILL.md'),
  );
  const match = /^\.agents\/skills\/([^/]+)\/SKILL\.md$/.exec(codexSkill?.path ?? '');
  const slug = match?.[1];
  if (codexSkill === undefined || slug === undefined || !SKILL_SLUG.test(slug)) return undefined;

  const expectedPaths = new Set([
    `codex\0.agents/skills/${slug}/SKILL.md`,
    `codex\0.agents/skills/${slug}/references/mcp-surface.md`,
    `claude-code\0.claude/skills/${slug}/SKILL.md`,
    `claude-code\0.claude/skills/${slug}/references/mcp-surface.md`,
  ]);
  if (
    snapshot.files.length !== expectedPaths.size ||
    snapshot.files.some((file) => !expectedPaths.delete(`${file.target}\0${file.path}`)) ||
    expectedPaths.size !== 0
  ) {
    return undefined;
  }

  const codexReference = snapshot.files.find(
    (file) =>
      file.target === 'codex' && file.path === `.agents/skills/${slug}/references/mcp-surface.md`,
  );
  const claudeSkill = snapshot.files.find(
    (file) => file.target === 'claude-code' && file.path.endsWith(`/${slug}/SKILL.md`),
  );
  const claudeReference = snapshot.files.find(
    (file) =>
      file.target === 'claude-code' &&
      file.path === `.claude/skills/${slug}/references/mcp-surface.md`,
  );
  const frontmatter = parseGeneratedFrontmatter(codexSkill.content);
  if (
    codexReference === undefined ||
    claudeSkill?.content !== codexSkill.content ||
    claudeReference?.content !== codexReference.content ||
    frontmatter?.name !== slug ||
    frontmatter.description !== normalizeProse(snapshot.artifact.skill.description)
  ) {
    return undefined;
  }

  const projected = projectAppPackageCapabilities(snapshot.artifact, {
    tools: filterAuthorizedTools(artifact.tools, caller)
      .filter((tool) => tool._meta?.ui?.visibility?.includes('model') !== false)
      .map((tool) => tool.name),
    resources: (artifact.resources ?? []).map((resource) => resource.name),
    prompts: (artifact.prompts ?? []).map((prompt) => prompt.name),
  });
  if (projected === undefined) return undefined;

  let markdown: ReturnType<typeof renderProductSkillMarkdown>;
  try {
    markdown = renderProductSkillMarkdown(projected);
  } catch {
    return undefined;
  }
  const projectedFrontmatter = parseGeneratedFrontmatter(markdown.skill);
  if (
    projectedFrontmatter?.name !== slug ||
    projectedFrontmatter.description !== normalizeProse(projected.skill.description)
  ) {
    return undefined;
  }

  const skillUri = `skill://${slug}/SKILL.md`;
  const referenceUri = `skill://${slug}/references/mcp-surface.md`;
  const resources = [
    mcpResource(skillUri, markdown.skill, sha256(markdown.skill)),
    mcpResource(referenceUri, markdown.reference, sha256(markdown.reference)),
  ] as const;
  const entry: McpSkillEntry = {
    uri: skillUri,
    frontmatter: projectedFrontmatter,
    resources: resources.map(({ uri, digest }) => ({ uri, digest })),
  };
  const byUri = new Map(resources.map((resource) => [resource.uri, resource]));
  return {
    extension: { [SKILL_EXTENSION_ID]: {} },
    entry,
    resource: (uri) => byUri.get(uri),
  };
}

export function registerMcpSkillMethods(server: Server, projection: McpSkillProjection): void {
  server.setRequestHandler(
    'skills/list',
    { params: skillsListParamsSchema, result: skillsListResultSchema },
    (params) => {
      if (params.cursor !== undefined) throw invalidParams('unknown skills cursor');
      return { skills: [projection.entry], ttlMs: 0 as const, cacheScope: 'private' as const };
    },
  );
  server.setRequestHandler(
    'skills/get',
    { params: skillsGetParamsSchema, result: skillsGetResultSchema },
    (params) => {
      if (params.uri !== projection.entry.uri) throw invalidParams('unknown skill URI');
      return { skill: projection.entry };
    },
  );
}

function mcpResource(
  uri: string,
  text: string,
  sha256: string,
): McpSkillResource & {
  readonly digest: string;
} {
  if (!SHA256.test(sha256)) throw new TypeError('invalid snapshot digest');
  return { uri, mimeType: 'text/markdown', text, digest: `sha256:${sha256}` };
}

function parseGeneratedFrontmatter(
  content: string,
): { readonly name: string; readonly description: string } | undefined {
  const match = /^---\nname: ([^\n]+)\ndescription: ([^\n]+)\n---\n/.exec(content);
  if (match === null || match[1] === undefined || match[2] === undefined) return undefined;
  const name = match[1];
  const description = parseGeneratedYamlScalar(match[2]);
  return description === undefined ? undefined : { name, description };
}

function parseGeneratedYamlScalar(value: string): string | undefined {
  if (/^[A-Za-z0-9][A-Za-z0-9 .,'!?()/-]*$/.test(value)) return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'string' && parsed.length > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function normalizeProse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function invalidParams(message: string): ProtocolError {
  return new ProtocolError(-32602, message);
}
