import type { AppPackageArtifactV1, AppPackageTool } from '@noodle-borg/app-package';
import type { ArtifactTool, RuntimeArtifact } from '@noodle-borg/compiler';
import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_GUIDE_MAX_BYTES,
  projectAssistantGuide,
  selectAssistantModelTools,
} from '../src/index.js';

const behavior = {
  readOnly: true,
  destructive: false,
  idempotent: true,
  openWorld: false,
  confirmationRequired: false,
} as const;

function artifactTool(
  name: string,
  options: {
    readonly roles?: readonly string[];
    readonly scopes?: readonly string[];
    readonly visibility?: readonly ('model' | 'app')[];
    readonly latestMessageIncludesAny?: unknown;
    readonly oncePerSession?: unknown;
    readonly requiredWhenVisible?: unknown;
  } = {},
): ArtifactTool {
  return {
    name,
    description: `${name} description that belongs in the model tool schema, not the guide.`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    fulfilment: { kind: 'flow', steps: [], output: {} },
    annotations: {
      readOnlyHint: true,
      ...(options.latestMessageIncludesAny === undefined
        ? {}
        : {
            'x-noodleseed-model-latest-message-includes-any': options.latestMessageIncludesAny,
          }),
      ...(options.oncePerSession === undefined
        ? {}
        : { 'x-noodleseed-model-once-per-session': options.oncePerSession }),
      ...(options.requiredWhenVisible === undefined
        ? {}
        : { 'x-noodleseed-model-required-when-visible': options.requiredWhenVisible }),
    },
    ...(options.roles === undefined && options.scopes === undefined
      ? {}
      : {
          authorization: {
            ...(options.roles === undefined ? {} : { allowedRoles: options.roles }),
            ...(options.scopes === undefined ? {} : { requiredScopes: options.scopes }),
          },
        }),
    ...(options.visibility === undefined
      ? {}
      : { _meta: { ui: { visibility: options.visibility } } }),
  } as ArtifactTool;
}

function packageTool(tool: ArtifactTool): AppPackageTool {
  return {
    kind: 'tool',
    name: tool.name,
    description: tool.description,
    input: { type: 'object' },
    behavior,
    visibility: tool._meta?.ui?.visibility ?? ['model', 'app'],
    ...(tool.authorization === undefined ? {} : { authorization: tool.authorization }),
  };
}

const LIST = artifactTool('list_cases', {
  roles: ['support_agent', 'support_admin'],
  scopes: ['cases:read'],
});
const CLOSE = artifactTool('close_case', {
  roles: ['support_admin'],
  scopes: ['cases:write'],
});
const WIDGET_ONLY = artifactTool('widget_only_settings', { visibility: ['app'] });

function appPackage(overrides: Partial<AppPackageArtifactV1> = {}): AppPackageArtifactV1 {
  return {
    schemaVersion: '1',
    app: { name: 'acme_support', title: 'Acme Support', version: '1.0.0' },
    skill: {
      description: 'Use Acme Support to investigate and resolve customer cases.',
      useWhen: ['A customer asks about an existing support case.'],
      workflows: [
        {
          id: 'review_cases',
          title: 'Review cases',
          intent: 'Ground the answer in the customer case record.',
          steps: [
            {
              capability: { kind: 'tool', name: 'list_cases' },
              guidance: 'Read the current cases before answering.',
              behavior,
            },
          ],
        },
        {
          id: 'close_case',
          title: 'Close a case',
          steps: [
            { capability: { kind: 'tool', name: 'list_cases' }, behavior },
            {
              capability: { kind: 'tool', name: 'close_case' },
              guidance: 'Close only the case the user selected.',
              behavior: { ...behavior, readOnly: false, confirmationRequired: true },
            },
          ],
        },
        {
          id: 'widget_settings',
          title: 'Change widget settings',
          steps: [{ capability: { kind: 'tool', name: 'widget_only_settings' }, behavior }],
        },
        {
          id: 'read_runbook',
          title: 'Read the runbook',
          steps: [{ capability: { kind: 'resource', name: 'support_runbook' } }],
        },
      ],
      boundaries: ['Never claim a case was changed until the write succeeds.'],
      examples: [
        { prompt: 'Which cases are still open?', workflow: 'review_cases' },
        { prompt: 'Close case 42.', workflow: 'close_case' },
        { prompt: 'Open the support runbook.', workflow: 'read_runbook' },
      ],
    },
    surface: {
      auth: { required: true, kind: 'oidc' },
      tools: [LIST, CLOSE, WIDGET_ONLY].map(packageTool),
      resources: [
        {
          kind: 'resource',
          name: 'support_runbook',
          uri: 'docs://support/runbook',
          description: 'Support runbook.',
        },
      ],
      prompts: [],
      widgets: [],
    },
    provenance: {
      sourceManifestSha256: 'a'.repeat(64),
      mcpSurfaceSha256: 'b'.repeat(64),
      compilerVersion: '1',
    },
    ...overrides,
  };
}

