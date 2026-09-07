import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { compile, InMemoryCatalog } from '@noodle-borg/compiler';
import { compileConnectors } from '@noodle-borg/connector-defs';
import { type ProbeMcpOptions, snapshotFromTools } from '@noodle-borg/openapi-import';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runImport } from '../src/commands/project-setup.js';
import { readDeployInput } from '../src/deploy.js';
import { checkMcpProject, importMcpProject } from '../src/mcp-import.js';
import { resolveLocalEntrypoint } from '../src/project.js';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function outputDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'noodle-mcp-import-'));
  roots.push(root);
  return join(root, 'generated');
}

function compilableOutputDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'noodle-mcp-import-'));
  roots.push(root);
  symlinkSync(
    resolve(import.meta.dirname, '../../../node_modules'),
    join(root, 'node_modules'),
    'dir',
  );
  return join(root, 'generated');
}

function fixture(options: ProbeMcpOptions, extra = false) {
  return snapshotFromTools({
    endpoint: options.endpoint,
    name: options.name,
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    ...(options.auth === undefined ? {} : { auth: options.auth }),
    tools: [
      {
        name: 'search-products',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: { products: { type: 'array' } },
          required: ['products'],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
      },
      ...(extra
        ? [
            {
              name: 'create-cart',
              inputSchema: { type: 'object' as const, properties: {} },
              outputSchema: { type: 'object' as const, properties: {} },
              annotations: { readOnlyHint: false },
            },
          ]
        : []),
    ],
  });
}

describe('MCP project import', () => {
  it('writes frozen TypeScript and metadata without persisting endpoint or import credentials', async () => {
    const output = outputDir();
    const probe = vi.fn(async (options: ProbeMcpOptions) => fixture(options));
    const result = await importMcpProject(
      {
        endpoint: 'https://shop.example/api/mcp',
        output,
        name: 'shopify-storefront',
        prefix: 'store',
        headers: { authorization: 'Bearer import-only-secret' },
        auth: { kind: 'bearer', secretRef: 'SHOPIFY_TOKEN' },
      },
      { probe },
    );

    const source = readFileSync(resolveLocalEntrypoint(output) ?? '', 'utf8');
    expect(resolveLocalEntrypoint(output)).toBe(join(output, 'src/server.ts'));
    expect(readFileSync(join(output, 'test/server.test.ts'), 'utf8')).toContain(
      'offline imported contract',
    );
    const snapshot = readFileSync(join(output, '.noodle', 'mcp-import.json'), 'utf8');
    expect(result.snapshot.prefix).toBe('store');
    expect(source).toContain('store_search_products');
    expect(source).toContain('variable("SHOPIFY_STOREFRONT_MCP_ENDPOINT")');
    expect(source).toContain('secret("SHOPIFY_TOKEN")');
    expect(source).not.toContain('https://shop.example');
    expect(`${source}\n${snapshot}`).not.toContain('import-only-secret');
    expect(probe).toHaveBeenCalledOnce();
  });

  it('round-trips generated source through the same compiler used by validate and deploy', async () => {
    const output = compilableOutputDir();
    await importMcpProject(
      { endpoint: 'https://shop.example/api/mcp', output, name: 'shopify-storefront' },
      { probe: async (options) => fixture(options, true) },
    );

    const input = await readDeployInput(resolveLocalEntrypoint(output) ?? '');
    const connectors = compileConnectors(input.connectors ?? '');
    expect(connectors.ok, connectors.ok ? '' : JSON.stringify(connectors.errors)).toBe(true);
    if (!connectors.ok) return;
    const compiled = compile(input.manifest, {
      catalog: new InMemoryCatalog(connectors.catalog),
    });
    expect(compiled.ok, compiled.ok ? '' : JSON.stringify(compiled.errors)).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.artifact.tools.map((tool) => tool.name)).toEqual([
      'create_cart',
      'search_products',
    ]);
  }, 20_000);

  it('checks drift without writing and reuses the frozen operation prefix', async () => {
    const output = outputDir();
    await importMcpProject(
      {
        endpoint: 'https://shop.example/api/mcp',
        output,
        name: 'shopify',
        prefix: 'store',
      },
      { probe: async (options) => fixture(options) },
    );
    const beforeSource = readFileSync(resolveLocalEntrypoint(output) ?? '', 'utf8');
    let observedPrefix: string | undefined;
    const result = await checkMcpProject(
      { endpoint: 'https://shop.example/api/mcp', output, name: 'ignored' },
      {
        probe: async (options) => {
          observedPrefix = options.prefix;
          return fixture(options, true);
        },
      },
    );

    expect(observedPrefix).toBe('store');
    expect(result).toEqual({
      changed: true,
      lines: ['additive: added tool: create-cart'],
    });
    expect(readFileSync(resolveLocalEntrypoint(output) ?? '', 'utf8')).toBe(beforeSource);
  });

  it('parses secret-valued headers from the environment without printing or storing the value', async () => {
    const output = outputDir();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const result = await runImport(
      [
        'mcp',
        'https://shop.example/api/mcp',
        '--output',
        output,
        '--name',
        'shopify',
        '--header-env',
        'Authorization=SHOPIFY_IMPORT_TOKEN',
        '--json',
      ],
      { SHOPIFY_IMPORT_TOKEN: 'never-persist-me' },
      { probe: async (options) => fixture(options) },
    );

    expect(result).toBe(0);
    expect(JSON.stringify(log.mock.calls)).not.toContain('never-persist-me');
    expect(readFileSync(join(output, '.noodle', 'mcp-import.json'), 'utf8')).not.toContain(
      'never-persist-me',
    );
  });

  it('refuses to overwrite a generated source unless force is explicit', async () => {
    const output = outputDir();
    const probe = async (options: ProbeMcpOptions) => fixture(options);
    await importMcpProject(
      { endpoint: 'https://shop.example/api/mcp', output, name: 'shopify' },
      { probe },
    );
    await expect(
      importMcpProject(
        { endpoint: 'https://shop.example/api/mcp', output, name: 'shopify' },
        { probe },
      ),
    ).rejects.toThrow(/refusing to overwrite/);
  });

  it('rejects unknown, missing, cross-kind, and conflicting options', async () => {
    expect(await runImport(['mcp', 'https://shop.example/mcp', '--unknown'], {}, {})).toBe(2);
    expect(await runImport(['mcp', 'https://shop.example/mcp', '--output'], {}, {})).toBe(2);
    expect(
      await runImport(
        ['mcp', 'https://shop.example/mcp', '--base-url', 'https://api.example'],
        {},
        {},
      ),
    ).toBe(2);
    expect(await runImport(['mcp', 'https://shop.example/mcp', '--check', '--force'], {}, {})).toBe(
      2,
    );
  });

  it('returns one JSON usage envelope when the MCP endpoint is missing', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await runImport(['mcp', '--json'], {}, {})).toBe(2);
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: { code: 'invalid_import_options' },
    });
  });

  it('rejects import credential values that could inject another header', async () => {
    const output = outputDir();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await runImport(
      [
        'mcp',
        'https://shop.example/api/mcp',
        '--output',
        output,
        '--header-env',
        'Authorization=SHOPIFY_IMPORT_TOKEN',
      ],
      { SHOPIFY_IMPORT_TOKEN: 'secret\r\nx-injected: true' },
      { probe: async (options) => fixture(options) },
    );
    expect(result).toBe(1);
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret');
  });
});
