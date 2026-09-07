import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createDualEraMcpHandler } from '../src/v2/handler.js';
import { goldenTarget } from './golden-target.js';

const here = dirname(fileURLToPath(import.meta.url));
const contractDir = join(here, '..', '..', '..', 'contract', 'mcp', '2025-11-25');

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(contractDir, `${name}.json`), 'utf8'));
}

async function rpc(
  handler: ReturnType<typeof createDualEraMcpHandler>,
  method: string,
  params: Record<string, unknown>,
) {
  const response = await handler.fetch(
    new Request('https://mcp.test/endpoint', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-11-25',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  );
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    body: await response.text(),
  };
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
  expect(wireSnapshot(response, options)).toEqual(fixture(name));
}

describe('v2 handler legacy replay', () => {
  it('preserves every frozen 2025-11-25 response byte-for-byte', async () => {
    const handler = createDualEraMcpHandler(goldenTarget());
    try {
      await expectGolden(
        'initialize-result',
        await rpc(handler, 'initialize', {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'golden-client', version: '1.0.0' },
        }),
      );
      await expectGolden('tools-list', await rpc(handler, 'tools/list', {}));
      await expectGolden(
        'tools-call-complete',
        await rpc(handler, 'tools/call', {
          name: 'open_ticket',
          arguments: { subject: 'Help' },
        }),
      );
      await expectGolden(
        'tools-call-interaction-unavailable',
        await rpc(handler, 'tools/call', { name: 'choose_team', arguments: {} }),
      );
      await expectGolden(
        'resources-read-widget',
        await rpc(handler, 'resources/read', { uri: 'ui://golden_server/ticket_card' }),
        { widgetBody: true },
      );
      await expectGolden(
        'prompts-get',
        await rpc(handler, 'prompts/get', {
          name: 'triage',
          arguments: { id: 'T-7' },
        }),
      );
      await expectGolden(
        'error-resource-not-found',
        await rpc(handler, 'resources/read', { uri: 'missing://resource' }),
      );
      await expectGolden(
        'error-invalid-params',
        await rpc(handler, 'tools/call', { name: 'open_ticket', arguments: {} }),
      );
    } finally {
      await handler.close();
    }

    const restricted = createDualEraMcpHandler(goldenTarget({ restricted: true }));
    try {
      await expectGolden(
        'error-tool-auth-denied',
        await rpc(restricted, 'tools/call', {
          name: 'open_ticket',
          arguments: { subject: 'Help' },
        }),
      );
    } finally {
      await restricted.close();
    }
  });

  it.each([
    '2025-11-25',
    '2025-06-18',
    '2025-03-26',
    '2024-11-05',
    '2024-10-07',
  ])('keeps initialize/list/call compatibility for %s', async (version) => {
    const handler = createDualEraMcpHandler(goldenTarget());
    try {
      const initialized = await rpcForVersion(
        handler,
        'initialize',
        {
          protocolVersion: version,
          capabilities: {},
          clientInfo: { name: 'compat-client', version: '1.0.0' },
        },
        version,
      );
      const listed = await rpcForVersion(handler, 'tools/list', {}, version);
      const called = await rpcForVersion(
        handler,
        'tools/call',
        { name: 'open_ticket', arguments: { subject: 'Help' } },
        version,
      );
      expect(JSON.parse(initialized.body)).toMatchObject({
        result: { protocolVersion: version },
      });
      expect(JSON.parse(listed.body)).toHaveProperty('result.tools');
      expect(JSON.parse(called.body)).toMatchObject({
        result: { structuredContent: { ticket: 'T-100' } },
      });
    } finally {
      await handler.close();
    }
  });
});

async function rpcForVersion(
  handler: ReturnType<typeof createDualEraMcpHandler>,
  method: string,
  params: Record<string, unknown>,
  version: string,
) {
  const response = await handler.fetch(
    new Request('https://mcp.test/endpoint', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': version,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  );
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    body: await response.text(),
  };
}
