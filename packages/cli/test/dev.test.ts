import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCustomerVerifierFactory } from '@noodle-borg/service';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runLocalTest, runSmoke } from '../src/commands/author-loop.js';
import { dev, writeConfig } from '../src/index.js';
import { setLocalConfigValue } from '../src/local-config.js';
import { chdirIsolated, restoreCwd } from './helpers/isolated-cwd.js';

const here = dirname(fileURLToPath(import.meta.url));
const examples = join(here, '..', '..', '..', 'examples');
const helloManifest = join(examples, 'hello', 'src', 'server.ts');
const VALID = `
import { server, tool, z } from '@noodleseed/one';

export default server('tmp', { title: 'Tmp', version: '1.0.0' }, [
  tool(
    'greet',
    {
      description: 'Greet.',
      input: z.object({ name: z.string() }),
      output: z.object({ message: z.string() }),
      fulfil: ({ input }) => ({ message: \`Hi, \${input.name}!\` }),
    },
  ),
]);
`;
const PUBLIC_ASSISTANT = `
import {
  embeddedAssistant,
  knowledge,
  openAICompatible,
  publicWebsite,
  secret,
  server,
  tool,
  variable,
  z,
} from '@noodleseed/one';

const product = knowledge('product', {
  title: 'Product knowledge',
  description: 'Product knowledge.',
  documents: [{ path: './knowledge/product.md', title: 'Product' }],
});

const greet = tool('greet', {
  description: 'Greet.',
  input: z.object({ name: z.string() }),
  output: z.object({ message: z.string() }),
  fulfil: ({ input }) => ({ message: \`Hi, \${input.name}!\` }),
});

export default server('public_tmp', {
  title: 'Public Tmp',
  version: '1.0.0',
  assistant: embeddedAssistant({
    model: openAICompatible({
      baseUrl: variable('MODEL_BASE_URL'),
      model: variable('MODEL_NAME'),
      apiKey: secret('MODEL_KEY'),
    }),
    access: publicWebsite({
      origins: ['http://127.0.0.1:3000'],
      capabilities: [product, greet],
      instructions: 'Use the local product evidence before making product claims.',
    }),
  }),
  knowledge: [product],
}, [greet]);
`;
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);
const DELEGATED_KEY_PATH = join('.noodle', 'devtools', 'delegated-exchange-signing-key.pem');
const DELEGATED_CONNECTORS = `
connectors:
  - id: delegated_crm
    version: 1.0.0
    http:
      baseUrl: https://crm.example.test/v1
      allowedOrigins:
        - https://crm.example.test
      auth:
        kind: delegatedTokenExchange
        tokenUrl: https://crm.example.test/oauth/token
        clientId: \${env.DELEGATED_CLIENT_ID}
        clientSecret: DELEGATED_CLIENT_SECRET
        scopes:
          - records:read
        audience: crm-api
    operations:
      list:
        type: read
        method: GET
        path: /records
        output:
          type: object
          additionalProperties: true
`;

function configureDelegatedExchange(projectRoot: string, app: string): void {
  const scope = { level: 'env' as const, org: 'local', app, env: 'dev' };
  setLocalConfigValue(projectRoot, {
    kind: 'secret',
    scope,
    name: 'DELEGATED_CLIENT_SECRET',
    value: ['local', 'connector', 'credential'].join('-'),
  });
  setLocalConfigValue(projectRoot, {
    kind: 'variable',
    scope,
    name: 'DELEGATED_CLIENT_ID',
    value: 'local-client-id',
  });
}

function nestedDelegatedAuthorLoopProject(app: string): {
  readonly serverPath: string;
  readonly connectorsPath: string;
  readonly nestedDirectory: string;
} {
  const sourceDirectory = join(tmp, 'src');
  const nestedDirectory = join(sourceDirectory, 'nested');
  const serverPath = join(sourceDirectory, 'server.ts');
  const connectorsPath = join(tmp, 'connectors.yaml');
  mkdirSync(nestedDirectory, { recursive: true });
  writeFileSync(
    join(tmp, 'noodle.json'),
    JSON.stringify({ name: app, entrypoint: 'src/server.ts' }),
  );
  writeFileSync(serverPath, VALID);
  writeFileSync(connectorsPath, DELEGATED_CONNECTORS);
  configureDelegatedExchange(tmp, app);
  return { serverPath, connectorsPath, nestedDirectory };
}

