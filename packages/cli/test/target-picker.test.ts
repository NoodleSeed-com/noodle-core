import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { InMemoryControlPlaneStore, type RunningService, serveService } from '@noodle-borg/service';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  canPickTarget,
  pickApp,
  pickAppInteractively,
  pickEnv,
  pickEnvInteractively,
  pickOrg,
  pickOrgInteractively,
} from '../src/commands/target-picker.js';
import { run } from '../src/index.js';

// Pin a CI/NO_COLOR-free env: picker TTY gating consults process.env (see watch.test.ts note; the
// CI=true leak is what auto-reverted PR #318).
beforeEach(() => {
  delete process.env.CI;
  delete process.env.NO_COLOR;
});

const HELLO = join(import.meta.dirname, 'fixtures', 'archive-hello-server.ts');

/** A fake TTY input/output pair — same pattern as prompts.test.ts's fakeTTY. */
function fakeTTY() {
  const input = new PassThrough() as unknown as NodeJS.ReadStream & { isRaw: boolean };
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = ((v: boolean) => {
    input.isRaw = v;
    return input;
  }) as NodeJS.ReadStream['setRawMode'];
  const writes: string[] = [];
  const output = {
    isTTY: true,
    columns: 80,
    write: (s: string) => {
      writes.push(s);
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  return { input, output, out: () => writes.join('') };
}

async function waitForOutput(out: () => string, needle: string): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (out().includes(needle)) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for prompt output: ${needle}`);
}

describe('canPickTarget', () => {
  it('is false under --json, without a token, or off a TTY', () => {
    const { input, output } = fakeTTY();
    expect(canPickTarget(true, 'tok', { input, output })).toBe(false); // --json
    expect(canPickTarget(false, undefined, { input, output })).toBe(false); // no token
    expect(canPickTarget(false, 'tok', { input: { isTTY: false }, output })).toBe(false); // non-TTY
  });

  it('is true with a TTY, no --json, and a token', () => {
    const { input, output } = fakeTTY();
    expect(canPickTarget(false, 'tok', { input, output })).toBe(true);
  });
});

describe('pickOrg / pickApp / pickEnv (thin select wrappers)', () => {
  it('pickOrg resolves the org navigated to and shows its displayName as a hint', async () => {
    const { input, output, out } = fakeTTY();
    const p = pickOrg([{ slug: 'acme' }, { slug: 'other', displayName: 'Other Inc' }], {
      input,
      output,
    });
    input.emit('keypress', '', { name: 'down' });
    input.emit('keypress', '', { name: 'return' });
    await expect(p).resolves.toBe('other');
    expect(out()).toContain('Other Inc');
  });

  it('pickApp resolves the app slug navigated to', async () => {
    const { input, output } = fakeTTY();
    const p = pickApp(
      [
        { orgSlug: 'acme', appSlug: 'alpha', environments: [], active: true, createdAt: 'x' },
        { orgSlug: 'acme', appSlug: 'beta', environments: [], active: true, createdAt: 'x' },
      ],
      { input, output },
    );
    input.emit('keypress', '', { name: 'return' });
    await expect(p).resolves.toBe('alpha');
  });

  it('pickEnv resolves the env name navigated to', async () => {
    const { input, output } = fakeTTY();
    const p = pickEnv(
      [
        {
          orgSlug: 'acme',
          appSlug: 'alpha',
          envName: 'prod',
          active: true,
          createdAt: 'x',
          deploymentCount: 1,
        },
        {
          orgSlug: 'acme',
          appSlug: 'alpha',
          envName: 'staging',
          active: true,
          createdAt: 'x',
          deploymentCount: 1,
        },
      ],
      { input, output },
    );
    input.emit('keypress', '', { name: 'down' });
    input.emit('keypress', '', { name: 'return' });
    await expect(p).resolves.toBe('staging');
  });
});

describe('pickOrgInteractively / pickAppInteractively / pickEnvInteractively', () => {
  let service: RunningService;
  let home: string;
  let controlPlane: InMemoryControlPlaneStore;

  beforeAll(async () => {
    controlPlane = new InMemoryControlPlaneStore();
    service = await serveService({
      port: 0,
      controlPlaneStore: controlPlane,
      deployGate: {
        authorize: (req) => {
          const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
          if (token !== 'admin-token')
            return Promise.resolve({ ok: false, status: 401, message: 'missing bearer token' });
          return Promise.resolve({
            ok: true,
            identity: { subject: 'admin-sub', email: 'admin@noodleseed.com', superAdmin: true },
          });
        },
      },
      verifyOwnerToken: () => Promise.resolve(null),
      authServerIssuer: 'https://as.noodle.test',
    });
  });

  afterAll(async () => {
    await service.close();
  });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'noodle-target-picker-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('pickOrgInteractively is a no-op (undefined) without a token — no fetch, no picker', async () => {
    const { input, output } = fakeTTY();
    const org = await pickOrgInteractively(
      { serviceUrl: service.url, token: undefined },
      false,
      (o) => `noodle apps list --org ${o}`,
      { input, output },
    );
    expect(org).toBeUndefined();
  });

  it('pickOrgInteractively is a no-op under --json even with a TTY and a token', async () => {
    const { input, output } = fakeTTY();
    const org = await pickOrgInteractively(
      { serviceUrl: service.url, token: 'admin-token' },
      true,
      (o) => `noodle apps list --org ${o}`,
      { input, output },
    );
    expect(org).toBeUndefined();
  });

  it('pickOrgInteractively is a no-op off a TTY', async () => {
    const org = await pickOrgInteractively(
      { serviceUrl: service.url, token: 'admin-token' },
      false,
      (o) => `noodle apps list --org ${o}`,
      { input: { isTTY: false }, output: { isTTY: false } as unknown as NodeJS.WriteStream },
    );
    expect(org).toBeUndefined();
  });

  it('fetches real orgs, threads the picked org through, and prints the hint', async () => {
    // `GET /v1/orgs` reads the control-plane org registry, which `orgs create` populates —
    // separate from the per-org app/env registry a bare `deploy` writes to.
    await run(
      ['orgs', 'create', 'picker-org'],
      { NOODLE_AUTH_TOKEN: 'admin-token', NOODLE_SERVICE_URL: service.url },
      home,
    );
    const { input, output, out } = fakeTTY();
    const promise = pickOrgInteractively(
      { serviceUrl: service.url, token: 'admin-token' },
      false,
      (o) => `noodle apps list --org ${o}`,
      { input, output },
    );
    await waitForOutput(out, 'Which org?');
    // The auto-bootstrapped local org appears before picker-org, so move to the created org.
    input.emit('keypress', '', { name: 'down' });
    input.emit('keypress', '', { name: 'return' });
    const org = await promise;
    expect(org).toBe('picker-org');
    expect(out()).toContain('hint: noodle apps list --org picker-org');
  });

  it('fetches real apps for an org and threads the picked app through', async () => {
    await controlPlane.createOrg({ slug: 'picker-app-org' });
    await run(
      ['deploy', HELLO, '--org', 'picker-app-org', '--app', 'seed-app-2', '--version', '1'],
      { NOODLE_AUTH_TOKEN: 'admin-token', NOODLE_SERVICE_URL: service.url },
      home,
    );
    const { input, output, out } = fakeTTY();
    const promise = pickAppInteractively(
      { serviceUrl: service.url, token: 'admin-token' },
      'picker-app-org',
      false,
      (a) => `noodle apps inspect ${a} --org picker-app-org`,
      { input, output },
    );
    await waitForOutput(out, 'Which app?');
    input.emit('keypress', '', { name: 'return' });
    const app = await promise;
    expect(app).toBe('seed-app-2');
    expect(out()).toContain('hint: noodle apps inspect seed-app-2 --org picker-app-org');
  });

  it('fetches real envs for an org/app and threads the picked env through', async () => {
    await controlPlane.createOrg({ slug: 'picker-env-org' });
    await run(
      [
        'deploy',
        HELLO,
        '--org',
        'picker-env-org',
        '--app',
        'seed-app-3',
        '--env',
        'staging',
        '--version',
        '1',
      ],
      { NOODLE_AUTH_TOKEN: 'admin-token', NOODLE_SERVICE_URL: service.url },
      home,
    );
    const { input, output, out } = fakeTTY();
    const promise = pickEnvInteractively(
      { serviceUrl: service.url, token: 'admin-token' },
      'picker-env-org',
      'seed-app-3',
      false,
      (e) => `noodle envs inspect ${e} --org picker-env-org --app seed-app-3`,
      { input, output },
    );
    await waitForOutput(out, 'Which env?');
    input.emit('keypress', '', { name: 'return' });
    const envName = await promise;
    expect(envName).toBe('staging');
    expect(out()).toContain(
      'hint: noodle envs inspect staging --org picker-env-org --app seed-app-3',
    );
  });

  it('resolves undefined when the user aborts the picker (Escape)', async () => {
    await controlPlane.createOrg({ slug: 'picker-abort-org' });
    await run(
      ['deploy', HELLO, '--org', 'picker-abort-org', '--app', 'seed-app-4', '--version', '1'],
      { NOODLE_AUTH_TOKEN: 'admin-token', NOODLE_SERVICE_URL: service.url },
      home,
    );
    const { input, output, out } = fakeTTY();
    const promise = pickOrgInteractively(
      { serviceUrl: service.url, token: 'admin-token' },
      false,
      (o) => `noodle apps list --org ${o}`,
      { input, output },
    );
    await waitForOutput(out, 'Which org?');
    input.emit('keypress', '', { name: 'escape' });
    await expect(promise).resolves.toBeUndefined();
  });
});
