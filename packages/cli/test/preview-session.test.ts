import { EventEmitter } from 'node:events';
import type { FSWatcher } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { DevHandle } from '../src/dev.js';
import type { DevtoolsDelegatedExchangeStatus } from '../src/devtools-delegated-exchange-state.js';
import type { EffectiveLocalTargetResolution } from '../src/local-target.js';
import {
  type PreviewSession,
  previewBannerLines,
  startPreviewSession,
} from '../src/preview-session.js';

const cleanup: Array<() => void | Promise<void>> = [];
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const stripAnsi = (value: string): string => value.replace(ANSI, '');
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

function watchHarness() {
  let listener:
    | ((event: 'rename' | 'change', filename: string | Buffer | null) => void)
    | undefined;
  const watcher = Object.assign(new EventEmitter(), { close: () => {} }) as FSWatcher;
  return {
    watchFactory: (
      _watchDir: string,
      next: (event: 'rename' | 'change', filename: string | Buffer | null) => void,
    ) => {
      listener = next;
      return watcher;
    },
    change: (filename: string) => listener?.('change', filename),
  };
}

function fakeHandle(
  reload: () => Promise<{ ok: boolean }> = async () => ({ ok: true }),
  localDelegatedExchange: () => DevtoolsDelegatedExchangeStatus | undefined = () => undefined,
): DevHandle {
  return {
    url: 'http://127.0.0.1:9/o/local/app/dev/mcp',
    origin: 'http://127.0.0.1:9',
    reload,
    customerAuth: () => undefined,
    assistantInstructions: () => undefined,
    delegatedCredentialSink: () => undefined,
    localDelegatedExchange,
    close: async () => {},
  } as unknown as DevHandle;
}

