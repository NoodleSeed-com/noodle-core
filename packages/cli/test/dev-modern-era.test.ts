import { dirname, join } from 'node:path';
import { renderProductSkillBundle } from '@noodle-borg/agent-kit';
import { compile } from '@noodle-borg/compiler';
import { describe, expect, it } from 'vitest';
import { readDeployInput } from '../src/deploy.js';
import { dev, localMcpCall } from '../src/dev.js';
import { startPreview } from '../src/devtools-preview.js';

const FIXTURES = join(import.meta.dirname, 'fixtures');

describe('local author-loop protocol negotiation', () => {
  it('compiles and renders an app-only helper from package-local authoring inputs', async () => {
    const manifestPath = join(FIXTURES, 'modern-guided/server.ts');
    const authored = await readDeployInput(manifestPath);
    const compiled = compile(authored.manifest, {
      localAssets: { rootDir: dirname(manifestPath), publicOrigin: 'http://127.0.0.1' },
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) throw new Error('modern guided fixture must compile');
    expect(compiled.appPackage).toBeDefined();
    if (compiled.appPackage === undefined) throw new Error('fixture must emit an App Package');

    const bundle = renderProductSkillBundle(compiled.appPackage);
    const reference = bundle.files.find(
      ({ target, path }) => target === 'codex' && path.endsWith('/references/mcp-surface.md'),
    )?.content;
    expect(reference).toContain(
      '`set_priority` | Re-prioritize a task from the list widget. | write | app only',
    );
    expect(reference).toContain('`list_today`');
    expect(bundle.files).toHaveLength(4);
  });

  it('automatically negotiates the modern era and reports the resolved version', async () => {
    const handle = await dev({
      manifestPath: join(FIXTURES, 'hello/server.ts'),
      app: 'hello-modern',
      interactive: false,
      watch: false,
      log: () => {},
    });
    try {
      const connected = await localMcpCall(handle.url, 'initialize', {});
      const listed = await localMcpCall(handle.url, 'tools/list', {});
      expect(connected).toMatchObject({
        status: 200,
        protocol: { era: 'modern', version: '2026-07-28' },
      });
      expect(listed).toMatchObject({
        status: 200,
        protocol: { era: 'modern', version: '2026-07-28' },
      });
      expect(
        (listed.body?.result as { tools?: Array<{ name: string }> } | undefined)?.tools,
      ).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'greet' })]));
    } finally {
      await handle.close();
    }
  });

  it('carries modern input-required state verbatim through a confirmation retry', async () => {
    const handle = await dev({
      manifestPath: join(FIXTURES, 'modern-guided/server.ts'),
      app: 'acme-tasks-modern',
      interactive: false,
      watch: false,
      log: () => {},
    });
    try {
      const first = await localMcpCall(handle.url, 'tools/call', {
        name: 'complete_task',
        arguments: { task: 'review_pr', title: 'Review the analytics pull request' },
      });
      const inputRequired = first.body?.result as
        | {
            resultType?: string;
            requestState?: string;
            inputRequests?: Record<string, unknown>;
          }
        | undefined;
      expect(inputRequired).toMatchObject({
        resultType: 'input_required',
        requestState: expect.any(String),
        inputRequests: { __noodle_confirmation: expect.any(Object) },
      });

      const requestState = inputRequired?.requestState;
      const completed = await localMcpCall(handle.url, 'tools/call', {
        name: 'complete_task',
        arguments: { task: 'review_pr', title: 'Review the analytics pull request' },
        requestState,
        inputResponses: {
          __noodle_confirmation: { action: 'accept', content: { confirm: true } },
        },
      });
      expect(completed.status).toBe(200);
      expect(completed.body?.result).toMatchObject({
        structuredContent: { task: 'review_pr' },
      });
      expect(completed.body?.result).not.toHaveProperty('requestState');
    } finally {
      await handle.close();
    }
  });

  it('automatically negotiates modern requests through the devtools HTTP proxy', async () => {
    const handle = await dev({
      manifestPath: join(FIXTURES, 'hello/server.ts'),
      app: 'hello-devtools-modern',
      interactive: false,
      watch: false,
      log: () => {},
    });
    const preview = await startPreview({
      mcpUrl: handle.url,
      theme: 'both',
      device: 'both',
    });
    try {
      const response = await fetch(new URL('/rpc', preview.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        result: {
          resultType: 'complete',
          tools: expect.arrayContaining([expect.objectContaining({ name: 'greet' })]),
        },
      });
    } finally {
      await preview.close();
      await handle.close();
    }
  });
});
