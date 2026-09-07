import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import nextPackage from 'next/package.json' with { type: 'json' };
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { embedScaffoldFiles } from '../src/assistant-embed-scaffold-template.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const frameworkRequire = createRequire(import.meta.url);
const sdkRoot = join(repoRoot, 'packages/assistant');
const nextRoot = dirname(frameworkRequire.resolve('next/package.json'));

/** Run the installed host tool without blocking the test process or inheriting customer secrets. */
function command(
  bin: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-32_000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`host command timed out\n${output}`));
    }, 90_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error(`host command exited ${code}\n${output}`));
    });
  });
}

function write(dir: string, path: string, content: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}

describe('generated application profile in the real host framework', () => {
  it('builds all three Next.js profiles from packed SDK bytes and mounts them in Chromium', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noodle-next-profile-'));
    const browser = await chromium.launch({ headless: true });
    try {
      // Framework/test tools reuse their already installed, exact versions. The customer SDK is a tarball,
      // not a workspace link. Final System Release certification also proves public registry installation.
      const packed = JSON.parse(
        execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', root], {
          cwd: sdkRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      ) as Array<{ filename: string }>;
      const archive = join(root, packed[0]?.filename ?? 'missing-package');
      for (const surface of ['authenticated', 'public', 'mixed'] as const) {
        const dir = join(root, surface);
        const packageVersions: Record<string, string> = {};
        for (const name of [
          'next',
          'react',
          'react-dom',
          'typescript',
          '@types/node',
          '@types/react',
          '@types/react-dom',
          'vitest',
          'playwright',
        ]) {
          const packagePath = frameworkRequire.resolve(`${name}/package.json`);
          packageVersions[name] =
            name === 'next'
              ? nextPackage.version
              : JSON.parse(readFileSync(packagePath, 'utf8')).version;
          mkdirSync(dirname(join(dir, 'node_modules', name)), { recursive: true });
          symlinkSync(dirname(packagePath), join(dir, 'node_modules', name), 'dir');
        }
        const installedSdk = join(dir, 'node_modules/@noodleseed/assistant');
        mkdirSync(installedSdk, { recursive: true });
        execFileSync('tar', ['-xzf', archive, '-C', installedSdk, '--strip-components=1']);
        const sdkVersion = JSON.parse(
          readFileSync(join(installedSdk, 'package.json'), 'utf8'),
        ).version;
        write(
          dir,
          'package.json',
          JSON.stringify({
            private: true,
            type: 'module',
            dependencies: {
              ...packageVersions,
              '@noodleseed/assistant': sdkVersion,
            },
          }),
        );
        for (const [path, content] of Object.entries(embedScaffoldFiles('nextjs', surface)))
          write(dir, path, content);
        write(
          dir,
          'app/layout.tsx',
          `import type { ReactNode } from 'react';
export default function Layout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}`,
        );
        write(
          dir,
          'app/page.tsx',
          `'use client';
import { AssistantWidget } from '../components/noodle-assistant';
export default function Page() { return <main><h1>Customer application</h1><AssistantWidget ${
            surface === 'public'
              ? ''
              : surface === 'mixed'
                ? 'principalKey={null} onSignInRequested={() => {}}'
                : 'principalKey="fixture-user:fixture-tenant"'
          } /></main>; }
`,
        );
        write(dir, 'next.config.mjs', 'export default { experimental: { cpus: 1 } };');
        const env = {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          NEXT_TELEMETRY_DISABLED: '1',
          NOODLE_SERVICE_URL: 'https://cloud.example',
          PUBLIC_APP_ORIGIN: 'http://localhost:3000',
          NOODLE_ASSISTANT_CLIENT_ID: 'synthetic-client',
          NOODLE_ASSISTANT_CLIENT_SECRET: 'synthetic-server-credential',
          NEXT_PUBLIC_NOODLE_SERVICE_URL: 'https://cloud.example',
          NEXT_PUBLIC_NOODLE_EMBED_ID: 'synthetic-embed',
        };
        await command(
          process.execPath,
          [join(nextRoot, 'dist/bin/next'), 'build', '--webpack'],
          dir,
          env,
        );
        if (surface !== 'public') {
          await command(
            process.execPath,
            [
              join(dirname(frameworkRequire.resolve('vitest/package.json')), 'vitest.mjs'),
              'run',
              'test/noodle-assistant.test.ts',
            ],
            dir,
            env,
          );
        }
        const server = spawn(
          process.execPath,
          [join(nextRoot, 'dist/bin/next'), 'start', '--port', '0', '--hostname', '127.0.0.1'],
          {
            cwd: dir,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        try {
          const url = await new Promise<string>((resolve, reject) => {
            let output = '';
            const timer = setTimeout(
              () => reject(new Error(`host did not start\n${output}`)),
              15_000,
            );
            const collect = (chunk: Buffer) => {
              output += chunk.toString();
              const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
              if (match && output.includes('Ready')) {
                clearTimeout(timer);
                resolve(match[0]);
              }
            };
            server.stdout.on('data', collect);
            server.stderr.on('data', collect);
            server.once('error', (error) => {
              clearTimeout(timer);
              reject(error);
            });
            server.once('exit', (code) => {
              clearTimeout(timer);
              reject(new Error(`host exited ${code}\n${output}`));
            });
          });
          const page = await browser.newPage();
          const errors: string[] = [];
          page.on('pageerror', (error) => errors.push(error.message));
          await page.route('https://cloud.example/**', (route) =>
            route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }),
          );
          await page.goto(url);
          await page.waitForFunction(() =>
            Boolean(
              customElements.get('noodle-assistant') &&
                document.querySelector('noodle-assistant')?.shadowRoot,
            ),
          );
          expect(await page.locator('h1').textContent()).toBe('Customer application');
          expect(errors).toEqual([]);
          const html = await page.content();
          expect(html).not.toContain('synthetic-server-credential');
          await page.close();
          await command(process.execPath, ['--test', 'test/noodle-assistant.browser.mjs'], dir, {
            ...env,
            PUBLIC_APP_ORIGIN: url,
          });
        } finally {
          server.kill('SIGTERM');
          await new Promise<void>((resolve) => {
            if (server.exitCode !== null || server.signalCode !== null) resolve();
            else server.once('exit', () => resolve());
          });
        }
      }
    } finally {
      await browser.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 300_000);
});