describe('preview session — startPreviewSession', () => {
  it('starts a preview server on the dev handle and closes cleanly', async () => {
    const watched = watchHarness();
    const session = await startPreviewSession({
      handle: fakeHandle(),
      watchDir: '/project/src',
      watchFactory: watched.watchFactory,
      theme: 'both',
      device: 'both',
      log: () => {},
    });
    cleanup.push(() => session.close());
    // The preview server is reachable and serves the harness.
    const html = await (await fetch(session.preview.url)).text();
    expect(html).toContain('Noodle Seed');
    expect(session.watching).toBe(true);
  });

  it('reloads the dev runtime when a watched source file changes', async () => {
    const watched = watchHarness();
    let reloads = 0;
    const session = await startPreviewSession({
      handle: fakeHandle(async () => {
        reloads += 1;
        return { ok: true };
      }),
      watchDir: '/project/src',
      watchFactory: watched.watchFactory,
      theme: 'both',
      device: 'both',
      log: () => {},
    });
    cleanup.push(() => session.close());
    watched.change('server.ts');
    for (let i = 0; i < 10 && reloads === 0; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(reloads).toBeGreaterThanOrEqual(1);
  });

  it('reads delegated status live after successful reload and preserves it after failed reload', async () => {
    const watched = watchHarness();
    let nextReloadSucceeds = true;
    let reloads = 0;
    let current: DevtoolsDelegatedExchangeStatus = {
      issuer: 'urn:noodleseed:devtools:before',
      jwks: { keys: [{ kty: 'RSA', n: 'before', e: 'AQAB' }] },
      trustChanged: false,
      bindings: [
        {
          bindingKey: `sha256:${'a'.repeat(64)}`,
          connectorId: 'crm',
          verified: false,
        },
      ],
    };
    const handle = fakeHandle(
      async () => {
        reloads += 1;
        if (!nextReloadSucceeds) return { ok: false };
        current = {
          ...current,
          issuer: 'urn:noodleseed:devtools:after',
          jwks: { keys: [{ kty: 'RSA', n: 'after', e: 'AQAB' }] },
          trustChanged: true,
        };
        return { ok: true };
      },
      () => current,
    );
    const session = await startPreviewSession({
      handle,
      watchDir: '/project/src',
      watchFactory: watched.watchFactory,
      theme: 'both',
      device: 'both',
      log: () => {},
    });
    cleanup.push(() => session.close());

    const initialHtml = await (await fetch(session.preview.url)).text();
    const parentCapability = initialHtml.match(/var RPC_CAPABILITY="([^"]+)"/u)?.[1];
    expect(parentCapability).toBeTruthy();
    const readStatus = async () =>
      (await (
        await fetch(new URL('/delegated-exchange/status', session.preview.url), {
          headers: { 'x-noodle-devtools-capability': parentCapability as string },
        })
      ).json()) as DevtoolsDelegatedExchangeStatus;
    expect((await readStatus()).issuer).toBe('urn:noodleseed:devtools:before');

    watched.change('server.ts');
    for (let i = 0; i < 20 && reloads < 1; i++) await new Promise((r) => setTimeout(r, 25));
    expect(reloads).toBe(1);
    expect(await readStatus()).toMatchObject({
      issuer: 'urn:noodleseed:devtools:after',
      trustChanged: true,
    });

    nextReloadSucceeds = false;
    watched.change('server.ts');
    for (let i = 0; i < 20 && reloads < 2; i++) await new Promise((r) => setTimeout(r, 25));
    expect(reloads).toBe(2);
    expect(await readStatus()).toMatchObject({
      issuer: 'urn:noodleseed:devtools:after',
      trustChanged: true,
    });
  });

  it('never runs two reloads concurrently even when a save lands mid-reload (single-flight)', async () => {
    const watched = watchHarness();
    let active = 0;
    let maxConcurrent = 0;
    let reloads = 0;
    const session = await startPreviewSession({
      handle: fakeHandle(async () => {
        active += 1;
        maxConcurrent = Math.max(maxConcurrent, active);
        reloads += 1;
        await new Promise((r) => setTimeout(r, 400)); // slow deploy — a second save can land here
        active -= 1;
        return { ok: true };
      }),
      watchDir: '/project/src',
      watchFactory: watched.watchFactory,
      theme: 'both',
      device: 'both',
      log: () => {},
    });
    cleanup.push(() => session.close());
    watched.change('a.ts');
    for (let i = 0; i < 10 && active === 0; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(reloads).toBeGreaterThanOrEqual(1);
    watched.change('b.ts'); // save during the in-flight reload
    for (let i = 0; i < 40 && (active > 0 || reloads < 2); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    // The invariant: reloads are serialized — deploy() is never entered concurrently.
    expect(maxConcurrent).toBeLessThanOrEqual(1);
    expect(reloads).toBe(2);
    expect(active).toBe(0);
  });
});

describe('preview session — previewBannerLines', () => {
  const stub = (watching: boolean, envKeys: string[] = [], file?: string): PreviewSession =>
    ({
      preview: { url: 'http://127.0.0.1:7890/' },
      loadedEnv: { keys: envKeys, ...(file ? { file } : {}) },
      watching,
    }) as unknown as PreviewSession;

  const banner = (
    session: PreviewSession,
    extra: {
      theme?: string;
      device?: string;
      watchDir?: string;
      localTarget?: EffectiveLocalTargetResolution;
    } = {},
  ): string =>
    stripAnsi(
      previewBannerLines(session, {
        title: 'noodle dev',
        mcpUrl: 'http://127.0.0.1:1/o/l/a/dev/mcp',
        theme: extra.theme ?? 'both',
        device: extra.device ?? 'both',
        watchDir: extra.watchDir ?? '/proj/src',
        localTarget: extra.localTarget ?? {
          target: { org: 'local', app: 'customer-auth-demo', env: 'dev' },
          mode: 'unlinked',
          sources: { org: 'local-default', app: 'project', env: 'local-default' },
          ignoredSavedTarget: false,
        },
      }).join('\n'),
    );

  it('includes the title, urls, view line, and a watching line', () => {
    const out = banner(stub(true), { device: 'desktop' });
    expect(out).toContain('noodle dev');
    expect(out).toContain('http://127.0.0.1:7890/'); // preview url
    expect(out).toContain('http://127.0.0.1:1/o/l/a/dev/mcp'); // mcp url
    expect(out).toContain('device desktop');
    expect(out).toContain('/proj/src');
  });

  it('presents an unlinked local target and recovery hint without saved values', () => {
    const out = banner(stub(false), {
      localTarget: {
        target: { org: 'local', app: 'customer-auth-demo', env: 'dev' },
        mode: 'unlinked',
        sources: { org: 'local-default', app: 'project', env: 'local-default' },
        ignoredSavedTarget: true,
      },
    });
    expect(out).toContain('target   local/customer-auth-demo/dev (unlinked project)');
    expect(out).toContain(
      'Saved global target ignored for this unlinked local project. Run `noodle link` to mirror a deployed app.',
    );
    expect(out).not.toMatch(/hosted-org|other-app|prod/u);
  });

  it('presents a linked target without the unlinked recovery hint', () => {
    const out = banner(stub(false), {
      localTarget: {
        target: { org: 'acme', app: 'support', env: 'prod' },
        mode: 'linked',
        sources: { org: 'link', app: 'link', env: 'link' },
        ignoredSavedTarget: false,
      },
    });
    expect(out).toContain('target   acme/support/prod (project link)');
    expect(out).not.toContain('Saved global target ignored');
  });

  it('omits the watching line when the watcher is not running', () => {
    expect(banner(stub(false))).not.toContain('edit + save to hot-reload');
  });

  it('notes the .env.local source when the key was auto-loaded from a file', () => {
    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-x';
    try {
      expect(banner(stub(false, ['OPENAI_API_KEY'], '.env.local'))).toContain('from .env.local');
    } finally {
      if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
      else delete process.env.OPENAI_API_KEY;
    }
  });

  it('prompts to add a key in the Chat tab when no server key is set', () => {
    const previous = {
      openai: process.env.OPENAI_API_KEY,
      anthropic: process.env.ANTHROPIC_API_KEY,
      gemini: process.env.GEMINI_API_KEY,
    };
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      expect(banner(stub(false))).toContain('add an API key in Chat · OpenAI, Claude, or Gemini');
    } finally {
      if (previous.openai !== undefined) process.env.OPENAI_API_KEY = previous.openai;
      if (previous.anthropic !== undefined) process.env.ANTHROPIC_API_KEY = previous.anthropic;
      if (previous.gemini !== undefined) process.env.GEMINI_API_KEY = previous.gemini;
    }
  });
});
