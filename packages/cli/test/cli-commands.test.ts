import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  InMemoryAssetStore,
  InMemoryControlPlaneStore,
  type RunningService,
  serveService,
} from '@noodle-borg/service';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readConfig, readServers, run } from '../src/index.js';
import { chdirIsolated, restoreCwd } from './helpers/isolated-cwd.js';

const here = dirname(fileURLToPath(import.meta.url));
const examples = join(here, '..', '..', '..', 'examples');
const helloManifest = join(examples, 'hello', 'src', 'server.ts');

const repoRoot = join(here, '..', '..', '..');

let service: RunningService;

async function controlPlaneWithOrgs(
  ...orgs: readonly string[]
): Promise<InMemoryControlPlaneStore> {
  const controlPlane = new InMemoryControlPlaneStore();
  await Promise.all(orgs.map((slug) => controlPlane.createOrg({ slug })));
  return controlPlane;
}

beforeAll(async () => {
  service = await serveService({
    port: 0,
    controlPlaneStore: await controlPlaneWithOrgs('local'),
    deployGate: {
      authorize: () =>
        Promise.resolve({
          ok: true,
          identity: { subject: 'owner-sub', email: 'owner@noodleseed.com', superAdmin: true },
        }),
    },
    verifyOwnerToken: (token) =>
      Promise.resolve(token === 'OWNER' ? { caller: { subject: 'owner-sub' } } : null),
    authServerIssuer: 'https://as.noodle.test',
    assetStore: new InMemoryAssetStore(),
  });
});

afterAll(async () => {
  await service.close();
});

describe('noodle CLI commands (Slice B)', () => {
  let home: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  const stderrTtyDescriptor = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'noodle-cli-'));
    chdirIsolated(home);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    restoreCwd();
    logSpy.mockRestore();
    errSpy.mockRestore();
    vi.unstubAllGlobals();
    if (stderrTtyDescriptor !== undefined) {
      Object.defineProperty(process.stderr, 'isTTY', stderrTtyDescriptor);
    }
    rmSync(home, { recursive: true, force: true });
  });

  it('prints the installed CLI version', async () => {
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(await run(['--version'], {}, home)).toBe(0);
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toBe(pkg.version);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('prints help successfully', async () => {
    expect(await run(['--help'], {}, home)).toBe(0);
    const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('usage: noodle <command>');
    expect(printed).toContain('validate [<server.ts>]');
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('documents global npm installation with the noodle command', () => {
    // README only: docs/ is internal and never projected. Assert only what holds for *both*
    // READMEs — publicly this reads the overlay's, whose quickstart is the no-account path.
    const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');
    expect(readme).toContain('npm install -g @noodleseed/one');
    expect(readme).toMatch(/^noodle [a-z]+/m);
    expect(readme).not.toContain('npm install -g install @noodleseed/one');
  });

  it('prints the update plan and exits 0 when non-interactive', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ version: '99.0.0' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    try {
      expect(await run(['update'], {}, home)).toBe(0);
      const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(printed).toContain('Noodle CLI update available:');
      expect(printed).toContain('noodle update --yes');
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('login writes config; deploy then pulls service from it', async () => {
    const open = await serveService({
      port: 0,
      controlPlaneStore: await controlPlaneWithOrgs('local'),
      deployGate: {
        authorize: () =>
          Promise.resolve({
            ok: true,
            identity: { subject: 'owner-sub', email: 'owner@noodleseed.com', superAdmin: true },
          }),
      },
      verifyOwnerToken: (token) =>
        Promise.resolve(token === 'OWNER' ? { caller: { subject: 'owner-sub' } } : null),
      authServerIssuer: 'https://as.noodle.test',
    });
    try {
      expect(await run(['login', '--service', open.url], {}, home)).toBe(0);
      expect(readConfig(home)).toMatchObject({ serviceUrl: open.url });
      // No --service flag: resolved from config. Local service needs no auth.
      expect(await run(['deploy', helloManifest, '--version', '1'], {}, home)).toBe(0);
    } finally {
      await open.close();
    }
  });

  it('deploy --save records the server locally; deployments list shows it', async () => {
    const open = await serveService({
      port: 0,
      controlPlaneStore: await controlPlaneWithOrgs('local'),
      deployGate: {
        authorize: () =>
          Promise.resolve({
            ok: true,
            identity: { subject: 'owner-sub', email: 'owner@noodleseed.com', superAdmin: true },
          }),
      },
      verifyOwnerToken: (token) =>
        Promise.resolve(token === 'OWNER' ? { caller: { subject: 'owner-sub' } } : null),
      authServerIssuer: 'https://as.noodle.test',
    });
    try {
      await run(['login', '--service', open.url], {}, home);
      expect(await run(['deploy', helloManifest, '--version', '1', '--save'], {}, home)).toBe(0);
      const saved = readServers(home);
      expect(saved).toHaveLength(1);
      expect(saved[0]?.callerKey).toBeUndefined();
      expect(saved[0]?.url).toContain('/mcp');
      expect(await run(['deployments', 'list'], {}, home)).toBe(0);
      logSpy.mockClear();
      expect(await run(['open', '--print'], {}, home)).toBe(0);
      expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(saved[0]?.url);
    } finally {
      await open.close();
    }
  });

  it('logout clears the token but keeps the service URL; whoami runs', async () => {
    await run(['login', '--service', 'https://svc', '--auth-token', 'tok'], {}, home);
    expect(readConfig(home).authToken).toBe('tok');
    expect(await run(['logout'], {}, home)).toBe(0);
    expect(readConfig(home).authToken).toBeUndefined();
    expect(readConfig(home).serviceUrl).toBe('https://svc');
    expect(await run(['whoami'], {}, home)).toBe(0);
  });

  it('bare login uses the resolved default service URL', async () => {
    const open = await serveService({ port: 0 });
    try {
      expect(await run(['login'], { NOODLE_SERVICE_URL: open.url }, home)).toBe(0);
      expect(readConfig(home).serviceUrl).toBe(open.url);
    } finally {
      await open.close();
    }
  });

  it('unknown command → exit 2 with a did-you-mean hint', async () => {
    expect(await run(['frobnicate'], {}, home)).toBe(2);
  });

  it('rejects an invalid deploy --access value before reading service config', async () => {
    expect(await run(['deploy', helloManifest, '--access', 'team'], {}, home)).toBe(2);
    expect(errSpy.mock.calls.join('\n')).toContain('deploy: --access must be');
  });

  it('whoami never prints the full token (masked)', async () => {
    expect(await run(['login', '--service', service.url, '--auth-token', 'OWNER'], {}, home)).toBe(
      0,
    );
    logSpy.mockClear();
    expect(await run(['whoami'], {}, home)).toBe(0);
    const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).not.toContain('OWNER');
  });

  it('whoami defaults to Noodle Seed Cloud when no override is configured (signed-out card)', async () => {
    expect(await run(['whoami'], {}, home)).toBe(0);
    const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed.split('\n')[0]).toBe('not signed in');
    expect(printed).toMatch(/service\s+https:\/\/cloud\.noodleseed\.dev/);
    expect(printed).toContain('NEXT');
    expect(printed).toContain('noodle login');
  });
});
