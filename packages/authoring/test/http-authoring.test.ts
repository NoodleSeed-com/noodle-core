import { describe, expect, it } from 'vitest';
import { compileManifest, InMemoryCatalog } from '../../compiler/src/index.js';
import { compileConnectors } from '../../connector-defs/src/index.js';
import { connector, secret, server, tool, variable, when, z } from '../src/index.js';

// NOTE: this file covers the AUTHORING layer — what `.http()`/`.compute()` emit, author-time
// validation, and the `.use()`/`.provides()` merge/alias logic. End-to-end *execution* of an authored
// connector lives in `http-authoring.e2e.test.ts`. The HTTP engine internals (timeouts, size limits,
// SSRF/allowlist, URL encoding), the managed secret matrix, broker keying, and the `${...}` grammar
// are covered at their own layers (connector-http / connector-defs / runtime / service / compiler).

/**
 * `tickets` — a bearer HTTP connector authored via `.http()`, with a nested request body and deep +
 * header response mappings. The connector carries its own fulfilment, like a `.compute()` connector.
 */
function tickets() {
  return connector('tickets')
    .version('1.0.0')
    .http({
      baseUrl: 'https://httpbin.org',
      allowedOrigins: ['https://httpbin.org'],
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
}

/** `partner` — an apiKey HTTP connector (different host + header). */
function partner() {
  return connector('partner')
    .version('1.0.0')
    .http({
      baseUrl: 'https://httpbingo.org',
      allowedOrigins: ['https://httpbingo.org'],
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
}

/** `triage` — a sandboxed compute connector whose `assist` op reaches `partner.enrich` via callOperation. */
function triage() {
  return connector('triage')
    .version('1.0.0')
    .compute('classify', {
      type: 'read',
      input: z.object({ text: z.string() }),
      output: z.object({
        severity: z.string(),
        summary: z.string(),
      }),
      run: (input) => {
        const text = String(input.text || '').toLowerCase();
        const severity = /outage|down|urgent|breach|critical/.test(text)
          ? 'high'
          : /slow|error|fail|degraded|refund|billing/.test(text)
            ? 'medium'
            : 'low';
        const raw = String(input.text || '');
        return { severity, summary: raw.length > 80 ? `${raw.slice(0, 77)}...` : raw };
      },
    })
    .compute('assist', {
      type: 'read',
      input: z.object({ customer: z.string() }),
      output: z.object({
        enriched_customer: z.string(),
        note: z.string(),
      }),
      calls: { enrich: 'partner.enrich' },
      run: (input, { callOperation }) => {
        const r = callOperation('enrich', { customer: input.customer }) as { profile_for: string };
        return { enriched_customer: r.profile_for, note: 'enriched via partner API' };
      },
    });
}

/** A support-desk server authored end-to-end in TypeScript for HTTP connector coverage. */
function supportDeskApp() {
  return server(
    'support_desk',
    {
      title: 'Support Desk',
      version: '1.0.0',
      use: { tickets: tickets(), triage: triage() },
      provides: { partner: partner() },
    },
    [
      tool('classify', {
        description: 'Classify text into a severity using a sandboxed compute step.',
        input: z.object({ text: z.string() }),
        output: z.object({ severity: z.string(), summary: z.string() }),
        fulfil({ input, connectors }) {
          const r = connectors.triage.classify({ text: input.text });
          return { severity: r.severity, summary: r.summary };
        },
      }),
      tool('open_ticket', {
        description: 'Triage, enrich, open a ticket, escalate when high.',
        input: z.object({ customer: z.string(), text: z.string() }),
        output: z.object({
          severity: z.string(),
          enriched_customer: z.string(),
          ticket_title: z.string(),
          nested_roundtrip: z.string(),
          bearer_auth_proof: z.string(),
          escalated: z.string().optional(),
        }),
        fulfil({ input, connectors }) {
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
            ticket_title: ticket.echoed_title,
            nested_roundtrip: ticket.via_nested,
            bearer_auth_proof: ticket.auth_proof,
            escalated: escalation.echoed_title,
          };
        },
      }),
    ],
  );
}

describe('.http() emission', () => {
  it('derives operation signatures from the .http() def', () => {
    const t = tickets();
    expect(t).toMatchObject({ id: 'tickets', version: '1.0.0' });
    expect(t.operations.create?.type).toBe('action');
    // Zod authoring emits the canonical closed JSON Schema (ADR 0139).
    expect(t.operations.create?.input).toEqual({
      type: 'object',
      properties: { title: { type: 'string' }, severity: { type: 'string' } },
      required: ['title', 'severity'],
      additionalProperties: false,
    });
    expect(t.operations.create?.output).toEqual({
      type: 'object',
      properties: {
        echoed_title: { type: 'string' },
        via_nested: { type: 'string' },
        auth_proof: { type: 'string' },
      },
      additionalProperties: false,
    });
  });

  it('emits the connector verbatim with kind=custom and the declared id/version', () => {
    const catalog = server('s', { title: 'S', version: '1.0.0', use: { tickets: tickets() } }, [
      tool('noop', {
        description: 'x',
        input: z.object({}),
        fulfil: ({ connectors }) => {
          connectors.tickets.create({ title: 'a', severity: 'low' });
          return {};
        },
      }),
    ]).toConnectorCatalog();
    const c = catalog?.connectors[0];
    expect(c).toMatchObject({
      id: 'tickets',
      version: '1.0.0',
      kind: 'custom',
      http: {
        baseUrl: 'https://httpbin.org',
        allowedOrigins: ['https://httpbin.org'],
        auth: { kind: 'bearer', secret: 'TICKETS_TOKEN' },
      },
    });
    // Nested request body and deep/header response mappings are emitted verbatim.
    const op = c?.operations.create as { request?: unknown; response?: unknown };
    expect(op.request).toEqual({
      title: '${args.title}',
      severity: '${args.severity}',
      source: 'noodle-borg',
      metadata: { via: '${args.severity}', pipeline: 'declarative' },
    });
    expect(op.response).toMatchObject({ auth_proof: '${response.headers.authorization}' });
  });

  it('emits bearer and apiKey connector-level auth', () => {
    const catalog = server(
      's',
      {
        title: 'S',
        version: '1.0.0',
        use: { tickets: tickets() },
        provides: { partner: partner() },
      },
      [
        tool('noop', {
          description: 'x',
          input: z.object({}),
          fulfil: ({ connectors }) => {
            connectors.tickets.create({ title: 'a', severity: 'b' });
            return {};
          },
        }),
      ],
    ).toConnectorCatalog();
    expect(catalog?.connectors.find((c) => c.id === 'tickets')).toMatchObject({
      http: { auth: { kind: 'bearer', secret: 'TICKETS_TOKEN' } },
    });
    expect(catalog?.connectors.find((c) => c.id === 'partner')).toMatchObject({
      http: { auth: { kind: 'apiKey', header: 'X-API-Key', secret: 'PARTNER_KEY' } },
    });
  });

  it('emits delegated session-cookie connector auth', () => {
    const sessionApi = connector('session_api')
      .version('1.0.0')
      .http({
        baseUrl: 'https://dev.example.test',
        allowedOrigins: ['https://dev.example.test'],
        auth: {
          kind: 'delegatedSessionCookie',
          provider: 'firebase',
          sessionUrl: 'https://dev.example.test/api/auth/session',
          tokenField: 'idToken',
        },
        operations: {
          list_orgs: {
            type: 'read',
            method: 'GET',
            path: '/api/organizations',
            output: z.object({ result: z.unknown().optional() }),
          },
        },
      });
    const catalog = server(
      's',
      { title: 'S', version: '1.0.0', use: { session_api: sessionApi } },
      [
        tool('noop', {
          description: 'x',
          input: z.object({}),
          fulfil: ({ connectors }) => {
            connectors.session_api.listOrgs({});
            return {};
          },
        }),
      ],
    ).toConnectorCatalog();
    expect(catalog?.connectors.find((c) => c.id === 'session_api')).toMatchObject({
      http: {
        auth: {
          kind: 'delegatedSessionCookie',
          provider: 'firebase',
          sessionUrl: 'https://dev.example.test/api/auth/session',
          tokenField: 'idToken',
        },
      },
    });
  });

  it('emits Microsoft delegated OAuth metadata with a managed client secret ref', () => {
    const sharepoint = connector('sharepoint_graph')
      .version('1.0.0')
      .http({
        baseUrl: 'https://graph.microsoft.com/v1.0',
        allowedOrigins: ['https://graph.microsoft.com', 'https://login.microsoftonline.com'],
        auth: {
          kind: 'delegatedOAuth',
          provider: 'microsoft',
          tokenUrl: 'https://login.microsoftonline.com/tenant/oauth2/v2.0/token',
          clientId: 'app-client-id',
          clientSecret: secret('MS_CLIENT_SECRET'),
          scopes: ['https://graph.microsoft.com/Sites.Selected'],
          authMethod: 'client_secret_post',
        },
        operations: {
          list_children: {
            type: 'read',
            method: 'GET',
            path: '/sites/{siteId}/drive/root/children',
            input: z.object({ siteId: z.string() }),
            output: z.object({ result: z.unknown().optional() }),
          },
        },
      });
    expect(sharepoint.httpDef?.http.auth).toEqual({
      kind: 'delegatedOAuth',
      provider: 'microsoft',
      tokenUrl: 'https://login.microsoftonline.com/tenant/oauth2/v2.0/token',
      clientId: 'app-client-id',
      clientSecret: 'MS_CLIENT_SECRET',
      scopes: ['https://graph.microsoft.com/Sites.Selected'],
      authMethod: 'client_secret_post',
    });
    const compiled = compileConnectors(JSON.stringify({ connectors: [sharepoint.httpDef] }));
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.secretBindings).toContainEqual({
      connectorId: 'sharepoint_graph',
      connectorVersion: '1.0.0',
      secretRef: 'MS_CLIENT_SECRET',
      authKind: 'delegatedOAuth',
      delegated: {
        provider: 'microsoft',
        tokenUrl: 'https://login.microsoftonline.com/tenant/oauth2/v2.0/token',
        clientId: 'app-client-id',
        scopes: ['https://graph.microsoft.com/Sites.Selected'],
        authMethod: 'client_secret_post',
      },
    });
  });

  it('emits Microsoft delegated OAuth metadata with managed tenant and client variables', () => {
    const tenantId = variable('MICROSOFT_TENANT_ID');
    const sharepoint = connector('sharepoint_graph')
      .version('1.0.0')
      .http({
        baseUrl: 'https://graph.microsoft.com/v1.0',
        allowedOrigins: ['https://graph.microsoft.com', 'https://login.microsoftonline.com'],
        auth: {
          kind: 'delegatedOAuth',
          provider: 'microsoft',
          tokenUrl: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
          clientId: variable('MICROSOFT_CLIENT_ID'),
          clientSecret: secret('MS_CLIENT_SECRET'),
          scopes: ['https://graph.microsoft.com/Sites.Selected'],
          authMethod: 'client_secret_post',
        },
        operations: {
          list_children: {
            type: 'read',
            method: 'GET',
            path: '/sites/{siteId}/drive/root/children',
            input: z.object({ siteId: z.string() }),
            output: z.object({ result: z.unknown().optional() }),
          },
        },
      });

    expect(sharepoint.httpDef?.http.auth).toMatchObject({
      tokenUrl: 'https://login.microsoftonline.com/${env.MICROSOFT_TENANT_ID}/oauth2/v2.0/token',
      clientId: '${env.MICROSOFT_CLIENT_ID}',
    });
    const compiled = compileConnectors(JSON.stringify({ connectors: [sharepoint.httpDef] }));
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.variableBindings).toEqual(['MICROSOFT_CLIENT_ID', 'MICROSOFT_TENANT_ID']);
  });

  it('emits delegated token exchange metadata with managed client refs', () => {
    const acmehr = connector('acmehr_api')
      .version('1.0.0')
      .http({
        baseUrl: 'https://app.acmehr.example/api/v1',
        allowedOrigins: ['https://app.acmehr.example'],
        auth: {
          kind: 'delegatedTokenExchange',
          tokenUrl: 'https://app.acmehr.example/api/assistant/oauth/token',
          clientId: variable('ACMEHR_DELEG_CLIENT_ID'),
          clientSecret: secret('ACMEHR_DELEG_CLIENT_SECRET'),
          scopes: ['time_off'],
          audience: 'acmehr-api',
        },
        operations: {
          list_time_off: {
            type: 'read',
            method: 'GET',
            path: '/teams/{team}/time-off',
            input: z.object({ team: z.string() }),
            output: z.object({ result: z.unknown().optional() }),
          },
        },
      });
    expect(acmehr.httpDef?.http.auth).toEqual({
      kind: 'delegatedTokenExchange',
      tokenUrl: 'https://app.acmehr.example/api/assistant/oauth/token',
      clientId: '${env.ACMEHR_DELEG_CLIENT_ID}',
      clientSecret: 'ACMEHR_DELEG_CLIENT_SECRET',
      scopes: ['time_off'],
      audience: 'acmehr-api',
    });
    const compiled = compileConnectors(JSON.stringify({ connectors: [acmehr.httpDef] }));
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.variableBindings).toEqual(['ACMEHR_DELEG_CLIENT_ID']);
    expect(compiled.secretBindings).toContainEqual({
      connectorId: 'acmehr_api',
      connectorVersion: '1.0.0',
      secretRef: 'ACMEHR_DELEG_CLIENT_SECRET',
      authKind: 'delegatedTokenExchange',
      tokenExchange: {
        tokenUrl: 'https://app.acmehr.example/api/assistant/oauth/token',
        clientId: '${env.ACMEHR_DELEG_CLIENT_ID}',
        scopes: ['time_off'],
        audience: 'acmehr-api',
        authMethod: 'client_secret_basic',
      },
    });
  });

  it('emits PATCH and DELETE HTTP operation methods unchanged', () => {
    const api = connector('items')
      .version('1.0.0')
      .http({
        baseUrl: 'https://api.example.test',
        operations: {
          update_item: {
            type: 'action',
            method: 'PATCH',
            path: '/items/${args.itemId}',
            input: z.object({
              itemId: z.string(),
              fields: z.record(z.string(), z.unknown()),
            }),
            output: z.object({ itemId: z.string() }),
            request: '${args.fields}',
            response: { itemId: '${args.itemId}' },
          },
          delete_item: {
            type: 'action',
            method: 'DELETE',
            path: '/items/${args.itemId}',
            responseType: 'text',
            input: z.object({ itemId: z.string() }),
            output: z.object({ itemId: z.string() }),
            response: { itemId: '${args.itemId}' },
          },
        },
      });

    expect(api.httpDef?.operations.update_item.method).toBe('PATCH');
    expect(api.httpDef?.operations.update_item.request).toBe('${args.fields}');
    expect(api.httpDef?.operations.delete_item.method).toBe('DELETE');
    const compiled = compileConnectors(JSON.stringify({ connectors: [api.httpDef] }));
    expect(compiled.ok).toBe(true);
  });

  it('emits operation resilience metadata for read HTTP operations', () => {
    const resilient = connector('resilient')
      .version('1.0.0')
      .http({
        baseUrl: 'https://api.example.test',
        operations: {
          search: {
            type: 'read',
            method: 'GET',
            path: '/search',
            resilience: {
              timeoutMs: 800,
              retry: { maxAttempts: 2, baseDelayMs: 1, retryOn: ['upstream_5xx'] },
            },
            output: z.object({ ok: z.boolean().optional() }),
          },
        },
      });
    expect(resilient.httpDef?.operations.search).toMatchObject({
      resilience: {
        timeoutMs: 800,
        retry: { maxAttempts: 2, baseDelayMs: 1, retryOn: ['upstream_5xx'] },
      },
    });
  });

  it('emits HTTP operation projection metadata verbatim', () => {
    const projected = connector('projected')
      .version('1.0.0')
      .http({
        baseUrl: 'https://api.example.test',
        operations: {
          search: {
            type: 'read',
            method: 'GET',
            path: '/search',
            response: {
              title: '${response.title}',
              internal: '${response.internal}',
            },
            projection: {
              hiddenFields: ['internal'],
              widgetMeta: { rawId: '${response.id}', visibleTitle: '${output.title}' },
              sourceLabel: 'Example API',
              freshness: { ttlMs: 30_000 },
            },
            output: z.object({
              title: z.string().optional(),
              internal: z.string().optional(),
            }),
          },
        },
      });
    expect(projected.httpDef?.operations.search).toMatchObject({
      projection: {
        hiddenFields: ['internal'],
        widgetMeta: { rawId: '${response.id}', visibleTitle: '${output.title}' },
        sourceLabel: 'Example API',
        freshness: { ttlMs: 30_000 },
      },
    });
  });

  it('preserves a per-operation auth override and a GET op with query params; method omitted stays absent', () => {
    const api = connector('api')
      .version('1.0.0')
      .http({
        baseUrl: 'https://api.test',
        auth: { kind: 'bearer', secret: 'DEFAULT_TOKEN' },
        operations: {
          // GET with query params, and a per-op apiKey auth that overrides the connector default.
          search: {
            type: 'read',
            method: 'GET',
            path: '/search',
            query: ['q', 'limit'],
            auth: { kind: 'apiKey', header: 'X-Key', secret: 'SEARCH_KEY' },
            output: z.object({ hits: z.number().optional() }),
          },
          // method omitted → should be absent in the emitted op (runtime defaults to GET).
          ping: { type: 'read', path: '/ping' },
        },
      });
    const catalog = server('s', { title: 'S', version: '1.0.0', use: { api } }, [
      tool('noop', {
        description: 'x',
        input: z.object({}),
        fulfil: ({ connectors }) => {
          connectors.api.search({});
          return {};
        },
      }),
    ]).toConnectorCatalog();
    const c = catalog?.connectors.find((x) => x.id === 'api');
    const search = c?.operations.search as { auth?: unknown; query?: unknown; method?: unknown };
    const ping = c?.operations.ping as { method?: unknown };
    expect(search.auth).toEqual({ kind: 'apiKey', header: 'X-Key', secret: 'SEARCH_KEY' });
    expect(search.query).toEqual(['q', 'limit']);
    expect(search.method).toBe('GET');
    expect(ping.method).toBeUndefined();
  });

  it('emits HTTP + compute connectors merged into one catalog', () => {
    const catalog = supportDeskApp().toConnectorCatalog();
    expect(catalog?.connectors.map((c) => c.id).sort()).toEqual(['partner', 'tickets', 'triage']);
    const triageC = catalog?.connectors.find((c) => c.id === 'triage');
    const assist = triageC?.operations.assist as { code?: string; calls?: Record<string, string> };
    expect(typeof assist?.code).toBe('string');
    expect(assist?.calls).toEqual({ enrich: 'partner.enrich' });
  });
});

