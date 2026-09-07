import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryControlPlaneStore, type RunningService, serveService } from '@noodle-borg/service';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as controlPlane from '../src/control-plane.js';
import { localCompileFailStep, parseFlags } from '../src/first-run.js';
import { offerFirstRun } from '../src/first-run-entry.js';
import { run } from '../src/index.js';
import { initProject, readProjectLink } from '../src/project.js';
import * as bootstrap from '../src/project-bootstrap.js';
import { assertJsonEnvelope } from './helpers/json-envelope.js';

describe('parseFlags — the noodle start flag contract', () => {
  it('defaults to interactive deploy-or-local with nothing forced', () => {
    const f = parseFlags([]);
    expect(f.json).toBe(false);
    expect(f.yes).toBe(false);
    expect(f.where).toBeUndefined();
    expect(f.name).toBeUndefined();
    expect(f.template).toBeUndefined();
  });

  it('parses the headless/agent flags', () => {
    const f = parseFlags([
      '--json',
      '--deploy',
      '--name',
      'food-ordering',
      '--template',
      'hello',
      '--org',
      'acme',
      '--app',
      'support',
      '--env',
      'prod',
      '--access',
      'owner-only',
      '-y',
    ]);
    expect(f).toMatchObject({
      json: true,
      where: 'deploy',
      name: 'food-ordering',
      template: 'hello',
      org: 'acme',
      app: 'support',
      env: 'prod',
      access: 'owner-only',
      yes: true,
    });
  });

  it('--local selects the local path', () => {
    expect(parseFlags(['--local']).where).toBe('local');
  });
});

describe('localCompileFailStep — start --local dependency-aware repair', () => {
  it('surfaces `npm install` when the local compile fails on a missing build dependency', () => {
    // A fresh widget project (no node_modules) fails to compile only because React/Vite are missing.
    const result = localCompileFailStep([
      {
        code: 'read_error',
        path: '',
        message: 'React widget bundling requires Vite; run npm install',
      },
    ]);
    expect(result.ok).toBe(false);
    // Structured self-repair envelope, not a generic { code: 'error' }.
    expect(result.error?.code).toBe('missing_dependency');
    expect(result.error?.fix).toBeTruthy();
    expect(result.error?.next).toBe('npm install');
    expect(result.error?.message).toContain('dependencies');
  });

  it('keeps the generic `noodle validate` repair for a real manifest error', () => {
    const result = localCompileFailStep([
      { code: 'invalid_tool', path: 'tools.0.name', message: 'invalid identifier "Greet Person"' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.error?.next).toBe('noodle validate');
  });

  it('defaults to `noodle validate` when no compile errors are reported', () => {
    expect(localCompileFailStep(undefined).error?.next).toBe('noodle validate');
  });
});

describe('offerFirstRun — bare `noodle`', () => {
  let home: string;
  let origInTTY: unknown;
  let origOutTTY: unknown;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'noodle-start-'));
    origInTTY = process.stdin.isTTY;
    origOutTTY = process.stdout.isTTY;
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: origInTTY, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: origOutTTY, configurable: true });
    errSpy.mockRestore();
  });

  it('never forces the wizard on a non-interactive caller — prints usage, exits 1', async () => {
    // Simulate a pipe/CI: not a TTY. The wizard must not prompt.
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    const code = await offerFirstRun({}, home);
    expect(code).toBe(1);
    const printed = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('usage: noodle <command>');
  });
});

