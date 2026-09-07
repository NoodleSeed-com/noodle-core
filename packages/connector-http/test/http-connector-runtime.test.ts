import { type CatalogConnector, compile, InMemoryCatalog } from '@noodle-borg/compiler';
import {
  type CredentialBroker,
  type CredentialRequest,
  type DownstreamCredential,
  type ExecuteDeps,
  executeTool,
  InMemoryConnectorRegistry,
  StaticServiceBroker,
} from '@noodle-borg/runtime';
import { describe, expect, it } from 'vitest';
import { HttpConnector } from '../src/index.js';
import {
  baseUrl,
  baseUrl2,
  connector,
  createSig,
  credential,
  enrichSig,
  getPostSig,
  lastRequest,
  lastRequest2,
  origin,
  origin2,
} from './http-connector-fixture.js';

describe('HttpConnector through the runtime (end to end)', () => {
  const MANIFEST = `
manifestVersion: "1"
server:
  name: demo
  version: 1.0.0
  title: Demo
connectors:
  posts:
    id: jsonplaceholder
    version: 1.0.0
tools:
  - name: get_post
    description: Fetch a post by id.
    inputSchema:
      type: object
      properties:
        post_id:
          type: string
      required:
        - post_id
      additionalProperties: false
    fulfilment:
      use: posts.get_post
      args:
        post_id: \${input.post_id}
`;
  const catalogConnector: CatalogConnector = {
    id: 'jsonplaceholder',
    version: '1.0.0',
    kind: 'catalog',
    operations: { get_post: getPostSig },
  };

  it('executes a tool call that fetches from the live (local) backend', async () => {
    const compiled = compile(MANIFEST, { catalog: new InMemoryCatalog([catalogConnector]) });
    if (!compiled.ok) throw new Error(`compile failed: ${JSON.stringify(compiled.errors)}`);

    const deps: ExecuteDeps = {
      connectors: new InMemoryConnectorRegistry([connector()]),
      broker: new StaticServiceBroker(credential),
    };
    const result = await executeTool(compiled.artifact, 'get_post', { post_id: '7' }, deps);
    expect(result).toEqual({ ok: true, output: { title: 't7', body: 'b7' } });
  });

  it('runs a flow that chains two authenticated POSTs across two hosts', async () => {
    const FLOW_MANIFEST = `
manifestVersion: "1"
server:
  name: demo_chain
  version: 1.0.0
  title: Demo Chain
connectors:
  echo:
    id: echo
    version: 1.0.0
tools:
  - name: derive_and_enrich
    description: Authenticated POST, then a second authenticated POST on another host.
    inputSchema:
      type: object
      properties:
        label:
          type: string
      required:
        - label
      additionalProperties: false
    fulfilment:
      steps:
        - id: create
          use: echo.create
          args:
            label: \${input.label}
        - id: enrich
          use: echo.enrich
          args:
            derived: \${steps.create.token}
      output:
        created: \${steps.create.token}
        enriched: \${steps.enrich.derived}
`;
    const echoCatalog: CatalogConnector = {
      id: 'echo',
      version: '1.0.0',
      kind: 'catalog',
      operations: { create: createSig, enrich: enrichSig },
    };
    const echo = new HttpConnector({
      id: 'echo',
      version: '1.0.0',
      baseUrl,
      allowedOrigins: [origin, origin2],
      operations: {
        create: {
          method: 'POST',
          path: '/anything',
          auth: { kind: 'bearer' },
          body: (a) => ({ label: a.label }),
          signature: createSig,
          mapResponse: (j) => ({ token: (j as { json: { label: string } }).json.label }),
        },
        enrich: {
          method: 'POST',
          path: '/anything',
          baseUrl: baseUrl2,
          auth: { kind: 'apiKey', header: 'X-API-Key' },
          body: (a) => ({ derived: a.derived }),
          signature: enrichSig,
          mapResponse: (j) => ({ derived: (j as { json: { derived: string } }).json.derived }),
        },
      },
    });
    // A broker that mints a different key per operation — the seam a real broker fills per host.
    const perOpBroker: CredentialBroker = {
      getCredential(req: CredentialRequest): Promise<DownstreamCredential> {
        return Promise.resolve({ token: req.operation === 'create' ? 'bearer-key' : 'api-key' });
      },
    };

    const compiled = compile(FLOW_MANIFEST, { catalog: new InMemoryCatalog([echoCatalog]) });
    if (!compiled.ok) throw new Error(`compile failed: ${JSON.stringify(compiled.errors)}`);

    const deps: ExecuteDeps = {
      connectors: new InMemoryConnectorRegistry([echo]),
      broker: perOpBroker,
    };
    const result = await executeTool(
      compiled.artifact,
      'derive_and_enrich',
      { label: 'hello' },
      deps,
    );
    expect(result).toEqual({ ok: true, output: { created: 'hello', enriched: 'hello' } });
    // step 1 hit the primary host with a bearer key; step 2 hit the secondary host with an api key.
    expect(lastRequest.headers.authorization).toBe('Bearer bearer-key');
    expect(lastRequest2.headers['x-api-key']).toBe('api-key');
  });
});

describe('HttpConnector managed base URL', () => {
  it('resolves a managed base URL against the static allowlist for a live request', async () => {
    const connector = new HttpConnector({
      id: 'jsonplaceholder',
      version: '1.0.0',
      baseUrl: '${env.API_BASE_URL}',
      allowedOrigins: [origin],
      operations: {
        get_post: {
          path: '/posts/{post_id}',
          signature: getPostSig,
          mapResponse: (json) => ({
            title: (json as { title: string }).title,
            body: (json as { body: string }).body,
          }),
        },
      },
    });

    await expect(
      connector.invoke({
        operation: 'get_post',
        args: { post_id: '8' },
        credential,
        env: { API_BASE_URL: baseUrl },
      }),
    ).resolves.toEqual({ title: 't8', body: 'b8' });
  });
});
