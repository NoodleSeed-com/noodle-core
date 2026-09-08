import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createNpmReleaseCommands,
  reconcileNpmRelease,
} from '../../../scripts/lib/system-release-npm-reconciliation.mjs';
import { promoteSystemRelease } from '../../../scripts/system-release-promote.mjs';
import { harness, manifest, packageVersions } from './system-release-harness.js';

const entry = {
  package: '@noodleseed/one',
  version: '0.160.0',
  integrity: 'sha512-expected',
  tarball: '@noodleseed-one.tgz',
};
const oneManifest = { packages: { [entry.package]: entry } };
const missingState = () => ({ version: null, integrity: null, latest: null });
const exactState = () => ({
  version: entry.version,
  integrity: entry.integrity,
  latest: entry.version,
});
function stagedError(
  version = entry.version,
  detail = 'Cannot publish over previously staged version',
) {
  return Object.assign(new Error('npm publish failed'), {
    stderr: `npm error code E409\nnpm error ${detail} ${JSON.stringify(version)}.\n`,
  });
}
function fixture() {
  let now = 1_000;
  const control = { visibleAt: 1_000, latestAt: 1_000, published: false, staged: false };
  const events: string[] = [];
  const options = { jobDeadlineMs: now + 30 * 60_000, nowMs: () => now };
  const adapter = {
    async npmState() {
      events.push('read');
      if (!control.published || now < control.visibleAt) return missingState();
      return { ...exactState(), latest: now < control.latestAt ? null : entry.version };
    },
    async publish() {
      events.push('publish');
      control.published = true;
      if (control.staged) throw stagedError();
    },
    async wait(ms: number) {
      events.push('wait');
      now += ms;
    },
  };
  return {
    adapter,
    options,
    control,
    events,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('system release shared npm reconciliation', () => {
  it.each([
    false,
    true,
  ])('waits through a thirteen-minute scan and later latest tag (staged=%s)', async (staged) => {
    const f = fixture();
    Object.assign(f.control, { staged, visibleAt: 793_000, latestAt: 838_000 });
    await expect(
      reconcileNpmRelease(oneManifest, [entry], f.adapter, f.options),
    ).resolves.toBeUndefined();
    expect(f.now()).toBe(841_000);
    expect(f.events.filter((event) => event === 'publish')).toHaveLength(1);
  });

  it('reuses exact bytes without publishing while latest catches up', async () => {
    const f = fixture();
    Object.assign(f.control, { published: true, latestAt: 41_000 });
    await reconcileNpmRelease(oneManifest, [entry], f.adapter, f.options);
    expect(f.now()).toBe(46_000);
    expect(f.events).not.toContain('publish');
  });

  it.each([
    ['a different version', stagedError('0.159.0')],
    ['a generic conflict', stagedError(entry.version, 'version already exists')],
    ['authentication failure', new Error('authentication failed')],
  ])('does not wait or suppress %s', async (_name, error) => {
    const f = fixture();
    f.adapter.publish = async () => {
      throw error;
    };
    await expect(reconcileNpmRelease(oneManifest, [entry], f.adapter, f.options)).rejects.toBe(
      error,
    );
    expect(f.events).not.toContain('wait');
  });

  it.each([
    ['accepted', false, 'publish command succeeded'],
    ['staged', true, 'version already staged'],
  ])('bounds %s visibility and reports its safe outcome', async (_name, staged, detail) => {
    const f = fixture();
    Object.assign(f.control, { staged, visibleAt: Number.POSITIVE_INFINITY });
    await expect(reconcileNpmRelease(oneManifest, [entry], f.adapter, f.options)).rejects.toThrow(
      detail,
    );
    expect(f.now()).toBeLessThanOrEqual(1_201_000);
    expect(f.now()).toBeGreaterThanOrEqual(1_171_000);
  });

  it.each([
    { version: '0.159.0' },
    { integrity: 'sha512-conflicting' },
    { latest: '0.159.0' },
  ])('never accepts final registry mismatch %j', async (override) => {
    const f = fixture();
    f.options.jobDeadlineMs = 92_000;
    const read = f.adapter.npmState;
    f.adapter.npmState = async () =>
      f.control.published ? { ...exactState(), ...override } : read();
    await expect(reconcileNpmRelease(oneManifest, [entry], f.adapter, f.options)).rejects.toThrow(
      'did not converge',
    );
    expect(f.now()).toBeLessThan(32_000);
  });

  it('rejects existing conflicting bytes before publication', async () => {
    const f = fixture();
    f.adapter.npmState = async () => ({ ...exactState(), integrity: 'sha512-conflicting' });
    await expect(reconcileNpmRelease(oneManifest, [entry], f.adapter, f.options)).rejects.toThrow(
      /conflicting.*integrity/,
    );
    expect(f.events).not.toContain('publish');
  });

  it('rejects latest advancing after the earlier preflight before uploading', async () => {
    const f = fixture();
    f.adapter.npmState = async () => ({ ...missingState(), latest: '0.161.0' });
    await expect(reconcileNpmRelease(oneManifest, [entry], f.adapter, f.options)).rejects.toThrow(
      'is ahead',
    );
    expect(f.events).not.toContain('publish');
  });

  it('reports an unknown publication outcome when its accepted upload exhausts the budget', async () => {
    const f = fixture();
    f.options.jobDeadlineMs = 101_000;
    f.adapter.publish = async () => {
      f.advance(40_000);
    };
    await expect(reconcileNpmRelease(oneManifest, [entry], f.adapter, f.options)).rejects.toThrow(
      'publication outcome unknown',
    );
  });

  it('rechecks an earlier converged package when another package becomes ready', async () => {
    const f = fixture();
    f.options.jobDeadlineMs = 121_000;
    const second = { ...entry, package: '@noodleseed/agent-kit' };
    const adapter = {
      ...f.adapter,
      async npmState(name: string) {
        const ready = name === entry.package ? f.now() < 16_000 : f.now() >= 16_000;
        return { ...exactState(), latest: ready ? entry.version : null };
      },
    };
    await expect(
      reconcileNpmRelease(
        { packages: { ...oneManifest.packages, [second.package]: second } },
        [],
        adapter,
        f.options,
      ),
    ).rejects.toThrow('did not converge');
  });

  it.each([
    undefined,
    Number.NaN,
    0,
    60_999,
  ])('rejects invalid or exhausted job deadline %s before writes', async (jobDeadlineMs) => {
    const f = fixture();
    await expect(
      reconcileNpmRelease(oneManifest, [entry], f.adapter, { ...f.options, jobDeadlineMs }),
    ).rejects.toThrow('deadline');
    expect(f.events).toEqual([]);
  });

  it('does not renew the deadline after publication or across package observations', async () => {
    const f = fixture();
    f.options.jobDeadlineMs = 101_000;
    const publish = f.adapter.publish;
    f.adapter.publish = async () => {
      f.advance(20_000);
      await publish();
    };
    f.control.visibleAt = Number.POSITIVE_INFINITY;
    await expect(reconcileNpmRelease(oneManifest, [entry], f.adapter, f.options)).rejects.toThrow(
      'did not converge',
    );
    expect(f.now()).toBe(21_000);
  });

  it('rechecks after the clipped final wait while time remains', async () => {
    const f = fixture();
    f.options.jobDeadlineMs = 101_000;
    f.control.visibleAt = 10_500;
    await reconcileNpmRelease(oneManifest, [entry], f.adapter, f.options);
    expect(f.now()).toBe(11_000);
  });

  it('propagates registry read failures instead of treating them as missing versions', async () => {
    const f = fixture();
    const error = new Error('registry read failed');
    f.adapter.npmState = async () => {
      throw error;
    };
    await expect(reconcileNpmRelease(oneManifest, [entry], f.adapter, f.options)).rejects.toBe(
      error,
    );
    expect(f.events).not.toContain('publish');
  });
});

describe('bounded production npm commands', () => {
  it('recognizes a real bounded E409 and keeps exact staged bytes alive until the command exits', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noodle-npm-command-'));
    const original = join(root, 'candidate.tgz');
    const bytes = Buffer.from('prevalidated immutable publication bytes');
    writeFileSync(original, bytes);
    const selected = {
      ...entry,
      component: 'cli',
      tarballPath: original,
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    };
    const jobDeadlineMs = Date.now() + 30 * 60_000;
    let published = false;
    let uploadPath = '';
    try {
      const commands = createNpmReleaseCommands({
        jobDeadlineMs,
        execute: (_name: string, args: string[], options: Record<string, unknown>) => {
          if (args[0] === 'publish') {
            uploadPath = args[1];
            expect(uploadPath).not.toBe(original);
            expect(readFileSync(uploadPath)).toEqual(bytes);
            published = true;
            return execFileSync(
              process.execPath,
              [
                '-e',
                `process.stderr.write(${JSON.stringify(stagedError().stderr)});process.exit(1)`,
              ],
              options,
            );
          }
          return JSON.stringify(
            args[2] === 'versions'
              ? published
                ? [selected.version]
                : []
              : !published
                ? null
                : args[2] === 'dist.integrity'
                  ? selected.integrity
                  : selected.version,
          );
        },
      });
      await reconcileNpmRelease(
        { packages: { [entry.package]: selected } },
        [selected],
        {
          ...commands,
          async wait() {
            throw new Error('exact bytes already visible');
          },
        },
        { jobDeadlineMs },
      );
      expect(published).toBe(true);
      expect(existsSync(uploadPath)).toBe(false);
      expect(readFileSync(original)).toEqual(bytes);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('recomputes the remaining deadline before every metadata subprocess', async () => {
    let now = 1_000;
    const limits: number[] = [];
    const commands = createNpmReleaseCommands({
      jobDeadlineMs: 101_000,
      nowMs: () => now,
      execute: (
        _name: string,
        args: string[],
        options: { timeout: number; maxBuffer: number; killSignal: string },
      ) => {
        limits.push(options.timeout);
        expect(options.maxBuffer).toBe(1024 * 1024);
        expect(options.killSignal).toBe('SIGKILL');
        now += 8_000;
        return JSON.stringify(
          args[2] === 'versions'
            ? [entry.version]
            : args[2] === 'dist.integrity'
              ? entry.integrity
              : entry.version,
        );
      },
    });
    await expect(
      commands.npmState(entry.package, entry.version, { deadlineMs: 26_000 }),
    ).resolves.toMatchObject(exactState());
    expect(limits).toEqual([25_000, 17_000, 9_000]);
  });

  it.each([
    ['timeout', 'setTimeout(() => {}, 10000)', 100],
    ['overflow', 'process.stdout.write("sensitive".repeat(200000))', 5_000],
    ['invalid latest', 'process.stdout.write(JSON.stringify("private-token-do-not-print"))', 5_000],
    ['stderr', 'process.stderr.write("private-token-do-not-print");process.exit(1)', 5_000],
  ])('bounds and sanitizes subprocess %s', async (_name, program, remaining) => {
    const commands = createNpmReleaseCommands({
      jobDeadlineMs: Date.now() + 60_000 + remaining,
      execute: (_name: string, _args: string[], options: Record<string, unknown>) =>
        execFileSync(process.execPath, ['-e', program], options),
    });
    await expect(commands.npmState(entry.package, entry.version)).rejects.toThrow(
      /npm registry (read|deadline)/,
    );
    try {
      await commands.npmState(entry.package, entry.version);
    } catch (error) {
      expect(String(error)).not.toContain('sensitive');
      expect(String(error)).not.toContain('private-token');
    }
  });
});

describe('system release final npm verification', () => {
  it('submits the whole package set before waiting through a thirteen-minute registry scan', async () => {
    const h = harness({ publish: Object.keys(packageVersions) });
    let now = 1_000;
    const adapter = {
      ...h.adapter,
      jobDeadlineMs: now + 30 * 60_000,
      nowMs: () => now,
      async npmState(name: string) {
        const state = await h.adapter.npmState(name);
        return now < 793_000 ? missingState() : state;
      },
      async wait(ms: number) {
        h.calls.push('wait:npm');
        now += ms;
      },
    };
    const publish = Object.entries(packageVersions).map(([name, version]) => ({
      package: name,
      version,
      integrity: `sha512-${name}`,
      tarball: `${name}.tgz`,
    }));
    await expect(promoteSystemRelease({ manifest: manifest(), publish }, adapter)).resolves.toEqual(
      {
        hostedConverged: true,
        npmConverged: true,
      },
    );
    expect(h.calls.filter((call) => call.startsWith('publish:'))).toHaveLength(3);
    for (const name of Object.keys(packageVersions))
      expect(h.calls.indexOf(`publish:${name}`)).toBeLessThan(h.calls.indexOf('wait:npm'));
  });
});