describe.sequential('noodle start --json — the uniform headless envelope', () => {
  let cwd: string;
  let home: string;
  let tmp: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    cwd = process.cwd();
    home = mkdtempSync(join(tmpdir(), 'noodle-start-home-'));
    tmp = mkdtempSync(join(tmpdir(), 'noodle-start-cwd-'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    process.chdir(cwd);
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  });

  it('start --json --local emits a valid success envelope with structured nextCommands', async () => {
    expect(
      await run(
        ['init', '--no-install', tmp, '--template', 'hello', '--name', 'hello-world'],
        {},
        home,
      ),
    ).toBe(0);
    process.chdir(tmp);
    logSpy.mockClear();
    expect(await run(['start', '--json', '--local'], {}, home)).toBe(0);
    const envelope = assertJsonEnvelope<{
      account: { email: string | null };
      entrypoint: string;
      verified: boolean;
      nextCommands: Array<{ command: string; reason: string }>;
    }>(JSON.parse(logSpy.mock.calls.at(-1)?.[0] as string));
    expect(envelope.ok).toBe(true);
    if (!envelope.ok) throw new Error('expected success');
    expect(envelope.data.verified).toBe(false);
    expect(envelope.data.entrypoint).toContain('server.ts');
    expect(envelope.data.nextCommands.map((c) => c.command)).toContain('noodle dev');
    expect(envelope.data.nextCommands.map((c) => c.command)).not.toContain(
      'noodle connect claude-code',
    );
    expect(envelope.data).not.toHaveProperty('url');
    expect(
      envelope.data.nextCommands.every(
        (c) => typeof c.command === 'string' && typeof c.reason === 'string',
      ),
    ).toBe(true);
  }, 20_000);

  it('never resolves or refreshes hosted credentials for local value', async () => {
    expect(
      await run(['init', '--no-install', tmp, '--template', 'hello', '--no-agents'], {}, home),
    ).toBe(0);
    process.chdir(tmp);
    const auth = vi.spyOn(controlPlane, 'resolveControlPlaneToken');
    expect(await run(['start', '--local', '--json'], {}, home)).toBe(0);
    expect(auth).not.toHaveBeenCalled();
  });

  it('start --json never prompts and fails with missing_answer (exit 2) when a required answer is absent', async () => {
    // An empty dir has no scaffolded entrypoint, so the project step needs `--name`. Headless (`--json`)
    // it must resolve from flags only and never open a prompt — a hang here would blow the test timeout.
    process.chdir(tmp);
    logSpy.mockClear();
    expect(await run(['start', '--json'], {}, home)).toBe(2);
    const envelope = assertJsonEnvelope(JSON.parse(logSpy.mock.calls.at(-1)?.[0] as string));
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected failure');
    expect(envelope.error.code).toBe('missing_answer');
    expect(envelope.error.message).toContain('name');
  });
});

describe.sequential('noodle start — start owns the link', () => {
  let service: RunningService;
  let cwd: string;
  let home: string;
  let tmp: string;

  beforeAll(async () => {
    const controlPlane = new InMemoryControlPlaneStore();
    await controlPlane.createOrg({ slug: 'acme' });
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
    cwd = process.cwd();
    home = mkdtempSync(join(tmpdir(), 'noodle-start-link-home-'));
    tmp = mkdtempSync(join(tmpdir(), 'noodle-start-link-cwd-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    process.chdir(cwd);
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  });

  it('persists the deploy target so a later `noodle deploy` needs no `noodle link`', async () => {
    process.chdir(tmp);
    // This is the hosted target/link integration test. The installer has its own process and tarball
    // qualification; provide a locally-qualified hello fixture without fetching a released CLI here.
    const localSetup = vi
      .spyOn(bootstrap, 'bootstrapProject')
      .mockImplementation(async (options) => ({
        ...initProject(options),
        setup: {
          ready: true,
          packageManager: 'npm',
          completed: ['scaffold', 'install', 'validate', 'behavior', 'types'],
          resumeCommand: 'noodle init started',
          nextSteps: [],
          restartRequired: true,
          proof: 'local-synthetic',
        },
      }));
    const code = await run(
      [
        'start',
        '--json',
        '--deploy',
        '--name',
        'started',
        '--template',
        'hello',
        '--org',
        'acme',
        '--service',
        service.url,
        '--auth-token',
        'admin-token',
      ],
      {},
      home,
    );
    expect(code).toBe(0);
    expect(localSetup).toHaveBeenCalledOnce();
    // The scaffolded project root is `<cwd>/started`; the link must be persisted there, not the parent.
    const link = readProjectLink(join(tmp, 'started'));
    expect(link).toBeDefined();
    expect(link?.org).toBe('acme');
    expect(link?.app).toBe('started');
    expect(link?.env).toBe('prod');
    expect(link?.serviceUrl).toBe(service.url);
  }, 20_000);
});
