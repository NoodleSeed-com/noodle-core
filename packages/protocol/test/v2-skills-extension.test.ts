import { createHash } from 'node:crypto';
import type { AppPackageArtifactV1, AppPackageTool } from '@noodle-borg/app-package';
import type { ArtifactTool } from '@noodle-borg/compiler';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProtocolRequestContext, ServedArtifact } from '../src/index.js';
import {
  REFERENCE_URI,
  SKILL_CONTENT,
  SKILL_DESCRIPTION,
  SKILL_SLUG,
  SKILL_URI,
  skillSnapshot,
} from './skill-snapshot.js';
import {
  createTestDualEraHandler,
  legacyRpc,
  modernRpc,
  testServedArtifact,
} from './v2-harness.js';

const handlers: Array<ReturnType<typeof createTestDualEraHandler>> = [];

function handler(target: ServedArtifact = guidedTarget(), context: ProtocolRequestContext = {}) {
  const value = createTestDualEraHandler(target, context);
  handlers.push(value);
  return value;
}

const behavior = {
  readOnly: true,
  destructive: false,
  idempotent: true,
  openWorld: false,
  confirmationRequired: false,
} as const;

function runtimeTool(
  name: string,
  options: {
    readonly roles?: readonly string[];
    readonly scopes?: readonly string[];
    readonly visibility?: readonly ('model' | 'app')[];
  } = {},
): ArtifactTool {
  return {
    name,
    description: `${name} description.`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    fulfilment: { kind: 'flow', steps: [], output: {} },
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
  };
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

const LIST_CASES = runtimeTool('list_cases', {
  roles: ['support_agent', 'support_admin'],
  scopes: ['cases:read'],
});
const CLOSE_CASE = runtimeTool('close_case', {
  roles: ['support_admin'],
  scopes: ['cases:write'],
});
const WIDGET_REFRESH = runtimeTool('widget_refresh', { visibility: ['app'] });

const PERMISSIONED_PACKAGE: AppPackageArtifactV1 = {
  schemaVersion: '1',
  app: { name: 'acme_tasks', title: 'ACME Support', version: '1.0.0' },
  skill: {
    description: 'Investigate and resolve ACME support cases.',
    useWhen: ['A customer asks about an existing support case.'],
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
          {
            capability: { kind: 'tool', name: 'close_case' },
            behavior: { ...behavior, readOnly: false, confirmationRequired: true },
          },
        ],
      },
      {
        id: 'refresh_widget',
        title: 'Refresh the widget',
        steps: [{ capability: { kind: 'tool', name: 'widget_refresh' } }],
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
    ],
    boundaries: ['Never report a write before it succeeds.'],
    examples: [
      { prompt: 'Which cases are open?', workflow: 'review_cases' },
      { prompt: 'Close case 42.', workflow: 'close_case' },
      { prompt: 'Refresh the UI.', workflow: 'refresh_widget' },
      { prompt: 'Read the runbook.', workflow: 'read_runbook' },
      { prompt: 'Draft a response.', workflow: 'draft_reply' },
    ],
  },
  surface: {
    auth: { required: true, kind: 'oidc' },
    tools: [LIST_CASES, CLOSE_CASE, WIDGET_REFRESH].map(packageTool),
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
    widgets: [],
  },
  provenance: {
    sourceManifestSha256: 'c'.repeat(64),
    mcpSurfaceSha256: 'd'.repeat(64),
    compilerVersion: '1',
  },
};

function permissionedTarget(): ServedArtifact {
  return {
    ...testServedArtifact((artifact) => ({
      ...artifact,
      tools: [LIST_CASES, CLOSE_CASE, WIDGET_REFRESH],
      resources: [
        {
          name: 'support_runbook',
          uri: 'docs://support/runbook',
          isTemplate: false,
          description: 'Support runbook.',
          fulfilment: { kind: 'flow', steps: [], output: {} },
        },
      ],
      prompts: [
        {
          name: 'support_reply',
          description: 'Draft a support response.',
          fulfilment: { kind: 'flow', steps: [], output: {} },
        },
      ],
    })),
    appPackageSnapshot: skillSnapshot({ artifact: PERMISSIONED_PACKAGE }),
  };
}

