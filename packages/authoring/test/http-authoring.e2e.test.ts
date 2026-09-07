import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileManifest, InMemoryCatalog } from '../../compiler/src/index.js';
import { compileConnectors } from '../../connector-defs/src/index.js';
import {
  type ExecuteDeps,
  executeTool,
  InMemoryConnectorRegistry,
  MapServiceBroker,
} from '../../runtime/src/index.js';
import { connector, server, tool, when, z } from '../src/index.js';

// END-TO-END: author connectors with `.http()`/`.compute()`, then actually EXECUTE the authored server
// through the real compile + runtime + broker path against a local 127.0.0.1 echo server. No external
// network — this is the coverage the compile-only round-trip in http-authoring.test.ts cannot give.
// (HTTP engine internals, broker keying, and the secret deploy matrix are tested at their own layers.)

interface CapturedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: NodeJS.Dict<string | string[]>;
  body?: unknown;
}

let server1: Server;
let baseUrl = '';
let lastRequest: CapturedRequest;

/** httpbin-style echo: reflect the parsed body, the request headers (lowercased by Node), and the query. */
function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve({});
      }
    });
  });
}

function send(res: ServerResponse, payload: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

beforeAll(async () => {
  server1 = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const query = Object.fromEntries(url.searchParams.entries());
    if (req.method === 'POST') {
      void readJson(req).then((body) => {
        lastRequest = { method: 'POST', path: url.pathname, query, headers: req.headers, body };
        send(res, { json: body, headers: req.headers, args: query });
      });
      return;
    }
    lastRequest = { method: req.method ?? 'GET', path: url.pathname, query, headers: req.headers };
    send(res, { json: {}, headers: req.headers, args: query });
  });
  await new Promise<void>((resolve) => server1.listen(0, '127.0.0.1', resolve));
  const addr = server1.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server1.close((e) => (e ? reject(e) : resolve())));
});

/** Compile an authored server + execute one of its tools through the real runtime against `broker`. */
async function run(
  // biome-ignore lint/suspicious/noExplicitAny: the authored server type is the SDK's ServerDefinition.
  app: any,
  tool: string,
  input: unknown,
  broker: MapServiceBroker,
): Promise<unknown> {
  const catalog = app.toConnectorCatalog();
  if (!catalog) throw new Error('expected a catalog');
  const cc = compileConnectors(JSON.stringify(catalog));
  if (!cc.ok) throw new Error(`connector compile failed: ${JSON.stringify(cc.errors)}`);
  const compiled = compileManifest(await app.toManifest(), {
    catalog: new InMemoryCatalog(cc.catalog),
  });
  if (!compiled.ok) throw new Error(`manifest compile failed: ${JSON.stringify(compiled.errors)}`);
  const deps: ExecuteDeps = {
    connectors: new InMemoryConnectorRegistry(cc.connectors),
    broker,
  };
  return executeTool(compiled.artifact, tool, input, deps);
}

