import { createHash } from 'node:crypto';
import {
  type AppPackageArtifactV1,
  type AppPackageRenderedFileV1,
  type AppPackageSnapshotV1,
  createAppPackageSnapshotV1,
  sha256Canonical,
} from '@noodle-borg/app-package';

export const SKILL_SLUG = 'acme-tasks';
export const SKILL_URI = `skill://${SKILL_SLUG}/SKILL.md`;
export const REFERENCE_URI = `skill://${SKILL_SLUG}/references/mcp-surface.md`;
export const SKILL_DESCRIPTION = 'Manage ACME tasks: safely and consistently.';
export const SKILL_CONTENT = `---
name: ${SKILL_SLUG}
description: ${JSON.stringify(SKILL_DESCRIPTION)}
---

# ACME Tasks

Use the task tools in the documented order.

[Read the MCP surface reference.](references/mcp-surface.md)
`;
const REFERENCE_CONTENT = `# ACME Tasks MCP surface

## Tools

- \`list_tasks\` lists the current tasks.
`;

const SKILL_ARTIFACT: AppPackageArtifactV1 = {
  schemaVersion: '1',
  app: { name: 'acme_tasks', title: 'ACME Tasks', version: '1.0.0' },
  skill: {
    description: SKILL_DESCRIPTION,
    useWhen: ['A user needs to inspect ACME tasks.'],
    workflows: [
      {
        id: 'list_tasks',
        title: 'List tasks',
        steps: [{ capability: { kind: 'tool', name: 'list_tasks' } }],
      },
    ],
    boundaries: ['Never invent task state.'],
    examples: [{ prompt: 'Show my tasks.', workflow: 'list_tasks' }],
  },
  surface: {
    auth: { required: false },
    tools: [
      {
        kind: 'tool',
        name: 'list_tasks',
        description: 'List the current tasks.',
        input: { type: 'object' },
        behavior: {
          readOnly: true,
          destructive: false,
          idempotent: true,
          openWorld: false,
          confirmationRequired: false,
        },
        visibility: ['model', 'app'],
      },
    ],
    resources: [],
    prompts: [],
    widgets: [],
  },
  provenance: {
    sourceManifestSha256: 'a'.repeat(64),
    mcpSurfaceSha256: 'b'.repeat(64),
    compilerVersion: '1',
  },
};

export function skillSnapshot(
  options: {
    readonly artifact?: AppPackageArtifactV1;
    readonly skillContent?: string;
    readonly claudeSkillContent?: string;
    readonly codexSkillPath?: string;
  } = {},
): AppPackageSnapshotV1 {
  const snapshotArtifact = options.artifact ?? SKILL_ARTIFACT;
  return createAppPackageSnapshotV1(snapshotArtifact, (input) => {
    const generatedSkillContent = `---\nname: ${SKILL_SLUG}\ndescription: ${JSON.stringify(input.skill.description)}\n---\n\n# ${input.app.title}\n`;
    const skillContent =
      options.skillContent ??
      (options.artifact === undefined ? SKILL_CONTENT : generatedSkillContent);
    const files = [
      renderedFile(
        'codex',
        options.codexSkillPath ?? `.agents/skills/${SKILL_SLUG}/SKILL.md`,
        skillContent,
      ),
      renderedFile(
        'codex',
        `.agents/skills/${SKILL_SLUG}/references/mcp-surface.md`,
        REFERENCE_CONTENT,
      ),
      renderedFile(
        'claude-code',
        `.claude/skills/${SKILL_SLUG}/SKILL.md`,
        options.claudeSkillContent ?? skillContent,
      ),
      renderedFile(
        'claude-code',
        `.claude/skills/${SKILL_SLUG}/references/mcp-surface.md`,
        REFERENCE_CONTENT,
      ),
    ] as const;
    return {
      schemaVersion: 1,
      rendererVersion: 'test-renderer-v1',
      files,
      bundleSha256: sha256Canonical({
        sourceManifestSha256: input.provenance.sourceManifestSha256,
        mcpSurfaceSha256: input.provenance.mcpSurfaceSha256,
        files: files.map(({ target, path, sha256 }) => ({ target, path, sha256 })),
      }),
    };
  });
}

function renderedFile(
  target: AppPackageRenderedFileV1['target'],
  path: string,
  content: string,
): AppPackageRenderedFileV1 {
  return {
    target,
    path,
    content,
    sha256: createHash('sha256').update(content).digest('hex'),
    byteLength: Buffer.byteLength(content, 'utf8'),
  };
}
