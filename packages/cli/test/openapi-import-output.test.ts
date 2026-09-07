import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile, InMemoryCatalog } from '@noodle-borg/compiler';
import { compileConnectors } from '@noodle-borg/connector-defs';
import { executeTool, InMemoryConnectorRegistry } from '@noodle-borg/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runImport } from '../src/commands/import.js';
import { readDeployInput } from '../src/deploy.js';
import { run } from '../src/index.js';
import { importOpenApiProject } from '../src/openapi-import.js';
import { resolveLocalEntrypoint } from '../src/project.js';

const here = dirname(fileURLToPath(import.meta.url));

let home: string;
let output: string;
let outputRoot: string;
let specDir: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'noodle-import-output-home-'));
  // Keep ephemeral source outside the repository so parallel projection scans see a stable tree.
  outputRoot = mkdtempSync(join(tmpdir(), 'noodle-import-output-'));
  symlinkSync(resolve(here, '../../../node_modules'), join(outputRoot, 'node_modules'), 'dir');
  output = join(outputRoot, 'customer');
  mkdirSync(output);
  specDir = mkdtempSync(join(tmpdir(), 'noodle-import-output-spec-'));
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  rmSync(home, { recursive: true, force: true });
  rmSync(outputRoot, { recursive: true, force: true });
  rmSync(specDir, { recursive: true, force: true });
});

const TYPED_SPEC = `
openapi: 3.0.3
info: { title: Tickets, version: 1.0.0 }
servers:
  - url: https://tickets.example.com
paths:
  /tickets/{id}:
    get:
      operationId: getTicket
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
        - { name: verbose, in: query, schema: { type: string } }
        - { name: limit, in: query, schema: { type: integer } }
        - { name: mode, in: query, schema: { type: string, enum: [fast, slow] } }
        - { name: cursor, in: query, schema: { type: string, nullable: true } }
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                type: object
                required: [id, state]
                properties:
                  id: { type: string }
                  state: { type: string, enum: [open, closed] }
                  count: { type: integer }
                  total-count: { type: number }
                  deleted_at: { type: string, nullable: true }
                  tags: { type: array, items: { type: string } }
  /tickets:
    get:
      operationId: listTickets
      responses:
        "200": { description: ok }
`;

async function importTypedSpec(): Promise<string> {
  const spec = join(specDir, 'openapi.yaml');
  writeFileSync(spec, TYPED_SPEC);
  expect(
    await run(['import', 'openapi', spec, '--output', output, '--name', 'tickets'], {}, home),
  ).toBe(0);
  return readFileSync(resolveLocalEntrypoint(output) ?? '', 'utf8');
}