describe('end-to-end execution of .http()-authored connectors', () => {
  it('E1 — bearer POST: sends the nested body + Authorization from the broker, maps the response', async () => {
    const tickets = connector('tickets')
      .version('1.0.0')
      .http({
        baseUrl,
        allowedOrigins: [baseUrl],
        auth: { kind: 'bearer', secret: 'TICKETS_TOKEN' },
        operations: {
          create: {
            type: 'action',
            method: 'POST',
            path: '/anything',
            input: z.object({
              title: z.string(),
              severity: z.string(),
            }),
            request: {
              title: '${args.title}',
              severity: '${args.severity}',
              source: 'noodle-borg',
              metadata: { via: '${args.severity}', pipeline: 'declarative' },
            },
            response: {
              echoed_title: '${response.json.title}',
              via_nested: '${response.json.metadata.via}',
              auth_proof: '${response.headers.authorization}',
            },
            output: z.object({
              echoed_title: z.string().optional(),
              via_nested: z.string().optional(),
              auth_proof: z.string().optional(),
            }),
          },
        },
      });
    const app = server('s', { title: 'S', version: '1.0.0', use: { tickets } }, [
      tool('make', {
        description: 'x',
        input: z.object({ title: z.string(), severity: z.string() }),
        output: z.object({
          echoed_title: z.string(),
          via_nested: z.string(),
          auth_proof: z.string(),
        }),
        fulfil: ({ input, connectors }) => {
          const t = connectors.tickets.create({ title: input.title, severity: input.severity });
          return {
            echoed_title: t.echoed_title,
            via_nested: t.via_nested,
            auth_proof: t.auth_proof,
          };
        },
      }),
    ]);
    const broker = new MapServiceBroker(
      new Map([[MapServiceBroker.key('tickets'), { token: 'demo-bearer-xyz' }]]),
    );
    const result = await run(app, 'make', { title: 'Acme Corp', severity: 'high' }, broker);

    expect(result).toEqual({
      ok: true,
      output: {
        echoed_title: 'Acme Corp',
        via_nested: 'high',
        auth_proof: 'Bearer demo-bearer-xyz',
      },
    });
    // The connector actually sent the nested body and the broker-minted bearer header.
    expect(lastRequest.body).toEqual({
      title: 'Acme Corp',
      severity: 'high',
      source: 'noodle-borg',
      metadata: { via: 'high', pipeline: 'declarative' },
    });
    expect(lastRequest.headers.authorization).toBe('Bearer demo-bearer-xyz');
  });

  it('E2 — apiKey POST: sends the X-API-Key header from the broker', async () => {
    const partner = connector('partner')
      .version('1.0.0')
      .http({
        baseUrl,
        allowedOrigins: [baseUrl],
        auth: { kind: 'apiKey', header: 'X-API-Key', secret: 'PARTNER_KEY' },
        operations: {
          enrich: {
            type: 'read',
            method: 'POST',
            path: '/anything',
            input: z.object({ customer: z.string() }),
            request: { customer: '${args.customer}', lookup: 'profile' },
            response: { profile_for: '${response.json.customer}' },
            output: z.object({ profile_for: z.string().optional() }),
          },
        },
      });
    const app = server('s', { title: 'S', version: '1.0.0', use: { partner } }, [
      tool('enrich', {
        description: 'x',
        input: z.object({ customer: z.string() }),
        output: z.object({ profile_for: z.string() }),
        fulfil: ({ input, connectors }) => ({
          profile_for: connectors.partner.enrich({ customer: input.customer }).profile_for,
        }),
      }),
    ]);
    const broker = new MapServiceBroker(
      new Map([[MapServiceBroker.key('partner'), { token: 'demo-apikey-789' }]]),
    );
    const result = await run(app, 'enrich', { customer: 'Beta LLC' }, broker);

    expect(result).toEqual({ ok: true, output: { profile_for: 'Beta LLC' } });
    expect(lastRequest.headers['x-api-key']).toBe('demo-apikey-789');
  });

  it('E3 — full flow: compute → callOperation(apiKey) → bearer POST → conditional escalate (HIGH vs LOW)', async () => {
    const tickets = connector('tickets')
      .version('1.0.0')
      .http({
        baseUrl,
        allowedOrigins: [baseUrl],
        auth: { kind: 'bearer', secret: 'TICKETS_TOKEN' },
        operations: {
          create: {
            type: 'action',
            method: 'POST',
            path: '/anything',
            input: z.object({
              title: z.string(),
              severity: z.string(),
            }),
            request: { title: '${args.title}', severity: '${args.severity}' },
            response: {
              echoed_title: '${response.json.title}',
              auth_proof: '${response.headers.authorization}',
            },
            output: z.object({
              echoed_title: z.string().optional(),
              auth_proof: z.string().optional(),
            }),
          },
        },
      });
    const partner = connector('partner')
      .version('1.0.0')
      .http({
        baseUrl,
        allowedOrigins: [baseUrl],
        auth: { kind: 'apiKey', header: 'X-API-Key', secret: 'PARTNER_KEY' },
        operations: {
          enrich: {
            type: 'read',
            method: 'POST',
            path: '/anything',
            input: z.object({ customer: z.string() }),
            request: { customer: '${args.customer}' },
            response: { profile_for: '${response.json.customer}' },
            output: z.object({ profile_for: z.string().optional() }),
          },
        },
      });
    const triage = connector('triage')
      .version('1.0.0')
      .compute('classify', {
        type: 'read',
        input: z.object({ text: z.string() }),
        output: z.object({ severity: z.string() }),
        run: (input) => ({
          severity: /outage|urgent|critical/.test(String(input.text).toLowerCase())
            ? 'high'
            : 'low',
        }),
      })
      .compute('assist', {
        type: 'read',
        input: z.object({ customer: z.string() }),
        output: z.object({ enriched_customer: z.string() }),
        calls: { enrich: 'partner.enrich' },
        run: (input, { callOperation }) => {
          const r = callOperation('enrich', { customer: input.customer }) as {
            profile_for: string;
          };
          return { enriched_customer: r.profile_for };
        },
      });

    const app = server(
      'support',
      { title: 'Support', version: '1.0.0', use: { tickets, triage }, provides: { partner } },
      [
        tool('open_ticket', {
          description: 'x',
          input: z.object({ customer: z.string(), text: z.string() }),
          output: z.object({
            severity: z.string(),
            enriched_customer: z.string(),
            bearer_auth_proof: z.string(),
            escalated: z.string().optional(),
          }),
          fulfil: ({ input, connectors }) => {
            const triaged = connectors.triage.classify({ text: input.text });
            const assisted = connectors.triage.assist({ customer: input.customer });
            const ticket = connectors.tickets.create({
              title: input.customer,
              severity: triaged.severity,
            });
            const escalation = when(triaged.severity.equals('high'), () =>
              connectors.tickets.create({ title: 'ESCALATION', severity: triaged.severity }),
            );
            return {
              severity: triaged.severity,
              enriched_customer: assisted.enriched_customer,
              bearer_auth_proof: ticket.auth_proof,
              escalated: escalation.echoed_title,
            };
          },
        }),
      ],
    );

    const broker = new MapServiceBroker(
      new Map([
        [MapServiceBroker.key('tickets'), { token: 'svc-bearer' }],
        [MapServiceBroker.key('partner'), { token: 'svc-apikey' }],
      ]),
    );

    const high = (await run(
      app,
      'open_ticket',
      { customer: 'Acme', text: 'Production outage!' },
      broker,
    )) as {
      ok: boolean;
      output: Record<string, unknown>;
    };
    expect(high.ok).toBe(true);
    expect(high.output).toMatchObject({
      severity: 'high',
      enriched_customer: 'Acme', // came back from the apiKey partner call via callOperation
      bearer_auth_proof: 'Bearer svc-bearer',
      escalated: 'ESCALATION', // conditional step ran
    });

    const low = (await run(
      app,
      'open_ticket',
      { customer: 'Beta', text: 'quick question' },
      broker,
    )) as {
      ok: boolean;
      output: Record<string, unknown>;
    };
    expect(low.output.severity).toBe('low');
    expect('escalated' in low.output).toBe(false); // conditional step skipped
  });

  it('E4 — ?? fallback in a response mapping: a missing field yields the default', async () => {
    const api = connector('api')
      .version('1.0.0')
      .http({
        baseUrl,
        allowedOrigins: [baseUrl],
        operations: {
          go: {
            type: 'read',
            method: 'POST',
            path: '/anything',
            input: z.object({ x: z.string() }),
            request: { x: '${args.x}' },
            // `response.json.maybe` is never set by the echo server → falls back to "default".
            response: { value: '${response.json.maybe ?? "default"}' },
            output: z.object({ value: z.string().optional() }),
          },
        },
      });
    const app = server('s', { title: 'S', version: '1.0.0', use: { api } }, [
      tool('go', {
        description: 'x',
        input: z.object({ x: z.string() }),
        output: z.object({ value: z.string() }),
        fulfil: ({ input, connectors }) => ({ value: connectors.api.go({ x: input.x }).value }),
      }),
    ]);
    const broker = new MapServiceBroker(new Map());
    const result = await run(app, 'go', { x: 'hi' }, broker);
    expect(result).toEqual({ ok: true, output: { value: 'default' } });
  });

  it('E5 — GET with query params: the connector sends the declared query', async () => {
    const api = connector('api')
      .version('1.0.0')
      .http({
        baseUrl,
        allowedOrigins: [baseUrl],
        operations: {
          search: {
            type: 'read',
            method: 'GET',
            path: '/search',
            query: ['q', 'limit'],
            input: z.object({ q: z.string(), limit: z.string().optional() }),
            request: { q: '${args.q}', limit: '${args.limit}' },
            response: { echoed_q: '${response.args.q}', echoed_limit: '${response.args.limit}' },
            output: z.object({
              echoed_q: z.string().optional(),
              echoed_limit: z.string().optional(),
            }),
          },
        },
      });
    const app = server('s', { title: 'S', version: '1.0.0', use: { api } }, [
      tool('search', {
        description: 'x',
        input: z.object({ q: z.string(), limit: z.string() }),
        output: z.object({ echoed_q: z.string(), echoed_limit: z.string() }),
        fulfil: ({ input, connectors }) => {
          const r = connectors.api.search({ q: input.q, limit: input.limit });
          return { echoed_q: r.echoed_q, echoed_limit: r.echoed_limit };
        },
      }),
    ]);
    const broker = new MapServiceBroker(new Map());
    const result = await run(app, 'search', { q: 'borg', limit: '5' }, broker);

    expect(result).toEqual({ ok: true, output: { echoed_q: 'borg', echoed_limit: '5' } });
    expect(lastRequest.method).toBe('GET');
    expect(lastRequest.path).toBe('/search');
    expect(lastRequest.query).toEqual({ q: 'borg', limit: '5' });
  });

  it('E6 — path params: an ${args.x}-authored path substitutes the URL-encoded argument on a live call', async () => {
    // Regression for the live-only 404: `${args.x}` used to reach the runtime as literal text and be
    // URL-encoded into the request path instead of substituting the argument.
    const api = connector('api')
      .version('1.0.0')
      .http({
        baseUrl,
        allowedOrigins: [baseUrl],
        operations: {
          detail: {
            type: 'read',
            method: 'GET',
            path: '/things/${args.thing_id}/detail',
            input: z.object({ thing_id: z.string() }),
            response: { value: '${response.args.probe ?? "ok"}' },
            output: z.object({ value: z.string().optional() }),
          },
        },
      });
    const app = server('s', { title: 'S', version: '1.0.0', use: { api } }, [
      tool('detail', {
        description: 'x',
        input: z.object({ thing_id: z.string() }),
        output: z.object({ value: z.string() }),
        fulfil: ({ input, connectors }) => ({
          value: connectors.api.detail({ thing_id: input.thing_id }).value,
        }),
      }),
    ]);
    const broker = new MapServiceBroker(new Map());
    const result = await run(app, 'detail', { thing_id: 'abc/123' }, broker);

    expect(result).toEqual({ ok: true, output: { value: 'ok' } });
    expect(lastRequest.method).toBe('GET');
    expect(lastRequest.path).toBe('/things/abc%2F123/detail');
  });
});
