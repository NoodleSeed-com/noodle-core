import { describe, expect, it } from 'vitest';
import { type AppPackageArtifactV1, projectAppPackageCapabilities } from '../src/index.js';

const behavior = {
  readOnly: true,
  destructive: false,
  idempotent: true,
  openWorld: false,
  confirmationRequired: false,
} as const;

const artifact: AppPackageArtifactV1 = {
  schemaVersion: '1',
  app: { name: 'acme_support', title: 'Acme Support', version: '1.0.0' },
  skill: {
    description: 'Investigate and resolve customer cases.',
    useWhen: ['A customer needs help with a support case.'],
    workflows: [
      {
        id: 'review_cases',
        title: 'Review cases',
        steps: [{ capability: { kind: 'tool', name: 'list_cases' } }],
      },
      {
        id: 'close_case',
        title: 'Close a case',
        steps: [
          { capability: { kind: 'tool', name: 'list_cases' } },
          { capability: { kind: 'tool', name: 'close_case' } },
        ],
      },
      {
        id: 'read_runbook',
        title: 'Read the runbook',
        steps: [{ capability: { kind: 'resource', name: 'support_runbook' } }],
      },
      {
        id: 'draft_reply',
        title: 'Draft a reply',
        steps: [{ capability: { kind: 'prompt', name: 'support_reply' } }],
      },
      {
        id: 'refresh_widget',
        title: 'Refresh the widget',
        steps: [{ capability: { kind: 'tool', name: 'widget_refresh' } }],
      },
    ],
    boundaries: ['Never claim a write succeeded before the tool returns.'],
    examples: [
      { prompt: 'Which cases are open?', workflow: 'review_cases' },
      { prompt: 'Close case 42.', workflow: 'close_case' },
      { prompt: 'Read the runbook.', workflow: 'read_runbook' },
      { prompt: 'Draft a response.', workflow: 'draft_reply' },
      { prompt: 'Refresh the UI.', workflow: 'refresh_widget' },
    ],
  },
  surface: {
    auth: { required: true, kind: 'oidc' },
    tools: [
      {
        kind: 'tool',
        name: 'list_cases',
        description: 'List support cases.',
        input: { type: 'object' },
        behavior,
        visibility: ['model', 'app'],
      },
      {
        kind: 'tool',
        name: 'close_case',
        description: 'Close a support case.',
        input: { type: 'object' },
        behavior: { ...behavior, readOnly: false, confirmationRequired: true },
        visibility: ['model', 'app'],
      },
      {
        kind: 'tool',
        name: 'widget_refresh',
        description: 'Refresh widget state.',
        input: { type: 'object' },
        behavior,
        visibility: ['app'],
      },
    ],
    resources: [
      {
        kind: 'resource',
        name: 'support_runbook',
        uri: 'docs://support/runbook',
        description: 'Support runbook.',
      },
    ],
    prompts: [
      {
        kind: 'prompt',
        name: 'support_reply',
        description: 'Draft a support response.',
        arguments: [],
      },
    ],
    widgets: [
      {
        kind: 'widget',
        name: 'case_panel',
        description: 'Case panel.',
        tool: 'list_cases',
      },
      {
        kind: 'widget',
        name: 'refresh_panel',
        description: 'Refresh panel.',
        tool: 'widget_refresh',
      },
    ],
  },
  provenance: {
    sourceManifestSha256: 'a'.repeat(64),
    mcpSurfaceSha256: 'b'.repeat(64),
    compilerVersion: '1',
  },
};

describe('App Package capability projection', () => {
  it('retains only complete workflows, their examples, and the selected surface', () => {
    const projected = projectAppPackageCapabilities(artifact, {
      tools: ['list_cases'],
      resources: ['support_runbook'],
      prompts: [],
    });

    expect(projected?.skill.workflows.map((workflow) => workflow.id)).toEqual([
      'review_cases',
      'read_runbook',
    ]);
    expect(projected?.skill.examples.map((example) => example.workflow)).toEqual([
      'review_cases',
      'read_runbook',
    ]);
    expect(projected?.surface.tools.map((tool) => tool.name)).toEqual(['list_cases']);
    expect(projected?.surface.resources.map((resource) => resource.name)).toEqual([
      'support_runbook',
    ]);
    expect(projected?.surface.prompts).toEqual([]);
    expect(projected?.surface.widgets.map((widget) => widget.name)).toEqual(['case_panel']);
    expect(artifact.skill.workflows).toHaveLength(5);
  });

  it('returns no projection when the caller has no complete workflow', () => {
    expect(
      projectAppPackageCapabilities(artifact, { tools: [], resources: [], prompts: [] }),
    ).toBeUndefined();
  });
});
