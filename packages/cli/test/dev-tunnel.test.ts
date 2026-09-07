import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chdirIsolated, restoreCwd } from './helpers/isolated-cwd.js';

// Stub the cloudflared wrapper so the wiring test never spawns a real binary or opens a network tunnel.
const close = vi.fn(async () => {});
const stdinIsTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
vi.mock('../src/tunnel.js', () => ({
  startTunnel: vi.fn(async (opts: { localOrigin: string; localMcpUrl: string }) => ({
    publicOrigin: 'https://fake-tunnel.trycloudflare.com',
    publicMcpUrl: `https://fake-tunnel.trycloudflare.com${opts.localMcpUrl.slice(opts.localOrigin.length)}`,
    close,
  })),
}));

import { runDev } from '../src/commands/author-loop.js';
import { writeConfig } from '../src/config.js';
import { startTunnel } from '../src/tunnel.js';

const VALID = `
import { server, tool, z } from '@noodleseed/one';

export default server('tmp', { title: 'Tmp', version: '1.0.0' }, [
  tool('greet', {
    description: 'Greet.',
    input: z.object({ name: z.string() }),
    output: z.object({ message: z.string() }),
    fulfil: ({ input }) => ({ message: \`Hi, \${input.name}!\` }),
  }),
]);
`;

const AUTHENTICATED = `
import { customerAuth, server, tool, z } from '@noodleseed/one';

export default server('tmp', {
  title: 'Tmp',
  version: '1.0.0',
  auth: customerAuth.oidc({
    issuer: 'https://login.example.test',
    audience: 'api://tmp',
  }),
}, [
  tool('greet', {
    description: 'Greet.',
    input: z.object({ name: z.string() }),
    output: z.object({ message: z.string() }),
    fulfil: ({ input }) => ({ message: \`Hi, \${input.name}!\` }),
  }),
]);
`;

let tmp: string;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'noodle-tunnel-'));
  chdirIsolated(tmp);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.mocked(startTunnel).mockClear();
  close.mockClear();
});
afterEach(() => {
  restoreCwd();
  logSpy.mockRestore();
  if (stdinIsTty === undefined) Reflect.deleteProperty(process.stdin, 'isTTY');
  else Object.defineProperty(process.stdin, 'isTTY', stdinIsTty);
  rmSync(tmp, { recursive: true, force: true });
});

const logs = (): string => logSpy.mock.calls.flat().join('\n');

describe('noodle dev --tunnel wiring', () => {
  it('starts the tunnel, prints the public URL + disclosure, and tears it down on SIGINT', async () => {
    const file = join(tmp, 'server.ts');
    writeFileSync(file, VALID);
    const running = runDev(['--tunnel', file], {}, tmp);
    await vi.waitFor(() => {
      expect(logs()).toContain('fake-tunnel.trycloudflare.com');
    });
    expect(startTunnel).toHaveBeenCalledOnce();
    // The public URL mirrors the dev server's tenant path on the Cloudflare origin.
    expect(logs()).toMatch(
      /Public MCP endpoint: https:\/\/fake-tunnel\.trycloudflare\.com\/o\/.+\/dev\/mcp/,
    );
    expect(logs()).toMatch(/Cloudflare/i);
    expect(logs()).toMatch(/publicly reachable/i);

    process.emit('SIGINT');
    expect(await running).toBe(0);
    expect(close).toHaveBeenCalledOnce();
  });

  it('prints the --tunnel hint and does not start a tunnel when the flag is absent', async () => {
    const file = join(tmp, 'server.ts');
    writeFileSync(file, VALID);
    const running = runDev([file], {}, tmp);
    await vi.waitFor(() => {
      expect(logs()).toContain('MCP endpoint:');
    });
    expect(logs()).toContain('noodle dev --tunnel');
    expect(startTunnel).not.toHaveBeenCalled();

    process.emit('SIGINT');
    expect(await running).toBe(0);
  });

  it.each([
    { label: 'non-TTY startup', flags: [], tty: false },
    { label: '--no-preview startup in a TTY', flags: ['--no-preview'], tty: true },
  ])('prints exact unlinked target guidance once on $label', async ({ flags, tty }) => {
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: tty });
    const file = join(tmp, 'server.ts');
    writeFileSync(file, VALID);
    writeFileSync(join(tmp, 'noodle.json'), JSON.stringify({ name: 'non-preview-target' }));
    writeConfig(
      { defaultOrg: 'saved-hosted-org', defaultApp: 'saved-hosted-app', defaultEnv: 'prod' },
      tmp,
    );

    const running = runDev([...flags, file], {}, tmp);
    await vi.waitFor(() => expect(logs()).toContain('MCP endpoint:'));

    expect(
      logs().match(/Local target: local\/non-preview-target\/dev \(unlinked project\)/gu),
    ).toHaveLength(1);
    expect(
      logs().match(
        /Saved global target ignored for this unlinked local project\. Run `noodle link` to mirror a deployed app\./gu,
      ),
    ).toHaveLength(1);
    expect(logs()).not.toMatch(/saved-hosted-org|saved-hosted-app|prod/u);

    process.emit('SIGINT');
    expect(await running).toBe(0);
  });

  it('discloses customer auth and the distinct public OAuth resource for an auth-declared app', async () => {
    const file = join(tmp, 'server.ts');
    writeFileSync(file, AUTHENTICATED);
    const running = runDev(['--tunnel', file], {}, tmp);
    await vi.waitFor(() => {
      expect(logs()).toContain('fake-tunnel.trycloudflare.com');
    });
    expect(logs()).toMatch(/requires its configured customer auth/i);
    expect(logs()).toMatch(/distinct OAuth resource/i);
    expect(logs()).not.toMatch(/auth-open dev server/i);

    process.emit('SIGINT');
    expect(await running).toBe(0);
  });
});
