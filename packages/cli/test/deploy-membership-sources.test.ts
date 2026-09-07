import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deploy } from '../src/deploy.js';
import { parseDeployRequestJson } from './deploy-request-test-helpers.js';

/**
 * `orgMembershipSources` reaches the deploy body from `noodle.json`, and a mismatched access mode fails
 * locally rather than as an opaque HTTP 400 (ADR 0183).
 */

// Public app authoring is TypeScript-only; the CLI rejects a manifest file outright.
const AUTHORED = `
import { server, tool, z } from '@noodleseed/one';

export default server(
  'vault',
  { title: 'Vault', version: '1.0.0' },
  [
    tool('greet', {
      description: 'Greet.',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      fulfil: () => ({ ok: true }),
    }),
  ],
);
`;

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'noodle-membership-'));
  const authored = join(dir, 'server.ts');
  writeFileSync(authored, AUTHORED);
  return authored;
}

function okFetch(capture: { body?: Record<string, unknown> }): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    capture.body = parseDeployRequestJson(init) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        ok: true,
        org: 'acme',
        app: 'vault',
        env: 'prod',
        deploymentId: 'vault-12345678',
        serverVersion: '1',
        url: 'https://svc.example/o/acme/vault/v1/mcp',
        defaultUrl: 'https://svc.example/o/acme/vault/mcp',
        accessMode: 'org-members',
      }),
      { status: 201, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
}

describe('deploy sends org membership sources', () => {
  it('sends the narrowed membership sources in the deploy body', async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const outcome = await deploy({
      manifestPath: project(),
      serviceUrl: 'https://svc.example',
      org: 'acme',
      app: 'vault',
      env: 'prod',
      accessMode: 'org-members',
      orgMembershipSources: ['explicit'],
      fetchImpl: okFetch(capture),
    });

    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(capture.body?.orgMembershipSources).toEqual(['explicit']);
  });

  it('omits the field entirely when noodle.json declares no narrowing', async () => {
    const capture: { body?: Record<string, unknown> } = {};
    await deploy({
      manifestPath: project(),
      serviceUrl: 'https://svc.example',
      org: 'acme',
      app: 'vault',
      env: 'prod',
      accessMode: 'org-members',
      fetchImpl: okFetch(capture),
    });

    expect(capture.body).not.toHaveProperty('orgMembershipSources');
  });

  it('fails locally, before any network call, on a non-org-members deploy', async () => {
    let called = false;
    const outcome = await deploy({
      manifestPath: project(),
      serviceUrl: 'https://svc.example',
      org: 'acme',
      app: 'vault',
      env: 'prod',
      accessMode: 'authenticated',
      orgMembershipSources: ['explicit'],
      fetchImpl: (async () => {
        called = true;
        return new Response('', { status: 500 });
      }) as unknown as typeof fetch,
    });

    expect(outcome.ok).toBe(false);
    expect(called).toBe(false);
    expect(outcome).toMatchObject({
      status: 0,
      errors: [expect.objectContaining({ code: 'membership_sources_requires_org_members' })],
    });
  });
});