function guidedTarget(): ServedArtifact {
  return {
    ...testServedArtifact((artifact) => ({
      ...artifact,
      tools: [...artifact.tools, runtimeTool('list_tasks')],
    })),
    appPackageSnapshot: skillSnapshot(),
  };
}

afterEach(async () => {
  await Promise.all(handlers.splice(0).map((item) => item.close()));
});

describe('draft MCP skills extension', () => {
  it('binds workflow content, the MCP reference, and digests to the verified caller', async () => {
    const target = permissionedTarget();
    const member = handler(target, {
      caller: {
        subject: 'member',
        identityKind: 'customer',
        roles: ['support_agent'],
        scopes: ['cases:read'],
      },
    });
    const admin = handler(target, {
      caller: {
        subject: 'admin',
        identityKind: 'customer',
        roles: ['support_admin'],
        scopes: ['cases:read', 'cases:write'],
      },
    });

    const memberList = await modernRpc(member, 'skills/list');
    const adminList = await modernRpc(admin, 'skills/list');
    const memberEntry = firstSkillEntry(memberList.json);
    const adminEntry = firstSkillEntry(adminList.json);
    const memberSkill = await readTextResource(member, SKILL_URI);
    const memberReference = await readTextResource(member, REFERENCE_URI);
    const adminSkill = await readTextResource(admin, SKILL_URI);
    const adminReference = await readTextResource(admin, REFERENCE_URI);

    expect(memberSkill).toContain('Review cases');
    expect(memberSkill).not.toContain('Close a case');
    expect(memberSkill).not.toContain('Refresh the widget');
    expect(memberSkill).toContain('Read the runbook');
    expect(memberSkill).toContain('Draft a reply');
    expect(memberReference).toContain('list_cases');
    expect(memberReference).not.toContain('close_case');
    expect(memberReference).not.toContain('widget_refresh');
    expect(memberReference).toContain('support_runbook');
    expect(memberReference).toContain('support_reply');

    expect(adminSkill).toContain('Review cases');
    expect(adminSkill).toContain('Close a case');
    expect(adminSkill).not.toContain('Refresh the widget');
    expect(adminSkill).toContain('Read the runbook');
    expect(adminSkill).toContain('Draft a reply');
    expect(adminReference).toContain('list_cases');
    expect(adminReference).toContain('close_case');
    expect(adminReference).not.toContain('widget_refresh');
    expect(adminReference).toContain('support_runbook');
    expect(adminReference).toContain('support_reply');

    expect(memberEntry.resources).toEqual([
      { uri: SKILL_URI, digest: digest(memberSkill) },
      { uri: REFERENCE_URI, digest: digest(memberReference) },
    ]);
    expect(adminEntry.resources).toEqual([
      { uri: SKILL_URI, digest: digest(adminSkill) },
      { uri: REFERENCE_URI, digest: digest(adminReference) },
    ]);
    expect(adminEntry.resources).not.toEqual(memberEntry.resources);
    expect((await modernRpc(member, 'skills/get', { uri: SKILL_URI })).json).toMatchObject({
      result: { skill: memberEntry },
    });
  });

  it.each([
    false,
    true,
  ])('does not advertise a skill without a complete authorized workflow (public discovery: %s)', async (publicDiscovery) => {
    const served = permissionedTarget();
    const target = handler(
      {
        ...served,
        artifact: {
          ...served.artifact,
          resources: [],
          prompts: [],
          tools: served.artifact.tools.map((tool) =>
            publicDiscovery && tool.authorization !== undefined
              ? { ...tool, authorization: { ...tool.authorization, discovery: 'public' } }
              : tool,
          ),
        },
      },
      {
        caller: {
          subject: 'viewer',
          identityKind: 'customer',
          roles: ['viewer'],
          scopes: [],
        },
      },
    );

    if (publicDiscovery)
      expect((await modernRpc(target, 'tools/list')).json).toMatchObject({
        result: {
          tools: expect.arrayContaining([expect.objectContaining({ name: 'list_cases' })]),
        },
      });
    const discovered = await modernRpc(target, 'server/discover');
    expect(JSON.stringify(discovered.json)).not.toContain('io.modelcontextprotocol/skills');
    expect(await modernRpc(target, 'skills/list')).toMatchObject({
      json: { error: { code: -32601 } },
    });
    expect(await modernRpc(target, 'resources/read', { uri: SKILL_URI })).toMatchObject({
      json: { error: { code: -32601 } },
    });
  });

  it('advertises only the bounded modern projection and lists its complete digest set', async () => {
    const target = handler();
    const discovered = await modernRpc(target, 'server/discover');
    expect(discovered.json).toMatchObject({
      result: {
        capabilities: {
          resources: {},
          extensions: { 'io.modelcontextprotocol/skills': {} },
        },
      },
    });

    const listed = await modernRpc(target, 'skills/list');
    expect(listed.status).toBe(200);
    expect(listed.json).toMatchObject({
      result: {
        resultType: 'complete',
        ttlMs: 0,
        cacheScope: 'private',
        skills: [
          {
            uri: SKILL_URI,
            frontmatter: { name: SKILL_SLUG, description: SKILL_DESCRIPTION },
            resources: [
              { uri: SKILL_URI, digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) },
              {
                uri: REFERENCE_URI,
                digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
              },
            ],
          },
        ],
      },
    });
  });

  it('gets the same entry and reads the deterministic caller projection through ordinary resources', async () => {
    const target = handler();
    const listed = await modernRpc(target, 'skills/list');
    const entry = ((listed.json.result as { skills: unknown[] }).skills ?? [])[0];

    const fetched = await modernRpc(target, 'skills/get', { uri: SKILL_URI });
    expect(fetched.status).toBe(200);
    expect((fetched.json.result as { skill: unknown }).skill).toEqual(entry);
    expect(fetched.json.result).not.toHaveProperty('ttlMs');
    expect(fetched.json.result).not.toHaveProperty('cacheScope');

    const skill = await readTextResource(target, SKILL_URI);
    const reference = await readTextResource(target, REFERENCE_URI);
    expect(skill).toContain('# ACME Tasks');
    expect(skill).toContain('### List tasks');
    expect(reference).toContain('# ACME Tasks MCP surface');
    expect(reference).toContain('list_tasks');
    expect((entry as { resources: unknown }).resources).toEqual([
      { uri: SKILL_URI, digest: digest(skill) },
      { uri: REFERENCE_URI, digest: digest(reference) },
    ]);
  });

  it('keeps authored resources working while skill discovery stays on skills/list', async () => {
    const target = handler({
      ...testServedArtifact((artifact) => ({
        ...artifact,
        tools: [...artifact.tools, runtimeTool('list_tasks')],
        resources: [
          {
            name: 'guide',
            uri: 'docs://guide',
            isTemplate: false,
            mimeType: 'text/plain',
            fulfilment: {
              kind: 'flow',
              steps: [],
              output: { value: { kind: 'literal', value: 'Runtime guide.' } },
            },
          },
        ],
      })),
      appPackageSnapshot: skillSnapshot(),
    });

    const listed = await modernRpc(target, 'resources/list');
    expect(listed.json).toMatchObject({
      result: { resources: [{ name: 'guide', uri: 'docs://guide' }] },
    });
    expect(listed.text).not.toContain(SKILL_URI);

    const authored = await modernRpc(target, 'resources/read', { uri: 'docs://guide' });
    expect(authored.json).toMatchObject({
      result: { contents: [{ uri: 'docs://guide', text: 'Runtime guide.' }] },
    });
    expect(await readTextResource(target, SKILL_URI)).toContain('### List tasks');
  });

  it('rejects unknown skills, unsupported cursors, and unlisted files without partial output', async () => {
    const target = handler();
    for (const response of [
      await modernRpc(target, 'skills/list', { cursor: 'unexpected-page' }),
      await modernRpc(target, 'skills/get', { uri: 'skill://unknown/SKILL.md' }),
      await modernRpc(target, 'skills/get', { uri: REFERENCE_URI }),
      await modernRpc(target, 'resources/read', { uri: `skill://${SKILL_SLUG}/unlisted.md` }),
    ]) {
      expect(response.json).toMatchObject({ error: { code: -32602 } });
      expect(response.json).not.toHaveProperty('result');
    }
  });

  it('fails closed for absent or malformed snapshots', async () => {
    const absent = handler(testServedArtifact());
    const absentDiscovery = await modernRpc(absent, 'server/discover');
    expect(JSON.stringify(absentDiscovery.json)).not.toContain('io.modelcontextprotocol/skills');
    expect(await modernRpc(absent, 'skills/list')).toMatchObject({
      json: { error: { code: -32601 } },
    });

    const snapshot = skillSnapshot();
    const malformed = {
      ...testServedArtifact(),
      appPackageSnapshot: { ...snapshot, snapshotSha256: 'f'.repeat(64) },
    } as ServedArtifact;
    const malformedDiscovery = await modernRpc(handler(malformed), 'server/discover');
    expect(JSON.stringify(malformedDiscovery.json)).not.toContain('io.modelcontextprotocol/skills');

    const wrongFrontmatter = SKILL_CONTENT.replace(SKILL_DESCRIPTION, 'Unbound instructions.');
    for (const invalidSnapshot of [
      skillSnapshot({ skillContent: wrongFrontmatter }),
      skillSnapshot({
        codexSkillPath: `.agents/skills/${SKILL_SLUG}/nested/SKILL.md`,
      }),
      skillSnapshot({ claudeSkillContent: `${SKILL_CONTENT}\nClaude-only drift.\n` }),
    ]) {
      const response = await modernRpc(
        handler({ ...testServedArtifact(), appPackageSnapshot: invalidSnapshot }),
        'server/discover',
      );
      expect(JSON.stringify(response.json)).not.toContain('io.modelcontextprotocol/skills');
    }
  });

  it('does not change legacy capabilities, resources, or method availability', async () => {
    const baseline = handler(testServedArtifact());
    const guided = handler();
    const params = {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'legacy-test', version: '1.0.0' },
    };
    const baselineInitialize = await legacyRpc(baseline, 'initialize', params);
    const guidedInitialize = await legacyRpc(guided, 'initialize', params);
    expect(guidedInitialize.text).toBe(baselineInitialize.text);

    const baselineResources = await legacyRpc(baseline, 'resources/list', {});
    const guidedResources = await legacyRpc(guided, 'resources/list', {});
    expect(guidedResources.text).toBe(baselineResources.text);
    expect(await legacyRpc(guided, 'skills/list', {})).toMatchObject({
      json: { error: { code: -32601 } },
    });
    expect(await legacyRpc(guided, 'skills/get', { uri: SKILL_URI })).toMatchObject({
      json: { error: { code: -32601 } },
    });
  });
});

function digest(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function firstSkillEntry(json: Record<string, unknown>): {
  readonly resources: readonly { readonly uri: string; readonly digest: string }[];
} {
  const result = json.result as { readonly skills?: readonly unknown[] } | undefined;
  const entry = result?.skills?.[0] as
    | { readonly resources?: readonly { readonly uri: string; readonly digest: string }[] }
    | undefined;
  if (entry?.resources === undefined) throw new Error('expected one skill entry');
  return { resources: entry.resources };
}

async function readTextResource(
  target: ReturnType<typeof createTestDualEraHandler>,
  uri: string,
): Promise<string> {
  const response = await modernRpc(target, 'resources/read', { uri });
  const result = response.json.result as
    | { readonly contents?: readonly { readonly text?: unknown }[] }
    | undefined;
  const text = result?.contents?.[0]?.text;
  if (typeof text !== 'string') throw new Error(`expected text resource ${uri}`);
  return text;
}