const runtimeArtifact = (tools: readonly ArtifactTool[]): RuntimeArtifact =>
  ({
    artifactSchemaVersion: '0.15.0',
    resolution: 'resolved',
    source: { manifestName: 'acme_support', manifestVersion: '2', coreVersion: '2' },
    server: { name: 'acme_support', title: 'Acme Support', version: '1.0.0' },
    capabilities: { tools: [] },
    tools,
  }) as RuntimeArtifact;

describe('embedded assistant model tools', () => {
  it('uses the same roles, scopes, and model visibility for the guide and model tool list', () => {
    const artifact = runtimeArtifact([LIST, CLOSE, WIDGET_ONLY]);
    const member = selectAssistantModelTools(artifact, {
      subject: 'member',
      identityKind: 'customer',
      roles: ['support_agent'],
      scopes: ['cases:read'],
    });
    const admin = selectAssistantModelTools(artifact, {
      subject: 'admin',
      identityKind: 'customer',
      roles: ['support_admin'],
      scopes: ['cases:read', 'cases:write'],
    });

    expect(member.map((tool) => tool.name)).toEqual(['list_cases']);
    expect(admin.map((tool) => tool.name)).toEqual(['list_cases', 'close_case']);
  });

  it('projects a public surface before applying anonymous or mixed sign-in behavior', () => {
    const artifact = runtimeArtifact([LIST, CLOSE, WIDGET_ONLY]);
    const anonymous = { subject: 'anon', identityKind: 'anonymous' as const };

    expect(selectAssistantModelTools(artifact, anonymous).map((tool) => tool.name)).toEqual([]);
    expect(
      selectAssistantModelTools(artifact, anonymous, {
        anonymousSignInOfferSurface: [{ kind: 'tool', name: 'list_cases' }],
      }).map((tool) => tool.name),
    ).toEqual(['list_cases']);
    expect(
      selectAssistantModelTools(artifact, anonymous, {
        anonymousSignInOfferSurface: [],
      }).map((tool) => tool.name),
    ).toEqual([]);
  });

  it('exposes a constrained model tool only for a matching latest user message', () => {
    const contact = artifactTool('open_contact_form', {
      latestMessageIncludesAny: [
        'contact noodle seed',
        'talk to noodle seed',
        'open the private brief',
      ],
    });
    const artifact = runtimeArtifact([contact]);
    const caller = { subject: 'anon', identityKind: 'anonymous' as const };

    expect(
      selectAssistantModelTools(artifact, caller, {
        latestMessage: 'What is a safe first pilot workflow that avoids PHI?',
      }),
    ).toEqual([]);
    expect(
      selectAssistantModelTools(artifact, caller, {
        latestMessage: 'Please, TALK—to Noodle Seed about this.',
      }).map((tool) => tool.name),
    ).toEqual(['open_contact_form']);
  });

  /**
   * Why a gated tool needs several phrasings rather than one.
   *
   * A phrase matches only as a contiguous run of whole tokens, so "talk to noodle seed" does not
   * cover "talk to someone at Noodle Seed" — the words the visitor put in between break the run.
   * A production visitor hit exactly that and got silence. The list is the coverage; this is the
   * mechanism that makes each entry narrow enough to add safely.
   */
  it('matches a phrase only as a contiguous run of whole tokens', () => {
    const artifact = runtimeArtifact([
      artifactTool('open_contact_form', {
        latestMessageIncludesAny: ['talk to noodle seed', 'talk to someone', 'contact you'],
      }),
    ]);
    const caller = { subject: 'anon', identityKind: 'anonymous' as const };
    const admits = (latestMessage: string) =>
      selectAssistantModelTools(artifact, caller, { latestMessage }).length === 1;

    // Words in between break the run, which is why the narrower phrase has to be listed too.
    expect(admits('I would like to talk to someone at Noodle Seed about this.')).toBe(true);
    expect(admits('Can I talk to your solutions people at Noodle Seed?')).toBe(false);
    // Token boundaries, not substrings: "contact your customers" never satisfies "contact you".
    expect(admits('How do you contact your customers?')).toBe(false);
    expect(admits('How can I contact you?')).toBe(true);
  });

  it('fails closed when a latest-message model visibility annotation is malformed', () => {
    const contact = artifactTool('open_contact_form', {
      latestMessageIncludesAny: ['contact noodle seed', 42],
    });

    expect(
      selectAssistantModelTools(runtimeArtifact([contact]), undefined, {
        latestMessage: 'contact noodle seed',
      }),
    ).toEqual([]);
  });

  it('hides a once-per-session tool after the session records its use', () => {
    const card = artifactTool('show_product_path', {
      latestMessageIncludesAny: ['show me a widget'],
      oncePerSession: true,
      requiredWhenVisible: true,
    });
    const artifact = runtimeArtifact([card]);
    const caller = { subject: 'anon', identityKind: 'anonymous' as const };

    expect(
      selectAssistantModelTools(artifact, caller, {
        latestMessage: 'Please show me a widget.',
        usedToolNames: [],
      }).map((tool) => tool.name),
    ).toEqual(['show_product_path']);
    expect(
      selectAssistantModelTools(artifact, caller, {
        latestMessage: 'Please show me a widget again.',
        usedToolNames: ['show_product_path'],
      }),
    ).toEqual([]);
  });

  it.each([
    ['x-noodleseed-model-once-per-session', 'yes'],
    ['x-noodleseed-model-required-when-visible', 1],
  ])('fails closed when %s is malformed', (annotation, value) => {
    const card = artifactTool('show_product_path');
    const malformed = {
      ...card,
      annotations: { ...card.annotations, [annotation]: value },
    } as ArtifactTool;

    expect(
      selectAssistantModelTools(runtimeArtifact([malformed]), undefined, {
        latestMessage: 'show me a widget',
      }),
    ).toEqual([]);
  });
});