describe('.http() author-time validation', () => {
  // Each malformed def should throw synchronously from `.http()` (connectorFileSchema). We cast the
  // options to bypass TS so we exercise the runtime Zod validation directly.
  const build = (opts: unknown) =>
    connector('x')
      .version('1.0.0')
      // biome-ignore lint/suspicious/noExplicitAny: intentionally malformed inputs for runtime validation.
      .http(opts as any);

  it.each([
    [
      'baseUrl is not a URL',
      { baseUrl: 'not-a-url', operations: { go: { type: 'read', path: '/' } } },
    ],
    [
      'allowedOrigins is not a URL',
      {
        baseUrl: 'https://x.test',
        allowedOrigins: ['nope'],
        operations: { go: { type: 'read', path: '/' } },
      },
    ],
    [
      'bad method',
      {
        baseUrl: 'https://x.test',
        operations: { go: { type: 'read', method: 'TRACE', path: '/' } },
      },
    ],
    ['empty path', { baseUrl: 'https://x.test', operations: { go: { type: 'read', path: '' } } }],
    [
      'bad type enum',
      { baseUrl: 'https://x.test', operations: { go: { type: 'sideways', path: '/' } } },
    ],
    [
      'apiKey missing header',
      {
        baseUrl: 'https://x.test',
        auth: { kind: 'apiKey', secret: 'K' },
        operations: { go: { type: 'read', path: '/' } },
      },
    ],
    [
      'inline secret value rejected (strict auth)',
      {
        baseUrl: 'https://x.test',
        auth: { kind: 'bearer', secret: 'K', value: 'inline-token' },
        operations: { go: { type: 'read', path: '/' } },
      },
    ],
    [
      'hyphenated secret reference',
      {
        baseUrl: 'https://x.test',
        auth: { kind: 'bearer', secret: 'BAD-REF' },
        operations: { go: { type: 'read', path: '/' } },
      },
    ],
    [
      'unknown key in operation (strict)',
      { baseUrl: 'https://x.test', operations: { go: { type: 'read', path: '/', bogus: true } } },
    ],
    [
      'unknown key in http block (strict)',
      { baseUrl: 'https://x.test', surprise: 1, operations: { go: { type: 'read', path: '/' } } },
    ],
  ])('rejects: %s', (_name, opts) => {
    expect(() => build(opts)).toThrow(/invalid connector catalog/i);
  });

  it('rejects retry resilience on action operations', () => {
    expect(() =>
      build({
        baseUrl: 'https://x.test',
        operations: {
          create: {
            type: 'action',
            method: 'POST',
            path: '/create',
            resilience: { retry: { maxAttempts: 2 } },
          },
        },
      }),
    ).toThrow(/unsafe_retry_action/);
  });
});