/** A single stateless MCP POST (mirrors the dev exercise path). */
async function mcp(
  endpoint: string,
  method: string,
  params: Record<string, unknown>,
  bearer?: string,
) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-11-25',
      ...(bearer !== undefined ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await res.json().catch(() => undefined)) as
    | {
        result?: {
          tools?: Array<{
            name: string;
          }>;
          structuredContent?: {
            message?: string;
          };
          contents?: Array<{
            text?: string;
          }>;
        };
        error?: unknown;
      }
    | undefined;
  return { status: res.status, body };
}
let tmp: string;
let homeBefore: string | undefined;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'noodle-dev-'));
  chdirIsolated(tmp);
  homeBefore = process.env.HOME;
  process.env.HOME = tmp;
});
afterEach(() => {
  restoreCwd();
  if (homeBefore === undefined) delete process.env.HOME;
  else process.env.HOME = homeBefore;
  rmSync(tmp, { recursive: true, force: true });
});
describe('dev()', () => {
  it('provisions and serves a process-local public assistant embed', async () => {
    const file = join(tmp, 'server.ts');
    mkdirSync(join(tmp, 'knowledge'));
    writeFileSync(join(tmp, 'knowledge', 'product.md'), '# Product\nGrounded local knowledge.');
    writeFileSync(file, PUBLIC_ASSISTANT);
    const scope = { level: 'env' as const, org: 'local', app: 'public-dev', env: 'dev' };
    setLocalConfigValue(tmp, {
      kind: 'variable',
      scope,
      name: 'MODEL_BASE_URL',
      value: 'https://model.example.test/v1',
    });
    setLocalConfigValue(tmp, {
      kind: 'variable',
      scope,
      name: 'MODEL_NAME',
      value: 'test-model',
    });
    setLocalConfigValue(tmp, {
      kind: 'secret',
      scope,
      name: 'MODEL_KEY',
      value: 'test-model-key',
    });
    setLocalConfigValue(tmp, {
      kind: 'variable',
      scope,
      name: 'NOODLE_KNOWLEDGE_ENABLED',
      value: 'true',
    });
    const lines: string[] = [];
    const handle = await dev({
      manifestPath: file,
      projectRoot: tmp,
      app: 'public-dev',
      interactive: false,
      watch: false,
      log: (line) => lines.push(line),
    });
    try {
      expect(handle.boot.ok, JSON.stringify(handle.boot)).toBe(true);
      expect(handle.boot.embedId).toMatch(/^pub_[a-z0-9]{24}$/u);
      expect(lines).toContain(`Embed ID:     ${handle.boot.embedId}`);
      expect(handle.assistantInstructions()).toBe(
        'Use the local product evidence before making product claims.',
      );

      const minted = await fetch(`${handle.origin}/v1/assistant/public-sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:3000' },
        body: JSON.stringify({
          embedId: handle.boot.embedId,
          origin: 'http://127.0.0.1:3000',
        }),
      });
      expect(minted.status).toBe(201);
      expect(await minted.json()).toMatchObject({ token: expect.any(String) });
    } finally {
      await handle.close();
    }
  });

  it('does not create delegated-exchange key state for an app without delegated bindings', async () => {
    const file = join(tmp, 'server.ts');
    writeFileSync(file, VALID);
    const handle = await dev({
      manifestPath: file,
      projectRoot: tmp,
      interactive: false,
      watch: false,
      log: () => {},
    });
    try {
      expect(handle.boot.ok).toBe(true);
      expect(handle.localDelegatedExchange()).toBeUndefined();
      expect(existsSync(join(tmp, DELEGATED_KEY_PATH))).toBe(false);
    } finally {
      await handle.close();
    }
  });

  it('lazily resolves public delegated-exchange trust and keeps its issuer across restarts', async () => {
    const file = join(tmp, 'server.ts');
    const connectorsPath = join(tmp, 'connectors.yaml');
    writeFileSync(file, VALID);
    writeFileSync(connectorsPath, DELEGATED_CONNECTORS);
    configureDelegatedExchange(tmp, 'delegated-dev');

    const first = await dev({
      manifestPath: file,
      connectorsPath,
      projectRoot: tmp,
      app: 'delegated-dev',
      interactive: false,
      watch: false,
      log: () => {},
    });
    let issuer: string;
    try {
      expect(first.boot.ok).toBe(true);
      expect(existsSync(join(tmp, DELEGATED_KEY_PATH))).toBe(true);
      const status = first.localDelegatedExchange();
      expect(status).toMatchObject({
        issuer: expect.stringMatching(/^urn:noodleseed:devtools:/u),
        trustChanged: false,
        bindings: [
          {
            bindingKey: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
            connectorId: 'delegated_crm',
            verified: false,
          },
        ],
      });
      expect(status?.jwks.keys).toHaveLength(1);
      expect(status?.jwks.keys[0]).toMatchObject({ alg: 'RS256', use: 'sig' });
      expect(status?.jwks.keys[0]).not.toHaveProperty('d');
      expect(status).not.toHaveProperty('signer');
      expect(status).not.toHaveProperty('path');
      issuer = status?.issuer as string;
    } finally {
      await first.close();
    }

    const restarted = await dev({
      manifestPath: file,
      connectorsPath,
      projectRoot: tmp,
      app: 'delegated-dev',
      interactive: false,
      watch: false,
      log: () => {},
    });
    try {
      expect(restarted.boot.ok).toBe(true);
      expect(restarted.localDelegatedExchange()?.issuer).toBe(issuer);
    } finally {
      await restarted.close();
    }
  });

  it('returns a structured boot error for an unsafe delegated-exchange key', async () => {
    const file = join(tmp, 'server.ts');
    const connectorsPath = join(tmp, 'connectors.yaml');
    const keyDirectory = join(tmp, '.noodle', 'devtools');
    const keyPath = join(tmp, DELEGATED_KEY_PATH);
    writeFileSync(file, VALID);
    writeFileSync(connectorsPath, DELEGATED_CONNECTORS);
    configureDelegatedExchange(tmp, 'delegated-invalid-key');
    mkdirSync(keyDirectory, { recursive: true, mode: 0o700 });
    chmodSync(keyDirectory, 0o700);
    writeFileSync(keyPath, 'not a private signing key', { mode: 0o600 });

    const handle = await dev({
      manifestPath: file,
      connectorsPath,
      projectRoot: tmp,
      app: 'delegated-invalid-key',
      interactive: false,
      watch: false,
      log: () => {},
    });
    try {
      expect(handle.boot).toEqual({
        ok: false,
        errors: [
          {
            code: 'local_delegated_exchange_key_invalid',
            path: keyPath,
            message: expect.stringMatching(
              /secure or remove.*start again.*update development endpoint trust/iu,
            ),
          },
        ],
      });
      expect(handle.localDelegatedExchange()).toBeUndefined();
    } finally {
      await handle.close();
    }
  });

  it('keeps delegated-exchange state on failed reload and replaces it after full success', async () => {
    const file = join(tmp, 'server.ts');
    const connectorsPath = join(tmp, 'connectors.yaml');
    writeFileSync(file, VALID);
    writeFileSync(connectorsPath, DELEGATED_CONNECTORS);
    configureDelegatedExchange(tmp, 'delegated-reload');
    const handle = await dev({
      manifestPath: file,
      connectorsPath,
      projectRoot: tmp,
      app: 'delegated-reload',
      interactive: false,
      watch: false,
      log: () => {},
    });
    try {
      const initial = handle.localDelegatedExchange();
      expect(initial?.bindings).toHaveLength(1);

      writeFileSync(connectorsPath, 'connectors: [');
      expect(await handle.reload()).toMatchObject({ ok: false });
      expect(handle.localDelegatedExchange()).toEqual(initial);

      writeFileSync(
        connectorsPath,
        DELEGATED_CONNECTORS.replaceAll('delegated_crm', 'delegated_calendar'),
      );
      expect(await handle.reload()).toMatchObject({ ok: true });
      expect(handle.localDelegatedExchange()).toMatchObject({
        issuer: initial?.issuer,
        trustChanged: false,
        bindings: [{ connectorId: 'delegated_calendar', verified: false }],
      });
      expect(handle.localDelegatedExchange()?.bindings[0]?.bindingKey).not.toBe(
        initial?.bindings[0]?.bindingKey,
      );
    } finally {
      await handle.close();
    }
  });

  it('serves a manifest in-process over open loopback auth and reloads cleanly', async () => {
    const handle = await dev({
      manifestPath: helloManifest,
      app: 'hello',
      interactive: false,
      watch: false,
      log: () => {},
    });
    try {
      expect(handle.url).toMatch(/\/o\/local\/hello\/dev\/mcp$/);
      expect(handle.url).toContain('127.0.0.1');
      const list = await mcp(handle.url, 'tools/list', {});
      expect(list.status).toBe(200);
      const names = (list.body?.result?.tools ?? []).map((t: { name: string }) => t.name);
      expect(names).toContain('greet');
      const r = await handle.reload();
      expect(r.ok).toBe(true);
      const call = await mcp(handle.url, 'tools/call', {
        name: 'greet',
        arguments: { name: 'Ada' },
      });
      expect(call.status).toBe(200);
      expect(call.body?.result?.structuredContent?.message).toBe('Hello, Ada!');
    } finally {
      await handle.close();
    }
  });
  it('serves Help anonymously with explicit mixed auth, rejects invalid credentials, and preserves policy on reload', async () => {
    const file = join(tmp, 'server.ts');
    const source = `import { customerAuth, server, tool, z } from '@noodleseed/one';
export default server('mixed_dev', { title: 'Mixed Dev', version: '1.0.0', auth: customerAuth.oidc({ issuer: 'https://login.example.test', audience: 'api://mixed-dev' }) }, [
  tool('help', { description: 'Help', input: z.object({}), fulfil: () => ({ message: 'Help is available' }) }),
  tool('orders', { description: 'Orders', input: z.object({}), authorization: { requiredScopes: ['orders:read'], discovery: 'public' }, fulfil: () => ({ orders: [] }) })
]);`;
    writeFileSync(file, source);
    const handle = await dev({
      manifestPath: file,
      accessMode: 'mixed',
      interactive: false,
      watch: false,
      log: () => {},
    });
    try {
      expect(handle.boot).toMatchObject({ ok: true });
      expect(await mcp(handle.url, 'tools/list', {})).toHaveProperty('status', 200);
      expect(await mcp(handle.url, 'tools/call', { name: 'help', arguments: {} })).toHaveProperty(
        'status',
        200,
      );
      const protectedCall = await mcp(handle.url, 'tools/call', { name: 'orders', arguments: {} });
      expect(protectedCall.status).toBe(401);
      expect(
        await mcp(handle.url, 'tools/call', { name: 'help', arguments: {} }, 'invalid'),
      ).toHaveProperty('status', 401);
      writeFileSync(file, source.replace('Help is available', 'Updated help'));
      expect(await handle.reload()).toMatchObject({ ok: true });
      expect(await mcp(handle.url, 'tools/call', { name: 'help', arguments: {} })).toHaveProperty(
        'status',
        200,
      );
      expect(await mcp(handle.url, 'tools/call', { name: 'orders', arguments: {} })).toHaveProperty(
        'status',
        401,
      );
    } finally {
      await handle.close();
    }
  });

  it('rejects explicit local customers access when auth is undeclared', async () => {
    const file = join(tmp, 'server.ts');
    writeFileSync(file, VALID);
    const handle = await dev({
      manifestPath: file,
      accessMode: 'customers',
      interactive: false,
      watch: false,
      log: () => {},
    });
    try {
      expect(handle.boot).toMatchObject({ ok: false, errors: [{ code: 'server_auth_required' }] });
    } finally {
      await handle.close();
    }
  });

  it('protects an auth-declared app and exposes only its sanitized Devtools auth projection', async () => {
    const file = join(tmp, 'server.ts');
    writeFileSync(
      file,
      `
import { customerAuth, server, tool, z } from '@noodleseed/one';

export default server('private_dev', {
  title: 'Private Dev',
  version: '1.0.0',
  auth: customerAuth.oidc({
    issuer: 'https://login.example.test',
    audience: 'api://private-dev'
  })
}, [
  tool('whoami', {
    description: 'Show the caller.',
    input: z.object({}),
    fulfil: ({ user }) => ({ subject: user.subject })
  })
]);
`,
    );
    const handle = await dev({
      manifestPath: file,
      app: 'private-dev',
      interactive: false,
      watch: false,
      log: () => {},
    });
    try {
      expect(handle.boot).toMatchObject({ ok: true });
      expect(handle.customerAuth()).toMatchObject({
        kind: 'oidc',
        issuer: 'https://login.example.test',
      });
      expect(handle.customerAuth()).not.toHaveProperty('audience');
      expect(handle.customerAuth()).toHaveProperty('configurationKey');
      expect(await mcp(handle.url, 'tools/list', {})).toHaveProperty('status', 401);
      expect(handle.boot.toolNames).toContain('whoami');
    } finally {
      await handle.close();
    }
  });
  it('projects federated issuers without exposing audiences or claim mappings to Devtools', async () => {
    const file = join(tmp, 'server.ts');
    writeFileSync(
      file,
      `
import { customerAuth, server, tool, z } from '@noodleseed/one';

export default server('federated_private_dev', {
  title: 'Federated Private Dev',
  version: '1.0.0',
  auth: customerAuth.federatedOidc({
    issuers: [
      {
        issuer: 'https://workforce.example.test',
        audience: 'api://workforce-private',
        claims: { roles: 'realm.roles' }
      },
      {
        issuer: 'https://customers.example.test',
        audience: 'api://customer-private',
        claims: { tenant: 'tenant.id' }
      }
    ]
  })
}, [
  tool('whoami', {
    description: 'Show the caller.',
    input: z.object({}),
    fulfil: ({ user }) => ({ subject: user.subject })
  })
]);
`,
    );
    const handle = await dev({
      manifestPath: file,
      app: 'federated-private-dev',
      interactive: false,
      watch: false,
      log: () => {},
    });
    try {
      expect(handle.boot).toMatchObject({ ok: true });
      expect(handle.customerAuth()).toEqual({
        kind: 'federatedOidc',
        issuers: ['https://workforce.example.test', 'https://customers.example.test'],
        configurationKey: expect.stringMatching(/^[A-Za-z0-9_-]+$/u),
      });
      expect(JSON.stringify(handle.customerAuth())).not.toMatch(
        /workforce-private|customer-private|realm\.roles|tenant\.id/u,
      );
      expect(await mcp(handle.url, 'tools/list', {})).toHaveProperty('status', 401);
    } finally {
      await handle.close();
    }
  });
  it('projects public Firebase web config and verifies its ID token only in local Devtools mode', async () => {
    const projectId = 'local-firebase-project';
    const keys = await generateKeyPair('RS256', { extractable: true });
    const publicJwk = await exportJWK(keys.publicKey);
    const idToken = await new SignJWT({
      email: 'ada@example.test',
      app_permissions: ['orders:read'],
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'firebase-local-key' })
      .setIssuer(`https://securetoken.google.com/${projectId}`)
      .setAudience(projectId)
      .setSubject('firebase-ada')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(keys.privateKey);
    const firebaseJwks = {
      keys: [{ ...publicJwk, kid: 'firebase-local-key', alg: 'RS256' }],
    };
    await expect(
      createCustomerVerifierFactory({ firebaseJwks })({
        kind: 'bridge',
        provider: 'firebase',
        projectId,
        user: { scopes: 'app_permissions' },
      })(idToken, projectId),
    ).resolves.toMatchObject({ caller: { subject: 'firebase-ada', scopes: ['orders:read'] } });
    const file = join(tmp, 'server.ts');
    writeFileSync(
      file,
      `
import { customerAuth, server, tool, z } from '@noodleseed/one';

export default server('firebase_private_dev', {
  title: 'Firebase Private Dev',
  version: '1.0.0',
  auth: customerAuth.firebase({
    projectId: '${projectId}',
    apiKey: 'public-firebase-web-key',
    authDomain: '${projectId}.firebaseapp.com',
    appId: 'firebase-app-id',
    tenantId: 'firebase-tenant',
    authorizeUrl: 'https://auth.example.test/firebase',
    user: { scopes: 'app_permissions' }
  })
}, [
  tool('whoami', {
    description: 'Show the caller.',
    input: z.object({}),
    fulfil: ({ user }) => ({ subject: user.subject })
  })
]);
`,
    );
    const handle = await dev({
      manifestPath: file,
      app: 'firebase-private-dev',
      interactive: false,
      watch: false,
      log: () => {},
      customerVerifierFirebaseJwks: firebaseJwks,
    });
    try {
      expect(handle.boot).toMatchObject({ ok: true });
      expect(handle.customerAuth()).toEqual({
        kind: 'firebase',
        projectId,
        apiKey: 'public-firebase-web-key',
        authDomain: `${projectId}.firebaseapp.com`,
        appId: 'firebase-app-id',
        tenantId: 'firebase-tenant',
        authorizeUrl: 'https://auth.example.test/firebase',
        configurationKey: expect.stringMatching(/^[A-Za-z0-9_-]+$/u),
      });
      expect(JSON.stringify(handle.customerAuth())).not.toMatch(/app_permissions|server\.auth/u);
      expect(await mcp(handle.url, 'tools/list', {})).toHaveProperty('status', 401);
      expect(await mcp(handle.url, 'tools/list', {}, idToken)).toHaveProperty('status', 200);
    } finally {
      await handle.close();
    }
  });
  it('resolves Microsoft variables and its confidential client secret only for the local auth host', async () => {
    const scope = {
      level: 'env' as const,
      org: 'local',
      app: 'microsoft-private-dev',
      env: 'dev',
    };
    setLocalConfigValue(tmp, {
      kind: 'variable',
      scope,
      name: 'MICROSOFT_TENANT_ID',
      value: '11111111-2222-3333-4444-555555555555',
    });
    setLocalConfigValue(tmp, {
      kind: 'variable',
      scope,
      name: 'MICROSOFT_CLIENT_ID',
      value: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });
    setLocalConfigValue(tmp, {
      kind: 'secret',
      scope,
      name: 'MICROSOFT_CLIENT_SECRET',
      value: 'local-microsoft-client-secret',
    });
    const file = join(tmp, 'server.ts');
    writeFileSync(
      file,
      `
import { customerAuth, secret, server, tool, variable, z } from '@noodleseed/one';

const tenantId = variable('MICROSOFT_TENANT_ID');

export default server('microsoft_private_dev', {
  title: 'Microsoft Private Dev',
  version: '1.0.0',
  auth: customerAuth.microsoft({
    tenantId,
    clientId: variable('MICROSOFT_CLIENT_ID'),
    clientSecret: secret('MICROSOFT_CLIENT_SECRET'),
    tokenUrl: \`https://login.microsoftonline.com/\${tenantId}/oauth2/v2.0/token\`,
    scopes: ['https://graph.microsoft.com/User.Read'],
    user: { roles: 'app_roles' }
  })
}, [
  tool('whoami', {
    description: 'Show the caller.',
    input: z.object({}),
    fulfil: ({ user }) => ({ subject: user.subject })
  })
]);
`,
    );
    const handle = await dev({
      manifestPath: file,
      app: 'microsoft-private-dev',
      interactive: false,
      watch: false,
      log: () => {},
    });
    try {
      expect(handle.boot).toMatchObject({ ok: true });
      expect(handle.customerAuth()).toEqual({
        kind: 'microsoft',
        tenantId: '11111111-2222-3333-4444-555555555555',
        clientId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        clientSecret: 'local-microsoft-client-secret',
        tokenUrl:
          'https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/oauth2/v2.0/token',
        scopes: ['https://graph.microsoft.com/User.Read'],
        configurationKey: expect.stringMatching(/^[A-Za-z0-9_-]+$/u),
      });
      expect(JSON.stringify(handle.customerAuth())).not.toMatch(/app_roles|server\.auth/u);
      expect(await mcp(handle.url, 'tools/list', {})).toHaveProperty('status', 401);
    } finally {
      await handle.close();
    }
  });
  it('keeps serving (no key) on an initially broken server.ts, then reload fixes it', async () => {
    const file = join(tmp, 'server.ts');
    writeFileSync(file, 'export default 42;\n'); // invalid public authoring module
    const handle = await dev({
      manifestPath: file,
      app: 'fixme',
      interactive: false,
      watch: false,
      log: () => {},
    });
    try {
      // Fix the file and reload.
      writeFileSync(file, VALID);
      const r = await handle.reload();
      expect(r.ok).toBe(true);
      const list = await mcp(handle.url, 'tools/list', {});
      expect((list.body?.result?.tools ?? []).map((t: { name: string }) => t.name)).toContain(
        'greet',
      );
    } finally {
      await handle.close();
    }
  });
  it('stays permissive on a faulty widget CSP — dev renders the widget, only deploy gates it', async () => {
    // A scheme-less CSP origin (host would drop it) is a deploy-gate error, but `noodle dev` must not be
    // blocked by it: the local author loop still compiles, serves the widget, and lists its tool.
    const file = join(tmp, 'server.ts');
    writeFileSync(
      file,
      `
import { server, tool, z } from '@noodleseed/one';

export default server('shop', { title: 'Shop', version: '1.0.0' }, [
  tool('open_cart', {
    description: 'Open the cart.',
    input: z.object({}),
    output: z.object({ ok: z.string() }),
    fulfil: () => ({ ok: 'yes' }),
    viewName: 'cart',
    view: { html: '<!doctype html><main>Cart</main>' },
    csp: { connectDomains: ['api.shop.example.com'] },
  }),
]);
`,
    );
    const handle = await dev({
      manifestPath: file,
      app: 'shop',
      interactive: false,
      watch: false,
      log: () => {},
    });
    try {
      const list = await mcp(handle.url, 'tools/list', {});
      expect(list.status).toBe(200);
      expect((list.body?.result?.tools ?? []).map((t: { name: string }) => t.name)).toContain(
        'open_cart',
      );
      // The widget resource is served (the app loaded despite the faulty CSP).
      const resources = await mcp(handle.url, 'resources/list', {});
      expect(resources.status).toBe(200);
    } finally {
      await handle.close();
    }
  });

  it('defaults the app slug to the containing directory for a generic TypeScript entrypoint', async () => {
    const handle = await dev({
      manifestPath: helloManifest, // examples/hello/src/server.ts → app "hello"
      interactive: false,
      watch: false,
      log: () => {},
    });
    try {
      expect(handle.url).toContain('/o/local/hello/dev/mcp');
    } finally {
      await handle.close();
    }
  });
  it('serves referenced packaged assets from loopback local dev routes only', async () => {
    mkdirSync(join(tmp, 'assets'));
    writeFixtureWidget(tmp);
    writeFileSync(join(tmp, 'assets', 'logo.png'), PNG_1X1);
    const file = join(tmp, 'server.ts');
    writeFileSync(
      file,
      `
import { asset, server, tool, z } from '@noodleseed/one';

const logo = asset('./assets/logo.png');

export default server('asset_dev', {
  title: 'Asset Dev',
  version: '1.0.0',
  branding: { logo: { uri: logo, alt: 'Asset Dev logo' } },
}, [
  tool(
    'show',
    {
      description: 'Show local media.',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      fulfil: () => ({ ok: true }),
      viewTitle: 'Media',
      view: { component: 'FixtureWidget', entry: './views/FixtureWidget.tsx' },
    },
  ),
]);
`,
    );
    const handle = await dev({
      manifestPath: file,
      app: 'assets',
      interactive: false,
      watch: false,
      log: () => {},
    });
    try {
      const read = await mcp(handle.url, 'resources/read', { uri: 'ui://asset_dev/show_widget' });
      const html = read.body?.result?.contents?.[0]?.text ?? '';
      const match = html.match(/http:\/\/127\.0\.0\.1:\d+\/__noodle\/assets\/[^"]+logo\.png/);
      expect(match?.[0]).toBeDefined();
      const assetUrl = match?.[0] as string;
      const assetRes = await fetch(assetUrl);
      expect(assetRes.status).toBe(200);
      expect(assetRes.headers.get('content-type')).toBe('image/png');
      expect(assetRes.headers.get('x-content-type-options')).toBe('nosniff');
      expect(assetRes.headers.get('cache-control')).toBe('no-cache');
      expect(Buffer.from(await assetRes.arrayBuffer())).toEqual(PNG_1X1);
      const outside = await fetch(`${handle.origin}/__noodle/assets/not-referenced/hash/logo.png`);
      expect(outside.status).toBe(404);
    } finally {
      await handle.close();
    }
  });
});

describe('unresolved connector secret', () => {
  const apiKeyFixture = join(here, 'fixtures', 'api-key-server.ts');
  const embeddedAssistantFixture = join(here, 'fixtures', 'embedded-assistant', 'server.ts');

  function localApiKeyServer(): string {
    const server = join(tmp, 'api-key-server.ts');
    copyFileSync(apiKeyFixture, server);
    return server;
  }

  function localEmbeddedAssistantServer(): string {
    const dir = join(tmp, 'embedded-assistant');
    const server = join(dir, 'server.ts');
    mkdirSync(dir, { recursive: true });
    copyFileSync(embeddedAssistantFixture, server);
    return server;
  }

  it('boots local dev from matching values in the project .env', async () => {
    writeFileSync(join(tmp, '.env'), 'API_NINJAS_KEY=local-dev-key\n');
    const handle = await dev({
      manifestPath: apiKeyFixture,
      app: 'api-facts',
      interactive: false,
      watch: false,
      log: () => {},
    });
    try {
      expect(handle.boot.ok).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it('exposes the boot deploy result with the missing_secret error', async () => {
    // The connector requires API_NINJAS_KEY; it is not set locally, so the boot deploy fails closed.
    const handle = await dev({
      manifestPath: apiKeyFixture,
      app: 'api-facts',
      interactive: false,
      watch: false,
      log: () => {},
    });
    try {
      expect(handle.boot.ok).toBe(false);
      const codes = (handle.boot.errors ?? []).map((e) => e.code);
      expect(codes).toContain('missing_secret');
    } finally {
      await handle.close();
    }
  });

  it('runLocalTest reports connector_secret_unresolved, not an opaque smoke failure', async () => {
    const apiKeyServer = localApiKeyServer();
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((m: unknown) => {
      logs.push(String(m));
    });
    try {
      const code = await runLocalTest([apiKeyServer, '--json']);
      expect(code).not.toBe(0);
      const envelope = JSON.parse(logs.at(-1) ?? '{}') as {
        ok: boolean;
        error?: { code?: string; fix?: string; detail?: { secrets?: string[] } };
      };
      expect(envelope.ok).toBe(false);
      expect(envelope.error?.code).toBe('connector_secret_unresolved');
      expect(envelope.error?.detail?.secrets).toContain('API_NINJAS_KEY');
      expect(envelope.error?.fix).toContain(
        '--runtime local --scope env --org local --app api-key-server --env dev',
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('reports the exact linked environment in the missing-secret recovery command', async () => {
    const apiKeyServer = localApiKeyServer();
    const cwd = process.cwd();
    mkdirSync(join(tmp, '.noodle'));
    writeFileSync(
      join(tmp, '.noodle', 'project.json'),
      JSON.stringify({
        entrypoint: apiKeyServer,
        org: 'noodleseed',
        app: 'acmehr-assistant',
        env: 'dev',
        serviceUrl: 'https://cloud.noodleseed.dev',
        accessMode: 'customers',
      }),
    );
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((m: unknown) => logs.push(String(m)));
    process.chdir(tmp);
    try {
      expect(await runLocalTest([apiKeyServer, '--json'])).not.toBe(0);
      const envelope = JSON.parse(logs.at(-1) ?? '{}') as {
        error?: { fix?: string; detail?: { target?: unknown } };
      };
      expect(envelope.error?.fix).toContain(
        '--scope env --org noodleseed --app acmehr-assistant --env dev',
      );
      expect(envelope.error?.detail?.target).toEqual({
        org: 'noodleseed',
        app: 'acmehr-assistant',
        env: 'dev',
      });
    } finally {
      process.chdir(cwd);
      spy.mockRestore();
    }
  });

  it('reports unresolved variables before attempting the MCP smoke', async () => {
    const embeddedAssistantServer = localEmbeddedAssistantServer();
    const cwd = process.cwd();
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((m: unknown) => logs.push(String(m)));
    process.chdir(tmp);
    writeFileSync(join(tmp, 'noodle.json'), JSON.stringify({ name: 'customer-auth-demo' }));
    writeConfig(
      {
        defaultRuntime: 'cloud',
        defaultOrg: 'hosted-org',
        defaultApp: 'other-app',
        defaultEnv: 'prod',
      },
      tmp,
    );
    setLocalConfigValue(tmp, {
      kind: 'secret',
      scope: { level: 'env', org: 'local', app: 'customer-auth-demo', env: 'dev' },
      name: 'ASSISTANT_MODEL_API_KEY',
      value: 'test-only',
    });
    try {
      expect(await runLocalTest([embeddedAssistantServer, '--json'])).not.toBe(0);
      const envelope = JSON.parse(logs.at(-1) ?? '{}') as {
        error?: { code?: string; detail?: { variables?: string[] } };
      };
      expect(envelope.error?.code).toBe('variable_unresolved');
      expect(envelope.error?.detail?.variables).toEqual([
        'ASSISTANT_MODEL',
        'ASSISTANT_MODEL_BASE_URL',
      ]);
      expect(envelope.error?.detail).toMatchObject({
        target: { org: 'local', app: 'customer-auth-demo', env: 'dev' },
      });
      expect(envelope.error?.next).toBe('noodle link');
      expect(JSON.stringify(envelope)).not.toMatch(/hosted-org|other-app|prod/u);
    } finally {
      process.chdir(cwd);
      spy.mockRestore();
    }
  });

  it('runSmoke (tools list) reports connector_secret_unresolved, not an opaque mcp_error', async () => {
    const apiKeyServer = localApiKeyServer();
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((m: unknown) => {
      logs.push(String(m));
    });
    try {
      const code = await runSmoke('tools', ['list', apiKeyServer, '--json']);
      expect(code).not.toBe(0);
      const envelope = JSON.parse(logs.at(-1) ?? '{}') as {
        ok: boolean;
        error?: { code?: string };
      };
      expect(envelope.ok).toBe(false);
      expect(envelope.error?.code).toBe('connector_secret_unresolved');
    } finally {
      spy.mockRestore();
    }
  });

  it('runs local test from a nested directory with the containing project config and signing key root', async () => {
    const project = nestedDelegatedAuthorLoopProject('nested-local-test');
    process.chdir(project.nestedDirectory);

    expect(
      await runLocalTest([project.serverPath, '--connectors', project.connectorsPath, '--json']),
    ).toBe(0);
    expect(existsSync(join(tmp, DELEGATED_KEY_PATH))).toBe(true);
    expect(existsSync(join(project.nestedDirectory, DELEGATED_KEY_PATH))).toBe(false);
  });

  it('runs a local exercise from a nested directory with the containing project config and signing key root', async () => {
    const project = nestedDelegatedAuthorLoopProject('nested-local-exercise');
    process.chdir(project.nestedDirectory);

    expect(
      await runSmoke('tools', [
        'list',
        project.serverPath,
        '--connectors',
        project.connectorsPath,
        '--json',
      ]),
    ).toBe(0);
    expect(existsSync(join(tmp, DELEGATED_KEY_PATH))).toBe(true);
    expect(existsSync(join(project.nestedDirectory, DELEGATED_KEY_PATH))).toBe(false);
  });
});

function writeFixtureWidget(root: string): void {
  mkdirSync(join(root, 'views'));
  writeFileSync(
    join(root, 'views', 'FixtureWidget.tsx'),
    'export default function FixtureWidget() { return <main>Fixture widget ready</main>; }\n',
  );
}