describe('embedded assistant product-guide projection', () => {
  it('retains only complete workflows supported by the exact model tool set', () => {
    const result = projectAssistantGuide({ appPackage: appPackage(), modelTools: [LIST] });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;

    expect(result.guide.workflowIds).toEqual(['review_cases']);
    expect(result.guide.content).toContain('Review cases');
    expect(result.guide.content).toContain('Read the current cases before answering.');
    expect(result.guide.content).not.toContain('Close a case');
    expect(result.guide.content).not.toContain('Change widget settings');
    expect(result.guide.content).not.toContain('Read the runbook');
    expect(result.guide.content).not.toContain('Close case 42.');
    expect(result.guide.content).not.toContain('| Tool |');
    expect(result.guide.content).not.toContain(LIST.description);
    expect(result.guide.byteLength).toBeLessThanOrEqual(ASSISTANT_GUIDE_MAX_BYTES);
    expect(projectAssistantGuide({ appPackage: appPackage(), modelTools: [LIST] })).toEqual(result);
  });

  it('adds write and confirmation facts for a fully authorized workflow', () => {
    const result = projectAssistantGuide({ appPackage: appPackage(), modelTools: [LIST, CLOSE] });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;

    expect(result.guide.workflowIds).toEqual(['review_cases', 'close_case']);
    expect(result.guide.content).toContain('Close a case');
    expect(result.guide.content).toContain('write; confirmation required');
    expect(result.guide.content).toContain('“Close case 42.”');
  });

  it('filters a customer-shaped surface with more than twenty permission-gated tools', () => {
    const tools = Array.from({ length: 24 }, (_, index) =>
      artifactTool(`capability_${index + 1}`, {
        roles: index % 2 === 0 ? ['member'] : ['admin'],
        scopes: [`capability:${index + 1}`],
      }),
    );
    const packageValue = appPackage({
      skill: {
        ...appPackage().skill,
        workflows: tools.map((tool, index) => ({
          id: `workflow_${index + 1}`,
          title: `Workflow ${index + 1}`,
          steps: [{ capability: { kind: 'tool' as const, name: tool.name }, behavior }],
        })),
        examples: [],
      },
      surface: { ...appPackage().surface, tools: tools.map(packageTool) },
    });
    const modelTools = selectAssistantModelTools(runtimeArtifact(tools), {
      subject: 'member',
      identityKind: 'customer',
      roles: ['member'],
      scopes: Array.from({ length: 12 }, (_, index) => `capability:${index * 2 + 1}`),
    });
    const result = projectAssistantGuide({ appPackage: packageValue, modelTools });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;

    expect(result.guide.workflowIds).toHaveLength(12);
    expect(result.guide.workflowIds).toContain('workflow_1');
    expect(result.guide.workflowIds).not.toContain('workflow_2');
    expect(result.guide.content).not.toContain('"capability_2"');
  });

  it('fails soft for absent, malformed, empty, and oversize projections', () => {
    expect(projectAssistantGuide({ appPackage: undefined, modelTools: [LIST] })).toEqual({
      status: 'unavailable',
      reason: 'package_unavailable',
    });
    expect(
      projectAssistantGuide({ appPackage: { schemaVersion: 'unsafe' }, modelTools: [LIST] }),
    ).toEqual({
      status: 'unavailable',
      reason: 'package_unavailable',
    });
    expect(projectAssistantGuide({ appPackage: appPackage(), modelTools: [] })).toEqual({
      status: 'unavailable',
      reason: 'no_complete_workflow',
    });

    const oversized = appPackage({
      skill: {
        ...appPackage().skill,
        boundaries: Array.from({ length: 5 }, (_, index) => `${index}-${'x'.repeat(3_990)}`),
      },
    });
    expect(projectAssistantGuide({ appPackage: oversized, modelTools: [LIST] })).toEqual({
      status: 'unavailable',
      reason: 'context_too_large',
    });
  });
});