describe('.use() / .provides() / merge', () => {
  it('aliases only .use() connectors in the manifest; .provides() stays catalog-only', async () => {
    const manifest = await supportDeskApp().toManifest();
    expect(Object.keys(manifest.connectors ?? {}).sort()).toEqual(['tickets', 'triage']);
    expect(manifest.connectors?.partner).toBeUndefined();
  });

  it('emits a .provides()-d compute-only connector without aliasing it', async () => {
    // A compute connector reached only via callOperation (provided, not used) must reach the catalog
    // but never be aliased.
    const helper = connector('helper')
      .version('1.0.0')
      .compute('shout', {
        type: 'read',
        input: z.object({ s: z.string() }),
        output: z.object({ loud: z.string().optional() }),
        run: (input) => ({ loud: String(input.s).toUpperCase() }),
      });
    const main = connector('main')
      .version('1.0.0')
      .compute('decorate', {
        type: 'read',
        input: z.object({ s: z.string() }),
        output: z.object({ decorated: z.string().optional() }),
        calls: { shout: 'helper.shout' },
        run: (input, { callOperation }) => {
          const r = callOperation('shout', { s: input.s }) as { loud: string };
          return { decorated: `[${r.loud}]` };
        },
      });
    const app = server('s', { title: 'S', version: '1.0.0', use: { main }, provides: { helper } }, [
      tool('decorate', {
        description: 'x',
        input: z.object({ s: z.string() }),
        fulfil: ({ input, connectors }) => ({
          decorated: connectors.main.decorate({ s: input.s }).decorated,
        }),
      }),
    ]);
    const catalog = app.toConnectorCatalog();
    expect(catalog?.connectors.map((c) => c.id).sort()).toEqual(['helper', 'main']);
    const manifest = await app.toManifest();
    expect(Object.keys(manifest.connectors ?? {})).toEqual(['main']);
  });

  it('dedupes a connector listed in both .use() and .provides()', () => {
    const t = tickets();
    const catalog = server(
      's',
      { title: 'S', version: '1.0.0', use: { tickets: t }, provides: { tickets: t } },
      [
        tool('noop', {
          description: 'x',
          input: z.object({}),
          fulfil: ({ connectors }) => {
            connectors.tickets.create({ title: 'a', severity: 'b' });
            return {};
          },
        }),
      ],
    ).toConnectorCatalog();
    expect(catalog?.connectors.filter((c) => c.id === 'tickets')).toHaveLength(1);
  });

  it('skips a signature-only .operation() connector from the emitted catalog', () => {
    // A signature-only connector resolves against an external catalog; it has no fulfilment to emit.
    const ext = connector('ext')
      .version('1.0.0')
      .operation('fetch', {
        type: 'read',
        input: z.object({}),
        output: z.object({ ok: z.string().optional() }),
      });
    const catalog = server('s', { title: 'S', version: '1.0.0', use: { ext } }, [
      tool('noop', {
        description: 'x',
        input: z.object({}),
        fulfil: ({ connectors }) => {
          connectors.ext.fetch({});
          return {};
        },
      }),
    ]).toConnectorCatalog();
    // Only signature-only connectors → nothing to emit.
    expect(catalog).toBeUndefined();
  });

  it('returns undefined when no connector has fulfilment', () => {
    const app = server('plain', { title: 'Plain', version: '1.0.0' }, [
      tool('noop', {
        description: 'x',
        input: z.object({}),
        fulfil: () => ({ ok: 'yes' }),
      }),
    ]);
    expect(app.toConnectorCatalog()).toBeUndefined();
  });
});

