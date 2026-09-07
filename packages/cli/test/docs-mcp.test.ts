import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DOCS_MCP_NAME, docsMcpUrl, writeDocsMcpConfig } from '../src/commands/docs-mcp.js';
import { run } from '../src/index.js';

const readMcp = (dir: string): { mcpServers?: Record<string, { type?: string; url?: string }> } =>
  JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'));

describe('docsMcpUrl', () => {
  it('defaults to the public docs assistant endpoint and honors NOODLE_DOCS_MCP_URL', () => {
    expect(docsMcpUrl({})).toBe('https://docs.noodleseed.dev/mcp');
    expect(docsMcpUrl({ NOODLE_DOCS_MCP_URL: 'https://staging.example/mcp' })).toBe(
      'https://staging.example/mcp',
    );
    // A blank override falls back to the default rather than writing an empty URL.
    expect(docsMcpUrl({ NOODLE_DOCS_MCP_URL: '   ' })).toBe('https://docs.noodleseed.dev/mcp');
  });
});

describe('writeDocsMcpConfig', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'noodle-docs-mcp-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates .mcp.json with the docs assistant entry when absent', () => {
    const result = writeDocsMcpConfig(dir, { url: 'https://docs.noodleseed.dev/mcp' });
    expect(result.action).toBe('created');
    expect(result.name).toBe(DOCS_MCP_NAME);
    expect(readMcp(dir).mcpServers?.[DOCS_MCP_NAME]).toEqual({
      type: 'https',
      url: 'https://docs.noodleseed.dev/mcp',
    });
  });

  it('is idempotent: an identical entry is left unchanged', () => {
    writeDocsMcpConfig(dir, { url: 'https://docs.noodleseed.dev/mcp' });
    const again = writeDocsMcpConfig(dir, { url: 'https://docs.noodleseed.dev/mcp' });
    expect(again.action).toBe('unchanged');
  });

  it('updates our entry to a new url without dropping other servers', () => {
    writeFileSync(
      join(dir, '.mcp.json'),
      `${JSON.stringify({ mcpServers: { other: { type: 'https', url: 'https://other.example/mcp' } } }, null, 2)}\n`,
    );
    const result = writeDocsMcpConfig(dir, { url: 'https://docs.noodleseed.dev/mcp' });
    expect(result.action).toBe('created'); // our entry is newly added
    const servers = readMcp(dir).mcpServers ?? {};
    expect(servers.other).toEqual({ type: 'https', url: 'https://other.example/mcp' });
    expect(servers[DOCS_MCP_NAME]?.url).toBe('https://docs.noodleseed.dev/mcp');

    const changed = writeDocsMcpConfig(dir, { url: 'https://staging.example/mcp' });
    expect(changed.action).toBe('updated');
    expect(readMcp(dir).mcpServers?.[DOCS_MCP_NAME]?.url).toBe('https://staging.example/mcp');
    expect(readMcp(dir).mcpServers?.other).toBeDefined();
  });

  it('does not write anything under --dry-run', () => {
    const result = writeDocsMcpConfig(dir, {
      url: 'https://docs.noodleseed.dev/mcp',
      dryRun: true,
    });
    expect(result.action).toBe('would-add');
    expect(() => readMcp(dir)).toThrow(); // no file created
  });

  it('reports would-update under --dry-run when the entry exists with a different url', () => {
    writeDocsMcpConfig(dir, { url: 'https://docs.noodleseed.dev/mcp' });
    const result = writeDocsMcpConfig(dir, { url: 'https://staging.example/mcp', dryRun: true });
    expect(result.action).toBe('would-update');
    // dry-run must not mutate the existing entry
    expect(readMcp(dir).mcpServers?.[DOCS_MCP_NAME]?.url).toBe('https://docs.noodleseed.dev/mcp');
  });

  it('never clobbers a malformed .mcp.json the user owns', () => {
    writeFileSync(join(dir, '.mcp.json'), '{ not valid json');
    const result = writeDocsMcpConfig(dir, { url: 'https://docs.noodleseed.dev/mcp' });
    expect(result.action).toBe('unchanged');
    expect(readFileSync(join(dir, '.mcp.json'), 'utf8')).toBe('{ not valid json');
  });
});

describe('noodle init connects the docs assistant MCP', () => {
  let home: string;
  let dir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'noodle-init-home-'));
    dir = mkdtempSync(join(tmpdir(), 'noodle-init-docs-'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it('adds a noodle-docs entry to the project .mcp.json and reports it in --json', async () => {
    const code = await run(
      ['init', '--no-install', dir, '--json'],
      { NOODLE_DISABLE_UPDATE_CHECK: '1' },
      home,
    );
    expect(code).toBe(0);
    const body = JSON.parse(logSpy.mock.calls.map((c) => String(c[0])).join('\n')) as {
      data: { docsMcp?: { action: string; name: string; url: string } };
    };
    expect(body.data.docsMcp?.name).toBe(DOCS_MCP_NAME);
    expect(body.data.docsMcp?.action).toBe('created');
    expect(readMcp(dir).mcpServers?.[DOCS_MCP_NAME]?.url).toBe('https://docs.noodleseed.dev/mcp');
  });

  it('skips the docs MCP under --no-docs-mcp', async () => {
    const code = await run(
      ['init', '--no-install', dir, '--no-docs-mcp', '--json'],
      { NOODLE_DISABLE_UPDATE_CHECK: '1' },
      home,
    );
    expect(code).toBe(0);
    const body = JSON.parse(logSpy.mock.calls.map((c) => String(c[0])).join('\n')) as {
      data: { docsMcp?: unknown };
    };
    expect(body.data.docsMcp).toBeUndefined();
    expect(() => readMcp(dir)).toThrow();
  });

  it('skips the docs MCP under --no-agents (agent integration is off)', async () => {
    const code = await run(
      ['init', '--no-install', dir, '--no-agents', '--json'],
      { NOODLE_DISABLE_UPDATE_CHECK: '1' },
      home,
    );
    expect(code).toBe(0);
    const body = JSON.parse(logSpy.mock.calls.map((c) => String(c[0])).join('\n')) as {
      data: { docsMcp?: unknown };
    };
    expect(body.data.docsMcp).toBeUndefined();
  });
});
