import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/index.js';
import { chdirIsolated, restoreCwd } from './helpers/isolated-cwd.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('noodle service commands', () => {
  it.each([
    {
      name: 'missing configuration',
      expectedExit: 0,
      expectedCode: undefined,
      expectedStatus: 'missing',
      setup: (_dir: string) => {},
    },
    {
      name: 'valid YAML configuration',
      expectedExit: 0,
      expectedCode: undefined,
      expectedStatus: 'valid',
      setup: (dir: string) => {
        writeFileSync(join(dir, 'noodle.service.yaml'), 'profile: open-core\n');
      },
    },
    {
      name: 'valid TypeScript configuration',
      expectedExit: 0,
      expectedCode: undefined,
      expectedStatus: 'valid',
      setup: (dir: string) => {
        writeFileSync(join(dir, 'noodle.service.ts'), 'export default {};\n');
      },
    },
    {
      name: 'invalid YAML configuration',
      expectedExit: 1,
      expectedCode: 'service_config_invalid',
      expectedStatus: undefined,
      setup: (dir: string) => {
        writeFileSync(join(dir, 'noodle.service.yaml'), 'profile: definitely-invalid\n');
      },
    },
    {
      name: 'conflicting YAML and TypeScript configurations',
      expectedExit: 1,
      expectedCode: 'service_config_conflict',
      expectedStatus: undefined,
      setup: (dir: string) => {
        writeFileSync(join(dir, 'noodle.service.yaml'), 'profile: open-core\n');
        writeFileSync(join(dir, 'noodle.service.ts'), 'export default {};\n');
      },
    },
  ])('service doctor --json envelopes $name', async ({
    expectedExit,
    expectedCode,
    expectedStatus,
    setup,
  }) => {
    const dir = mkdtempSync(join(tmpdir(), 'noodle-service-doctor-json-'));
    const home = mkdtempSync(join(tmpdir(), 'noodle-cli-home-'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    chdirIsolated(dir);
    setup(dir);
    try {
      expect(await run(['service', 'doctor', '--json'], {}, home)).toBe(expectedExit);
      expect(logSpy).toHaveBeenCalledOnce();
      expect(errorSpy).not.toHaveBeenCalled();
      const envelope = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as {
        ok: boolean;
        data?: { status?: string };
        error?: { code?: string };
      };
      expect(envelope.ok).toBe(expectedCode === undefined);
      if (expectedCode === undefined) expect(envelope.data?.status).toBe(expectedStatus);
      else expect(envelope.error?.code).toBe(expectedCode);
    } finally {
      restoreCwd();
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('prints service capabilities without module package names by default', async () => {
    const home = mkdtempSync(join(tmpdir(), 'noodle-cli-home-'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal('fetch', (async () =>
      Response.json({
        ok: true,
        capabilities: ['audit', 'observability', 'secrets', 'connectors', 'apps'],
      })) as typeof fetch);
    try {
      expect(
        await run(['service', 'capabilities', '--service', 'https://svc.example'], {}, home),
      ).toBe(0);
      const printed = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(printed).toContain('service: https://svc.example');
      expect(printed).toContain('audit');
      expect(printed).not.toContain('@noodle-borg');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('prints service capability JSON and advanced module detail only when requested', async () => {
    const home = mkdtempSync(join(tmpdir(), 'noodle-cli-home-'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL) => {
      expect(input.toString()).toBe('https://svc.example/v1/service/capabilities?advanced=1');
      return Response.json({
        ok: true,
        capabilities: ['audit', 'observability', 'secrets', 'connectors', 'apps'],
        modules: [{ name: '@noodle-borg/module-audit', capabilities: ['audit'] }],
      });
    }) as typeof fetch);
    try {
      expect(
        await run(
          ['service', 'capabilities', '--service', 'https://svc.example', '--advanced', '--json'],
          {},
          home,
        ),
      ).toBe(0);
      const body = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as {
        data: { modules?: readonly { name: string }[] };
      };
      expect(body.data.modules?.[0]?.name).toBe('@noodle-borg/module-audit');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('filters service capabilities by canonical capability name in text and JSON output', async () => {
    const home = mkdtempSync(join(tmpdir(), 'noodle-cli-home-'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal('fetch', (async () =>
      Response.json({
        ok: true,
        capabilities: ['audit', 'observability', 'secrets', 'connectors', 'apps'],
        modules: [{ name: '@noodle-borg/module-audit', capabilities: ['audit'] }],
      })) as typeof fetch);
    try {
      expect(
        await run(
          ['service', 'capabilities', '--service', 'https://svc.example', '--capability', 'audit'],
          {},
          home,
        ),
      ).toBe(0);
      const text = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(text).toContain('capabilities: audit');
      expect(text).toContain('audit: durable event trail');
      expect(text).not.toContain('connectors');

      logSpy.mockClear();
      expect(
        await run(
          [
            'service',
            'capabilities',
            '--service',
            'https://svc.example',
            '--capability',
            'audit',
            '--advanced',
            '--json',
          ],
          {},
          home,
        ),
      ).toBe(0);
      const body = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as {
        data: {
          capabilities: readonly string[];
          modules?: readonly { capabilities: readonly string[] }[];
        };
      };
      expect(body.data.capabilities).toEqual(['audit']);
      expect(body.data.modules).toEqual([
        { name: '@noodle-borg/module-audit', capabilities: ['audit'] },
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects unknown service capability filters with a canonical-name hint', async () => {
    const home = mkdtempSync(join(tmpdir(), 'noodle-cli-home-'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(
        await run(
          [
            'service',
            'capabilities',
            '--service',
            'https://svc.example',
            '--capability',
            'governance',
          ],
          {},
          home,
        ),
      ).toBe(2);
      expect(errorSpy.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
        'must be one of',
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('keeps audit events out of the generic service command namespace', async () => {
    const home = mkdtempSync(join(tmpdir(), 'noodle-cli-home-'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(
        await run(
          [
            'service',
            'events',
            '--service',
            'https://svc.example',
            '--capability',
            'audit',
            '--org',
            'acme',
            '--event-type',
            'config.secret.set',
            '--limit',
            '5',
          ],
          {},
          home,
        ),
      ).toBe(2);
      expect(errorSpy.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
        'Unknown subcommand',
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('initializes a service profile config', async () => {
    const cwd = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), 'noodle-service-init-'));
    const home = mkdtempSync(join(tmpdir(), 'noodle-cli-home-'));
    process.chdir(dir);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await run(['service', 'init', '--profile', 'enterprise-governed'], {}, home)).toBe(0);
      const config = readFileSync(join(dir, 'noodle.service.yaml'), 'utf8');
      expect(config).toContain('profile: enterprise-governed');
      expect(config).toContain('audit:');
      expect(config).toContain('controls:');
      expect(logSpy.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
        'noodle.service.yaml',
      );
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('service init is idempotent: re-running on an identical config is a no-op exit 0', async () => {
    const cwd = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), 'noodle-service-init-'));
    const home = mkdtempSync(join(tmpdir(), 'noodle-cli-home-'));
    process.chdir(dir);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await run(['service', 'init', '--profile', 'open-core'], {}, home)).toBe(0);
      const first = readFileSync(join(dir, 'noodle.service.yaml'), 'utf8');
      logSpy.mockClear();

      // No --force needed; an unchanged config reconciles to a quiet no-op.
      expect(await run(['service', 'init', '--profile', 'open-core'], {}, home)).toBe(0);
      expect(readFileSync(join(dir, 'noodle.service.yaml'), 'utf8')).toBe(first);
      expect(logSpy.mock.calls.map((call) => String(call[0])).join('\n')).toMatch(/unchanged/);
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('service init refuses to overwrite a modified config without --force', async () => {
    const cwd = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), 'noodle-service-init-'));
    const home = mkdtempSync(join(tmpdir(), 'noodle-cli-home-'));
    process.chdir(dir);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await run(['service', 'init', '--profile', 'open-core'], {}, home)).toBe(0);
      writeFileSync(join(dir, 'noodle.service.yaml'), 'profile: open-core\n# my edits\n');

      expect(await run(['service', 'init', '--profile', 'open-core'], {}, home)).toBe(2);
      expect(readFileSync(join(dir, 'noodle.service.yaml'), 'utf8')).toContain('# my edits');
      expect(errorSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('--force');

      expect(await run(['service', 'init', '--profile', 'open-core', '--force'], {}, home)).toBe(0);
      expect(readFileSync(join(dir, 'noodle.service.yaml'), 'utf8')).not.toContain('# my edits');
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('initializes the compatible open-core Compose profile without printing secrets', async () => {
    const cwd = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), 'noodle-service-compose-init-'));
    const home = mkdtempSync(join(tmpdir(), 'noodle-cli-home-'));
    writeFileSync(
      join(dir, 'package.json'),
      '{"name":"noodle-core","private":true,"noodleCore":{"composeInitVersion":1}}\n',
    );
    process.chdir(dir);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await run(['service', 'init', '--profile', 'open-core', '--compose'], {}, home)).toBe(
        0,
      );
      expect(errorSpy).not.toHaveBeenCalled();

      const env = readFileSync(join(dir, '.self-host', '.env'), 'utf8');
      const printed = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(printed).toContain('created .self-host/.env');
      expect(printed).toContain('created .self-host/compose.generated.yaml');
      expect(printed).toContain('created noodle.service.yaml');
      expect(
        printed
          .trimEnd()
          .endsWith(
            'docker compose up --build --wait postgres noodle && docker compose run --build --rm bootstrap',
          ),
      ).toBe(true);
      for (const key of [
        'POSTGRES_PASSWORD',
        'DATABASE_URL',
        'NOODLE_SECRET_MASTER_KEY',
        'NOODLE_SELF_HOST_ADMIN_TOKEN',
        'NOODLE_ASSET_IDENTITY_SALT',
      ]) {
        const line = env.split('\n').find((entry) => entry.startsWith(`${key}=`));
        expect(line).toBeDefined();
        expect(printed).not.toContain(line?.slice(line.indexOf('=') + 1));
      }
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.each([
    {
      args: ['service', 'init', '--profile', 'enterprise-governed', '--compose'],
      message: '--compose requires --profile open-core',
    },
    {
      args: ['service', 'init', '--profile', 'open-core', '--replace-secrets'],
      message: '--replace-secrets requires --compose',
    },
    {
      args: ['service', 'init', '--profile', 'open-core', '--compose', 'extra'],
      message: 'does not accept positional arguments',
    },
    {
      args: ['service', 'init', '--profile', 'open-core', '--compose', '--unknown'],
      message: 'unknown option: --unknown',
    },
  ])('rejects an invalid Compose init invocation: $message', async ({ args, message }) => {
    const dir = mkdtempSync(join(tmpdir(), 'noodle-service-compose-invalid-'));
    const home = mkdtempSync(join(tmpdir(), 'noodle-cli-home-'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    chdirIsolated(dir);
    try {
      expect(await run(args, {}, home)).toBe(2);
      expect(errorSpy.mock.calls.map((call) => String(call[0])).join('\n')).toContain(message);
    } finally {
      restoreCwd();
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('service doctor fails clearly when YAML and TypeScript service configs conflict', async () => {
    const cwd = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), 'noodle-service-doctor-'));
    const home = mkdtempSync(join(tmpdir(), 'noodle-cli-home-'));
    process.chdir(dir);
    writeFileSync(join(dir, 'noodle.service.yaml'), 'profile: open-core\n');
    writeFileSync(join(dir, 'noodle.service.ts'), 'export default {};\n');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await run(['service', 'doctor'], {}, home)).toBe(1);
      const printed = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(printed).toContain('FAIL Service config');
      expect(printed).toContain('Cause: Both noodle.service.yaml and noodle.service.ts exist');
      expect(printed).toContain('Next: noodle service doctor --config yaml');
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('service doctor verifies the managed asset edge when requested', async () => {
    const home = mkdtempSync(join(tmpdir(), 'noodle-cli-home-'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const seen: string[] = [];
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      seen.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/v1/auth')) return Response.json({ ok: true });
      if (url.endsWith('/v1/orgs/acme/apps/media/envs/prod/assets/preflight')) {
        const request = JSON.parse(String(init?.body)) as { assets: Array<{ sourcePath: string }> };
        expect(request.assets[0]?.sourcePath).toBe('assets/__doctor.png');
        return Response.json({
          ok: true,
          assetOrigin: 'https://assets.example.test',
          assets: [
            {
              logicalId: 'doctor_asset',
              sourcePath: 'assets/__doctor.png',
              contentHash: 'sha256:abc',
              mimeType: 'image/png',
              byteLength: 68,
              width: 1,
              height: 1,
              objectKey: 'aaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbb/cccccccccccccccc/abc/doctor_asset',
              publicUrl:
                'https://assets.example.test/aaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbb/cccccccccccccccc/abc/doctor_asset',
            },
          ],
          uploads: [
            {
              logicalId: 'doctor_asset',
              uploadUrl: 'https://assets.example.test/__noodle/asset-upload',
              method: 'PUT',
              headers: { authorization: 'Bearer signed', 'content-type': 'image/png' },
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
          ],
        });
      }
      if (url === 'https://assets.example.test/__noodle/asset-upload') {
        expect(init?.method).toBe('PUT');
        expect((init?.headers as Record<string, string>).authorization).toBe('Bearer signed');
        return new Response(null, { status: 201 });
      }
      if (url.includes('/doctor_asset')) {
        return new Response(null, {
          status: 200,
          headers: {
            'content-type': 'image/png',
            'content-length': '68',
            'cache-control': 'public, max-age=31536000, immutable',
            'x-content-type-options': 'nosniff',
            etag: '"abc"',
          },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    try {
      expect(
        await run(
          [
            'service',
            'doctor',
            '--assets',
            '--service',
            'https://cloud.example.test',
            '--auth-token',
            'token',
            '--org',
            'acme',
            '--app',
            'media',
            '--env',
            'prod',
          ],
          {},
          home,
        ),
      ).toBe(0);
      const printed = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(printed).toContain('PASS Asset service: preflight accepted');
      expect(printed).toContain('PASS Asset upload: synthetic image uploaded');
      expect(printed).toContain('PASS Asset edge: https://assets.example.test');
      expect(printed).not.toContain('token');
      expect(seen).toContain(
        'POST https://cloud.example.test/v1/orgs/acme/apps/media/envs/prod/assets/preflight',
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
