import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runLocalTest } from '../src/commands/author-loop.js';

let home: string;
let project: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'noodle-auth-smoke-home-'));
  project = mkdtempSync(join(tmpdir(), 'noodle-auth-smoke-project-'));
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

describe('noodle test for customer-protected apps', () => {
  it('passes the protection boundary and requires Devtools for the interactive auth proof', async () => {
    const server = writeCustomerAuthServer();

    expect(await runLocalTest([server, '--json'], home)).toBe(0);
    const envelope = JSON.parse(stdout()) as {
      ok: boolean;
      data: {
        endpoint: string;
        registeredTools: string[];
        auth: {
          protected: boolean;
          boundary: string;
          resource: string;
          resourceMetadataUrl: string;
          authorizationServers: string[];
          interactiveRequired: boolean;
        };
        next: string;
      };
    };

    expect(envelope).toMatchObject({
      ok: true,
      data: {
        registeredTools: ['whoami'],
        auth: {
          protected: true,
          boundary: 'pass',
          authorizationServers: ['https://login.example.test'],
          interactiveRequired: true,
        },
        next: 'noodle devtools',
      },
    });
    expect(envelope.data.auth.resource).toBe(envelope.data.endpoint);
    expect(envelope.data.auth.resourceMetadataUrl).toContain(
      '/.well-known/oauth-protected-resource/o/local/',
    );
    expect(stdout()).not.toContain('api://private-dev');
  });

  it('does not claim an explicitly requested tool call ran without interactive sign-in', async () => {
    const server = writeCustomerAuthServer();

    expect(
      await runLocalTest([server, '--tool', 'whoami', '--args', '{}', '--json'], home),
    ).not.toBe(0);
    expect(JSON.parse(stdout())).toMatchObject({
      ok: false,
      error: {
        code: 'customer_auth_interactive_required',
        next: 'noodle devtools',
        detail: { boundary: 'pass', tool: 'whoami' },
      },
    });
  });
});

function writeCustomerAuthServer(): string {
  const path = join(project, 'server.ts');
  writeFileSync(
    path,
    `
import { customerAuth, server, tool, z } from '@noodleseed/one';

export default server('private_dev', {
  title: 'Private Dev',
  version: '1.0.0',
  auth: customerAuth.oidc({
    issuer: 'https://login.example.test',
    audience: 'api://private-dev'
  })
}, [
  tool('whoami', {
    description: 'Show the caller.',
    input: z.object({}),
    output: z.object({ subject: z.string() }),
    fulfil: ({ user }) => ({ subject: user.subject })
  })
]);
`,
  );
  return path;
}

function stdout(): string {
  return logSpy.mock.calls.map((call) => String(call[0])).join('\n');
}
