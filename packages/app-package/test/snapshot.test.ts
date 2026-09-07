import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type AppPackageArtifactV1,
  createAppPackageSnapshotV1,
  parseAppPackageSnapshotV1,
  sha256Canonical,
} from '../src/index.js';

const digest = 'a'.repeat(64);
const ARTIFACT: AppPackageArtifactV1 = {
  schemaVersion: '1',
  app: { name: 'acme_tasks', title: 'Acme Tasks', version: '1.0.0' },
  skill: {
    description: 'Use Acme Tasks.',
    useWhen: ['A task needs review.'],
    workflows: [
      {
        id: 'review_tasks',
        title: 'Review tasks',
        steps: [{ capability: { kind: 'tool', name: 'list_tasks' } }],
      },
    ],
    boundaries: ['Do not invent task IDs.'],
    examples: [{ prompt: 'Review today’s tasks.', workflow: 'review_tasks' }],
  },
  surface: {
    auth: { required: false },
    tools: [
      {
        kind: 'tool',
        name: 'list_tasks',
        description: 'List tasks.',
        input: { type: 'object', fields: [] },
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
    sourceManifestSha256: digest,
    mcpSurfaceSha256: digest,
    compilerVersion: '1',
  },
};

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function renderedBundle() {
  const paths = [
    ['codex', '.agents/skills/acme-tasks/SKILL.md'],
    ['codex', '.agents/skills/acme-tasks/references/mcp-surface.md'],
    ['claude-code', '.claude/skills/acme-tasks/SKILL.md'],
    ['claude-code', '.claude/skills/acme-tasks/references/mcp-surface.md'],
  ] as const;
  const files = paths.map(([target, path], index) => {
    const content = `file ${index}\n`;
    return { target, path, content, sha256: sha256(content), byteLength: content.length };
  });
  return {
    schemaVersion: 1 as const,
    rendererVersion: '1.0.0',
    files,
    bundleSha256: sha256Canonical({
      sourceManifestSha256: ARTIFACT.provenance.sourceManifestSha256,
      mcpSurfaceSha256: ARTIFACT.provenance.mcpSurfaceSha256,
      files: files.map(({ target, path, sha256: fileSha256 }) => ({
        target,
        path,
        sha256: fileSha256,
      })),
    }),
  };
}

function withSnapshotHash<
  T extends { artifact: unknown; rendererVersion: string; files: readonly unknown[] },
>(snapshot: T) {
  return {
    ...snapshot,
    snapshotSha256: sha256Canonical({
      artifact: snapshot.artifact,
      rendererVersion: snapshot.rendererVersion,
      files: snapshot.files.map((file) => {
        const metadata = file as {
          target: string;
          path: string;
          sha256: string;
          byteLength: number;
        };
        return {
          target: metadata.target,
          path: metadata.path,
          sha256: metadata.sha256,
          byteLength: metadata.byteLength,
        };
      }),
    }),
  };
}

describe('App Package V1 snapshot contract', () => {
  it('creates and parses one deeply immutable snapshot', () => {
    const snapshot = createAppPackageSnapshotV1(ARTIFACT, () => renderedBundle());

    expect(parseAppPackageSnapshotV1(snapshot)).toEqual(snapshot);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.artifact.skill.workflows[0]?.steps)).toBe(true);
    expect(Object.isFrozen(snapshot.files[0])).toBe(true);
  });

  it('rejects a rendered bundle not bound to the artifact and file hashes', () => {
    const bundle = renderedBundle();
    expect(() =>
      createAppPackageSnapshotV1(ARTIFACT, () => ({
        ...bundle,
        bundleSha256: 'f'.repeat(64),
      })),
    ).toThrow();
  });

  it.each([
    [
      'content hash',
      (file: ReturnType<typeof renderedBundle>['files'][number]) => ({
        ...file,
        content: 'tampered\n',
      }),
    ],
    [
      'byte length',
      (file: ReturnType<typeof renderedBundle>['files'][number]) => ({
        ...file,
        byteLength: file.byteLength + 1,
      }),
    ],
  ])('rejects persisted file %s tampering even with a recomputed snapshot hash', (_name, mutate) => {
    const snapshot = createAppPackageSnapshotV1(ARTIFACT, () => renderedBundle());
    const tampered = withSnapshotHash({
      ...snapshot,
      files: snapshot.files.map((file, index) => (index === 0 ? mutate(file) : file)),
    });

    expect(parseAppPackageSnapshotV1(tampered)).toBeUndefined();
  });

  it('requires the caller-supplied host-file validator on persisted reads', () => {
    const snapshot = createAppPackageSnapshotV1(ARTIFACT, () => renderedBundle());
    const unsafe = withSnapshotHash({
      ...snapshot,
      files: snapshot.files.map((file, index) =>
        index === 0 ? { ...file, path: 'SKILL.md' } : file,
      ),
    });
    const validateFiles = (_artifact: AppPackageArtifactV1, files: typeof snapshot.files) => {
      if (files.some((file) => !file.path.startsWith('.'))) throw new Error('unsafe path');
    };

    expect(parseAppPackageSnapshotV1(unsafe)).toBeDefined();
    expect(parseAppPackageSnapshotV1(unsafe, validateFiles)).toBeUndefined();
  });
});