describe('.http() / .compute() guards & author-vs-compile boundary', () => {
  it('refuses to mix .http() then .compute() on one connector', () => {
    expect(() =>
      connector('x')
        .version('1.0.0')
        .http({ baseUrl: 'https://x.test', operations: { go: { type: 'read', path: '/' } } })
        .compute('c', { input: {}, output: {}, run: () => ({}) }),
    ).toThrow(/HTTP or compute/i);
  });

  it('refuses to mix .compute() then .http() on one connector', () => {
    expect(() =>
      connector('x')
        .version('1.0.0')
        .compute('c', { input: {}, output: {}, run: () => ({}) })
        .http({ baseUrl: 'https://x.test', operations: { go: { type: 'read', path: '/' } } }),
    ).toThrow(/HTTP or compute/i);
  });

  it('accepts a hyphenated response path at author time but rejects it at compile time', async () => {
    // The string is schema-valid, so `.http()` passes — but the expression language forbids hyphens in
    // path segments, so compiling the emitted catalog fails (the author-time vs compile-time boundary).
    const api = connector('api')
      .version('1.0.0')
      .http({
        baseUrl: 'https://api.test',
        operations: {
          go: {
            type: 'read',
            method: 'GET',
            path: '/go',
            response: { key: '${response.headers.X-Api-Key}' },
            output: z.object({ key: z.string().optional() }),
          },
        },
      });
    const catalog = server('s', { title: 'S', version: '1.0.0', use: { api } }, [
      tool('noop', {
        description: 'x',
        input: z.object({}),
        fulfil: ({ connectors }) => {
          connectors.api.go({});
          return {};
        },
      }),
    ]).toConnectorCatalog();
    expect(catalog).toBeDefined(); // author-time: accepted
    const cc = compileConnectors(JSON.stringify(catalog));
    expect(cc.ok).toBe(false); // compile-time: rejected
  });

  it('round-trips: emitted catalog + manifest compile through the real compiler', async () => {
    const app = supportDeskApp();
    const catalog = app.toConnectorCatalog();
    if (!catalog) throw new Error('expected a catalog');
    const manifest = await app.toManifest();

    const cc = compileConnectors(JSON.stringify(catalog));
    if (!cc.ok) throw new Error(`connector compile failed: ${JSON.stringify(cc.errors)}`);
    expect(cc.secretBindings.map((b) => b.secretRef).sort()).toEqual([
      'PARTNER_KEY',
      'TICKETS_TOKEN',
    ]);

    const compiled = compileManifest(manifest, { catalog: new InMemoryCatalog(cc.catalog) });
    if (!compiled.ok)
      throw new Error(`manifest compile failed: ${JSON.stringify(compiled.errors)}`);
  });
});