describe('import openapi typed output rendering', () => {
  it('returns exactly one structured success envelope for agent callers', async () => {
    const spec = join(specDir, 'openapi.yaml');
    writeFileSync(spec, TYPED_SPEC);
    expect(await runImport(['openapi', spec, '--output', output, '--json'])).toBe(0);
    expect(logSpy).toHaveBeenCalledOnce();
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
      ok: true,
      data: { output },
    });
  });

  it('escapes external text as data and refuses credential-bearing base URLs before writing', async () => {
    const spec = join(specDir, 'escaped.json');
    const document = {
      openapi: '3.1.0',
      servers: [{ url: 'https://api.example.com' }],
      paths: { "/ticket's": { get: { operationId: 'getTicket', responses: {} } } },
    };
    writeFileSync(spec, JSON.stringify(document));
    importOpenApiProject({ specPath: spec, output, name: "ticket's\nproject" });
    const input = await readDeployInput(resolveLocalEntrypoint(output) ?? '');
    expect(JSON.parse(input.connectors ?? '').connectors[0].operations.get_ticket.path).toBe(
      "/ticket's",
    );
    const original = readFileSync(resolveLocalEntrypoint(output) ?? '', 'utf8');
    expect(() =>
      importOpenApiProject({
        specPath: spec,
        output,
        name: 'tickets',
        force: true,
        baseUrl: 'https://user:password@api.example.com',
      }),
    ).toThrow(/without credentials/);
    expect(readFileSync(resolveLocalEntrypoint(output) ?? '', 'utf8')).toBe(original);
  });

  it('does not assume force when called programmatically on an unrelated directory', () => {
    const spec = join(specDir, 'openapi.yaml');
    writeFileSync(spec, TYPED_SPEC);
    writeFileSync(join(output, 'README.md'), 'customer work');
    expect(() => importOpenApiProject({ specPath: spec, output, name: 'tickets' })).toThrow(
      /not empty/,
    );
    expect(readFileSync(join(output, 'README.md'), 'utf8')).toBe('customer work');
    expect(existsSync(join(output, 'noodle.json'))).toBe(false);
  });
  it('writes the imported API at the ordinary project entrypoint, with its own offline test', async () => {
    const source = await importTypedSpec();
    expect(resolveLocalEntrypoint(output)).toBe(join(output, 'src/server.ts'));
    expect(existsSync(join(output, 'server.ts'))).toBe(false);
    expect(source).toContain('get_ticket');
    expect(source).not.toContain("tool('greet'");
    const test = readFileSync(join(output, 'test/server.test.ts'), 'utf8');
    expect(test).toContain('offline imported contract');
    expect(test).not.toContain('greet');
    expect(readFileSync(join(output, '.env.example'), 'utf8')).not.toContain('POSTS_API_ORIGIN');
  });

  it('preserves customer edits and rejects symlink destinations even with force', async () => {
    await importTypedSpec();
    const source = join(output, 'src/server.ts');
    writeFileSync(source, '// customer-owned edits\n');
    const options = { specPath: join(specDir, 'openapi.yaml'), output, name: 'tickets' };
    expect(() => importOpenApiProject(options)).toThrow(/modified|overwrite/);
    expect(readFileSync(source, 'utf8')).toBe('// customer-owned edits\n');
    rmSync(source);
    const external = join(specDir, 'customer.ts');
    writeFileSync(external, 'do not overwrite');
    symlinkSync(external, source);
    expect(() => importOpenApiProject({ ...options, force: true })).toThrow(/symbolic link/);
    expect(readFileSync(external, 'utf8')).toBe('do not overwrite');
  });

  it.each(['bearer', 'apiKey'])('keeps %s auth as a managed secret reference', async (kind) => {
    const spec = join(specDir, 'auth.json');
    writeFileSync(
      spec,
      JSON.stringify({
        openapi: '3.1.0',
        servers: [{ url: 'https://tickets.example.com/v1' }],
        security: [{ ApiToken: [] }],
        components: {
          securitySchemes: {
            ApiToken:
              kind === 'bearer'
                ? { type: 'http', scheme: 'bearer' }
                : { type: 'apiKey', in: 'header', name: 'x-api-key' },
          },
        },
        paths: { '/tickets': { get: { operationId: 'listTickets', responses: {} } } },
      }),
    );
    importOpenApiProject({ specPath: spec, output, name: 'tickets' });
    const input = await readDeployInput(resolveLocalEntrypoint(output) ?? '');
    const connectors = JSON.parse(input.connectors ?? '');
    expect(connectors.connectors[0].http.auth).toMatchObject({ kind, secret: 'API_TOKEN' });
    expect(connectors.connectors[0].http.allowedOrigins).toEqual(['https://tickets.example.com']);
    expect(readFileSync(join(output, '.env.example'), 'utf8')).toContain('API_TOKEN=');
  });
  it('renders typed Zod output from the response schema and keeps untyped fallbacks', async () => {
    const server = await importTypedSpec();

    expect(server).toContain('output: z.object({ value: z.object({');
    expect(server).toContain('id: z.string()');
    expect(server).toContain('state: z.enum(["open", "closed"])');
    expect(server).toContain('count: z.number().optional()');
    expect(server).toContain('"total-count": z.number().optional()');
    expect(server).toContain('deleted_at: z.string().nullable().optional()');
    expect(server).toContain('tags: z.array(z.string()).optional()');

    // listTickets has no JSON 2xx response: it keeps the untyped z.unknown() value shape.
    expect(server).toContain('output: z.object({ value: z.unknown() })');
  });

  it('renders lossless Zod operation input signatures instead of field maps', async () => {
    const server = await importTypedSpec();

    // Connector operations and tools both author the same lossless Zod input shape.
    const zodInput =
      'input: z.object({ id: z.string(), verbose: z.string().optional(), ' +
      'limit: z.number().int().optional(), mode: z.enum(["fast", "slow"]).optional(), ' +
      'cursor: z.string().nullable().optional() }).strict()';
    expect(server).toContain(zodInput);
    expect(server).toMatch(/get_ticket: \{[\s\S]*?input: z\.object\(/);
    expect(server).toMatch(/list_tickets: \{[\s\S]*?input: z\.object\(\{\}\)/);

    // Connector and tool both refer to the same schema, rather than redeclaring matching shapes.
    expect(server.match(/input: contracts\["get_ticket"\]\.input/g)).toHaveLength(2);
    expect(server.match(/output: contracts\["get_ticket"\]\.output/g)).toHaveLength(2);
    expect(server.match(/input: z\.object\(\{ id:/g)).toHaveLength(1);

    // The retired flat field-map language must not appear anywhere in generated code.
    expect(server).not.toMatch(/\{ type: '[a-z]+'(?:, required: true)? \}/);
  });

  it('round-trips the generated project through the local compile used by noodle validate', async () => {
    await importTypedSpec();

    const input = await readDeployInput(resolveLocalEntrypoint(output) ?? '');
    const catalog = compileConnectors(input.connectors ?? '');
    expect(catalog.ok, catalog.ok ? '' : JSON.stringify(catalog.errors)).toBe(true);
    if (!catalog.ok) return;
    // The connector operation signature keeps the lossless parameter types (integer stays integer).
    const operationInput = catalog.catalog[0]?.operations.get_ticket?.input as {
      properties?: Record<string, { type?: unknown; enum?: unknown }>;
    };
    expect(operationInput.properties?.limit?.type).toBe('integer');
    expect(operationInput.properties?.mode?.enum).toEqual(['fast', 'slow']);
    const compiled = compile(input.manifest, { catalog: new InMemoryCatalog(catalog.catalog) });
    expect(compiled.ok, compiled.ok ? '' : JSON.stringify(compiled.errors)).toBe(true);
    if (!compiled.ok) return;

    const getTicket = compiled.artifact.tools.find((tool) => tool.name === 'get_ticket');
    expect(getTicket?.inputSchema).toEqual({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      ...catalog.catalog[0]?.operations.get_ticket?.input,
    });
    expect(getTicket?.outputSchema).toEqual({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      ...catalog.catalog[0]?.operations.get_ticket?.output,
    });
    expect(getTicket?.outputSchema).toMatchObject({
      type: 'object',
      properties: {
        value: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            state: { type: 'string', enum: ['open', 'closed'] },
            count: { type: 'number' },
            tags: { type: 'array' },
          },
        },
      },
    });
  }, 20_000);

  it('executes a generated operation with the complete decoded JSON body as value', async () => {
    await importTypedSpec();

    const input = await readDeployInput(resolveLocalEntrypoint(output) ?? '');
    const connectorSource = JSON.parse(input.connectors ?? '') as {
      connectors: Array<{
        operations: Record<string, { fake?: { response: unknown } }>;
      }>;
    };
    const responseBody = { id: 'ticket-5', state: 'open' };
    const operation = connectorSource.connectors[0]?.operations.get_ticket;
    if (operation === undefined) throw new Error('expected generated get_ticket operation');
    operation.fake = { response: responseBody };

    const connectors = compileConnectors(JSON.stringify(connectorSource), { mode: 'fake' });
    expect(connectors.ok, connectors.ok ? '' : JSON.stringify(connectors.errors)).toBe(true);
    if (!connectors.ok) return;
    const compiled = compile(input.manifest, {
      catalog: new InMemoryCatalog(connectors.catalog),
    });
    expect(compiled.ok, compiled.ok ? '' : JSON.stringify(compiled.errors)).toBe(true);
    if (!compiled.ok) return;

    await expect(
      executeTool(
        compiled.artifact,
        'get_ticket',
        { id: '5' },
        {
          connectors: new InMemoryConnectorRegistry(connectors.connectors),
          broker: { getCredential: () => Promise.resolve({ token: 'unused' }) },
        },
      ),
    ).resolves.toMatchObject({ ok: true, output: { value: responseBody } });
  }, 20_000);
});
