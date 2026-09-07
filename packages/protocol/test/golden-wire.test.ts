import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createDualEraMcpHandler,
  handleStatelessHttp,
  type ProtocolRequestContext,
  type ServedArtifact,
} from '../src/index.js';
import { goldenTarget } from './golden-target.js';
import { modernRpc } from './v2-harness.js';

const LEGACY_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
  '2024-10-07',
] as const;
const here = dirname(fileURLToPath(import.meta.url));
const contractDir = join(here, '..', '..', '..', 'contract', 'mcp', '2025-11-25');
const modernContractDir = join(here, '..', '..', '..', 'contract', 'mcp', '2026-07-28');

const requestHeaders = (version: string) => ({
  accept: 'application/json, text/event-stream',
  'content-type': 'application/json',
  'mcp-protocol-version': version,
});

async function withGoldenServer<T>(
  target: ServedArtifact,
  run: (url: string) => Promise<T>,
  context: ProtocolRequestContext = {},
): Promise<T> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      void handleStatelessHttp(target, req, res, JSON.parse(body), context);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${port}/mcp`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
}

async function rpc(url: string, body: unknown, version = '2025-11-25') {
  const response = await fetch(url, {
    method: 'POST',
    headers: requestHeaders(version),
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    body: text,
  };
}

function body(method: string, params: unknown, id = 1) {
  return { jsonrpc: '2.0', id, method, params };
}

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(contractDir, `${name}.json`), 'utf8'));
}

function modernFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(modernContractDir, `${name}.json`), 'utf8'));
}

function wireSnapshot(
  response: Awaited<ReturnType<typeof rpc>>,
  options: { widgetBody?: boolean } = {},
): unknown {
  if (!options.widgetBody) return response;
  const json = JSON.parse(response.body);
  const item = json.result?.contents?.[0];
  const text = typeof item?.text === 'string' ? item.text : '';
  if (item !== undefined) {
    item.text = {
      byteLength: Buffer.byteLength(text),
      sha256: createHash('sha256').update(text).digest('hex'),
    };
  }
  return {
    status: response.status,
    contentType: response.contentType,
    bodyByteLength: Buffer.byteLength(response.body),
    bodySha256: createHash('sha256').update(response.body).digest('hex'),
    json,
  };
}

async function expectGolden(
  name: string,
  response: Awaited<ReturnType<typeof rpc>>,
  options: { widgetBody?: boolean } = {},
): Promise<void> {
  const actual = wireSnapshot(response, options);
  expect(actual).toEqual(fixture(name));
}

describe('frozen MCP 2025-11-25 wire', () => {
  it('pins initialize, discovery, calls, interactions, widgets, prompts, and legacy errors', async () => {
    await withGoldenServer(goldenTarget(), async (url) => {
      await expectGolden(
        'initialize-result',
        await rpc(
          url,
          body('initialize', {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'golden-client', version: '1.0.0' },
          }),
        ),
      );
      await expectGolden('tools-list', await rpc(url, body('tools/list', {})));
      await expectGolden(
        'tools-call-complete',
        await rpc(url, body('tools/call', { name: 'open_ticket', arguments: { subject: 'Help' } })),
      );
      await expectGolden(
        'tools-call-interaction-unavailable',
        await rpc(url, body('tools/call', { name: 'choose_team', arguments: {} })),
      );
      await expectGolden(
        'resources-read-widget',
        await rpc(url, body('resources/read', { uri: 'ui://golden_server/ticket_card' })),
        { widgetBody: true },
      );
      await expectGolden(
        'prompts-get',
        await rpc(url, body('prompts/get', { name: 'triage', arguments: { id: 'T-7' } })),
      );
      await expectGolden(
        'error-resource-not-found',
        await rpc(url, body('resources/read', { uri: 'missing://resource' })),
      );
      await expectGolden(
        'error-invalid-params',
        await rpc(url, body('tools/call', { name: 'open_ticket', arguments: {} })),
      );
    });

    await withGoldenServer(goldenTarget({ restricted: true }), async (url) => {
      await expectGolden(
        'error-tool-auth-denied',
        await rpc(url, body('tools/call', { name: 'open_ticket', arguments: { subject: 'Help' } })),
      );
    });
  });

  it.each(LEGACY_VERSIONS)('continues to initialize, list, and call under %s', async (version) => {
    await withGoldenServer(goldenTarget(), async (url) => {
      const initialized = JSON.parse(
        (
          await rpc(
            url,
            body('initialize', {
              protocolVersion: version,
              capabilities: {},
              clientInfo: { name: 'compat-client', version: '1.0.0' },
            }),
            version,
          )
        ).body,
      );
      const listed = JSON.parse((await rpc(url, body('tools/list', {}), version)).body);
      const called = JSON.parse(
        (
          await rpc(
            url,
            body('tools/call', { name: 'open_ticket', arguments: { subject: 'Help' } }),
            version,
          )
        ).body,
      );

      expect(initialized.result.protocolVersion).toBe(version);
      expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
        'open_ticket',
        'choose_team',
      ]);
      expect(called.result.structuredContent).toEqual({ ticket: 'T-100' });
    });
  });
});

function modernWireSnapshot(
  response: Awaited<ReturnType<typeof modernRpc>>,
  options: { state?: boolean; widget?: boolean } = {},
): unknown {
  const json = structuredClone(response.json);
  const result = json.result as Record<string, unknown> | undefined;
  if (options.state && typeof result?.requestState === 'string') {
    result.requestState = '<sealed-request-state>';
  }
  if (options.widget) {
    const contents = result?.contents as Array<Record<string, unknown>> | undefined;
    const text = contents?.[0]?.text;
    if (typeof text === 'string') {
      contents[0] = {
        ...contents[0],
        text: {
          byteLength: Buffer.byteLength(text),
          sha256: createHash('sha256').update(text).digest('hex'),
        },
      };
    }
  }
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    json,
  };
}

async function expectModernGolden(
  name: string,
  response: Awaited<ReturnType<typeof modernRpc>>,
  options: { state?: boolean; widget?: boolean } = {},
): Promise<void> {
  expect(modernWireSnapshot(response, options)).toEqual(modernFixture(name));
}

describe('spec-derived MCP 2026-07-28 wire', () => {
  it('pins discovery, calls, MRTR, widgets, and modern errors', async () => {
    const handler = createDualEraMcpHandler(goldenTarget(), {
      oauthClientCredentialsReady: true,
    });
    try {
      await expectModernGolden('server-discover', await modernRpc(handler, 'server/discover'));
      await expectModernGolden('tools-list', await modernRpc(handler, 'tools/list'));
      await expectModernGolden(
        'tools-call-complete',
        await modernRpc(handler, 'tools/call', {
          name: 'open_ticket',
          arguments: { subject: 'Help' },
        }),
      );
      await expectModernGolden(
        'tools-call-input-required',
        await modernRpc(
          handler,
          'tools/call',
          { name: 'choose_team', arguments: {} },
          { clientCapabilities: { elicitation: { form: {} } } },
        ),
        { state: true },
      );
      await expectModernGolden(
        'resources-read-widget',
        await modernRpc(
          handler,
          'resources/read',
          { uri: 'ui://golden_server/ticket_card' },
          { nameHeader: 'ui://golden_server/ticket_card' },
        ),
        { widget: true },
      );
      await expectModernGolden(
        'error-32020',
        await modernRpc(handler, 'tools/list', {}, { methodHeader: 'prompts/list' }),
      );
      await expectModernGolden(
        'error-32021',
        await modernRpc(handler, 'tools/call', {
          name: 'choose_team',
          arguments: {},
        }),
      );
      await expectModernGolden(
        'error-32022',
        await modernRpc(handler, 'tools/list', {}, { version: '2099-01-01' }),
      );
      await expectModernGolden(
        'error-32602-resource-not-found',
        await modernRpc(
          handler,
          'resources/read',
          { uri: 'missing://resource' },
          { nameHeader: 'missing://resource' },
        ),
      );
    } finally {
      await handler.close();
    }
  });
});
