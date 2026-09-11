import { describe, expect, it } from 'vitest';
import {
  appPackageArtifactV1Schema,
  canonicalJson,
  sensitiveContentFinding,
  sha256Canonical,
} from '../src/index.js';

const digest = 'a'.repeat(64);
const artifact = {
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
} as const;

describe('App Package canonical data boundary', () => {
  it('preserves public discovery in canonical package identity', () => {
    const withAuthorization = (authorization: object) => ({
      ...artifact,
      surface: { ...artifact.surface, tools: [{ ...artifact.surface.tools[0], authorization }] },
    });
    const implicit = appPackageArtifactV1Schema.parse(
      withAuthorization({ requiredScopes: ['tasks:read'] }),
    );
    const discovered = appPackageArtifactV1Schema.parse(
      withAuthorization({ requiredScopes: ['tasks:read'], discovery: 'public' }),
    );
    expect(discovered.surface.tools[0]?.authorization).toEqual({
      requiredScopes: ['tasks:read'],
      discovery: 'public',
    });
    expect(sha256Canonical(discovered)).not.toBe(sha256Canonical(implicit));
  });

  it.each([
    { discovery: 'public' },
    { discovery: 'public', allowedRoles: [] },
    { discovery: 'everyone', allowedRoles: ['support'] },
    { discover: 'public', allowedRoles: ['support'] },
    { securitySchemes: [{ type: 'noauth' }], allowedRoles: ['support'] },
  ])('rejects invalid discovery authorization %j', (authorization) => {
    expect(
      appPackageArtifactV1Schema.safeParse({
        ...artifact,
        surface: { ...artifact.surface, tools: [{ ...artifact.surface.tools[0], authorization }] },
      }).success,
    ).toBe(false);
  });

  it('canonicalizes object keys while preserving array order', () => {
    expect(canonicalJson({ z: 1, a: { y: 2, x: 3 } })).toBe('{"a":{"x":3,"y":2},"z":1}');
    expect(canonicalJson({ values: ['second', 'first'] })).toBe('{"values":["second","first"]}');
    expect(sha256Canonical({ b: 2, a: 1 })).toBe(sha256Canonical({ a: 1, b: 2 }));
  });

  it('matches JSON object omission while rejecting non-JSON array elements', () => {
    expect(canonicalJson({ kept: true, omitted: undefined })).toBe('{"kept":true}');
    expect(sha256Canonical({ kept: true, omitted: undefined })).toBe(
      sha256Canonical({ kept: true }),
    );
    expect(() => canonicalJson([true, undefined])).toThrow(TypeError);
    expect(() => canonicalJson([true, () => false])).toThrow(TypeError);
    expect(() => canonicalJson(Array(1))).toThrow(TypeError);
    expect(() => canonicalJson(new (class NonJsonValue {})())).toThrow(TypeError);
  });

  it('accepts the complete bounded V1 artifact', () => {
    expect(appPackageArtifactV1Schema.parse(artifact)).toEqual(artifact);
  });

  it('preserves ordinary TypeScript property names in derived schemas and prompt arguments', () => {
    const withPropertyNames = {
      ...artifact,
      surface: {
        ...artifact.surface,
        tools: [
          {
            ...artifact.surface.tools[0],
            input: {
              type: 'object',
              fields: [
                { name: 'expectedRevision', type: 'number', required: true },
                { name: 'line-item', type: 'string', required: false },
              ],
            },
          },
        ],
        prompts: [
          {
            kind: 'prompt',
            name: 'plan_order',
            arguments: [{ name: 'requestedDate', required: true }],
          },
        ],
      },
    };

    expect(appPackageArtifactV1Schema.parse(withPropertyNames)).toEqual(withPropertyNames);
  });

  it('preserves accepted surrounding whitespace so validation cannot change hashed surface bytes', () => {
    const withWhitespace = {
      ...artifact,
      app: { ...artifact.app, title: ' Acme Tasks ' },
      surface: {
        ...artifact.surface,
        tools: [
          {
            ...artifact.surface.tools[0],
            authorization: { requiredScopes: [' tasks:read '] },
          },
        ],
      },
    };

    expect(appPackageArtifactV1Schema.parse(withWhitespace)).toEqual(withWhitespace);
  });

  it.each([
    [
      'a short digest',
      { provenance: { ...artifact.provenance, sourceManifestSha256: 'a'.repeat(63) } },
    ],
    ['an unknown property', { unknown: true }],
    [
      'an unsafe capability kind',
      {
        skill: {
          ...artifact.skill,
          workflows: [
            {
              ...artifact.skill.workflows[0],
              steps: [{ capability: { kind: 'widget', name: 'tasks' } }],
            },
          ],
        },
      },
    ],
    [
      'empty workflow steps',
      { skill: { ...artifact.skill, workflows: [{ ...artifact.skill.workflows[0], steps: [] }] } },
    ],
  ])('rejects %s', (_label, patch) => {
    expect(() => appPackageArtifactV1Schema.parse({ ...artifact, ...patch })).toThrow();
  });

  it.each([
    ['private key', `-----BEGIN ${'PRIVATE KEY'}-----`],
    ['JWT', ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ1c2VyIn0', 'signature'].join('.')],
    ['GitHub classic token', ['ghp', 'a'.repeat(36)].join('_')],
    ['GitHub fine-grained token', ['github', 'pat', 'a'.repeat(22)].join('_')],
    ['AWS access key', ['AKIA', 'A'.repeat(16)].join('')],
    ['Bearer credential', `Bearer ${'credential_value'}`],
    ['alphabetic Bearer credential', 'Bearer abcdefghijklmnop'],
  ])('finds high-confidence %s without echoing its value', (_label, value) => {
    expect(sensitiveContentFinding({ prose: value })).toEqual({
      path: 'prose',
      kind: expect.any(String),
    });
  });

  it.each([
    ['bare', ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ1c2VyIn0', 'signature'].join('.')],
    [
      'assignment-delimited',
      `jwt=${['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ1c2VyIn0', 'signature'].join('.')}`,
    ],
    [
      'parenthesized',
      `(${['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ1c2VyIn0', 'signature'].join('.')})`,
    ],
    ['quoted', `"${['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ1c2VyIn0', 'signature'].join('.')}"`],
  ])('finds a %s JWT at non-base64url boundaries', (_label, value) => {
    expect(sensitiveContentFinding({ prose: value })).toEqual({ path: 'prose', kind: 'jwt' });
  });

  it('allows safe managed-config guidance and credential safety prose', () => {
    expect(
      sensitiveContentFinding({ a: 'Use secret("API_KEY") by managed name only.' }),
    ).toBeUndefined();
    expect(sensitiveContentFinding({ a: 'Never expose bearer tokens in logs.' })).toBeUndefined();
    expect(
      sensitiveContentFinding({ a: 'Send a Bearer authorization header to the configured API.' }),
    ).toBeUndefined();
  });
});
