import { describe, expect, it, vi } from 'vitest';
import { checkDocsMcp } from '../../../scripts/docs-mcp-smoke.mjs';

const SUCCESS_RESULT = {
  jsonrpc: '2.0',
  id: 1,
  result: {
    content: [
      {
        type: 'text',
        text: 'Quickstart\nURL: https://docs.noodleseed.dev/docs/quickstart',
      },
    ],
  },
};

describe('Docs MCP deployment smoke', () => {
  it('calls search_docs through the real modern MCP request contract', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json(SUCCESS_RESULT));

    await expect(checkDocsMcp('https://docs.test/', fetchImpl)).resolves.toEqual(
      SUCCESS_RESULT.result,
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://docs.test/mcp');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-method': 'tools/call',
      'mcp-name': 'search_docs',
      'mcp-protocol-version': '2026-07-28',
    });
    expect(JSON.parse(String(init.body))).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'search_docs',
        arguments: { query: 'deploy', limit: 1 },
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': {
            name: 'noodle-docs-deploy-smoke',
            version: '1.0.0',
          },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('fails immediately and generically when the served tool result is an error', async () => {
    const missingPath = 'content/private-marker.mdx';
    const fetchImpl = vi.fn().mockResolvedValue(
      Response.json({
        jsonrpc: '2.0',
        id: 1,
        result: {
          isError: true,
          content: [{ type: 'text', text: `ENOENT: ${missingPath}` }],
        },
      }),
    );
    const sleep = vi.fn(async () => undefined);

    await expect(checkDocsMcp('https://docs.test', fetchImpl, { sleep })).rejects.toThrow(
      'Docs MCP smoke failed',
    );
    try {
      await checkDocsMcp('https://docs.test', fetchImpl, { sleep });
    } catch (error) {
      expect(String(error)).not.toContain(missingPath);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('rejects a served response without non-empty text content', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        Response.json({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '' }] } }),
      );

    await expect(checkDocsMcp('https://docs.test', fetchImpl)).rejects.toThrow(
      'Docs MCP smoke failed',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries a cold revision but gives up after a bounded number of attempts', async () => {
    const sleep = vi.fn(async () => undefined);
    const coldStart = vi
      .fn()
      .mockRejectedValueOnce(new Error('timed out'))
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(Response.json(SUCCESS_RESULT));

    await expect(checkDocsMcp('https://docs.test', coldStart, { sleep })).resolves.toEqual(
      SUCCESS_RESULT.result,
    );
    expect(coldStart).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);

    const neverReady = vi.fn().mockRejectedValue(new Error('timed out'));
    await expect(checkDocsMcp('https://docs.test', neverReady, { sleep })).rejects.toThrow(
      'Docs MCP smoke failed',
    );
    expect(neverReady.mock.calls.length).toBeLessThanOrEqual(5);
  });
});