describe('http path templating', () => {
  function projectsApi(path: string) {
    return connector('projects_api')
      .version('1.0.0')
      .http({
        baseUrl: 'https://api.example.test',
        allowedOrigins: ['https://api.example.test'],
        operations: {
          list_apps: {
            type: 'read',
            method: 'GET',
            path,
            input: z.object({ org_id: z.string() }),
            output: z.object({ result: z.unknown().optional() }),
          },
        },
      });
  }

  it('compiles ${args.name} path params to {name} runtime placeholders', () => {
    // Regression: `${args.org_id}` used to pass through literally, so the runtime URL-encoded the
    // raw text into the request path instead of substituting the argument.
    const api = projectsApi('/api/organizations/${args.org_id}/apps');
    expect(api.httpDef?.operations.list_apps?.path).toBe('/api/organizations/{org_id}/apps');
  });

  it('keeps {name} placeholders and mixes them with ${args.*} params', () => {
    const api = projectsApi('/orgs/${args.org_id}/apps/{app_id}');
    expect(api.httpDef?.operations.list_apps?.path).toBe('/orgs/{org_id}/apps/{app_id}');
  });

  it('rejects non-args expressions in a path', () => {
    expect(() => projectsApi('/tenants/${vars.tenant}/apps')).toThrow(
      /unsupported_path_expression at connectors\.projects_api\.operations\.list_apps\.path/,
    );
  });

  it('rejects nested arg paths in a path template', () => {
    expect(() => projectsApi('/orgs/${args.org.id}/apps')).toThrow(/unsupported_path_expression/);
  });
});
