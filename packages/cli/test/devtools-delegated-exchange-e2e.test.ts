import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JSONWebKeySet,
  type JWTPayload,
  jwtVerify,
  SignJWT,
} from 'jose';
import { describe, expect, it } from 'vitest';
import { writeConfig } from '../src/config.js';
import { startPreview } from '../src/devtools-preview.js';
import { dev } from '../src/index.js';
import { setLocalConfigValue } from '../src/local-config.js';
import { resolveEffectiveLocalTarget } from '../src/local-target.js';

const APP = 'delegated-exchange-e2e';
const SERVER_NAME = 'delegated_exchange_e2e';
const OIDC_AUDIENCE = 'api://delegated-exchange-e2e';
const EXCHANGE_AUDIENCE = 'urn:delegated-exchange-e2e:downstream';
const INITIAL_EXCHANGE_AUDIENCE = 'urn:delegated-exchange-e2e:before-variable-change';
const EXCHANGE_AUDIENCE_VARIABLE = 'LOCAL_EXCHANGE_AUDIENCE';
const CLIENT_ID = 'local-exchange-client';
const CLIENT_SECRET_NAME = 'LOCAL_EXCHANGE_CLIENT_SECRET';
const SUBJECT = 'customer-user-7';
const EMAIL = 'pat@example.test';
const NAME = 'Pat Example';
const KEY_PATH = join('.noodle', 'devtools', 'delegated-exchange-signing-key.pem');
const LINKED_TARGET = { org: 'acme', app: APP, env: 'staging' } as const;
const UNLINKED_APP = 'unlinked-delegated-exchange';

interface ExchangeStatus {
  readonly issuer: string;
  readonly jwks: JSONWebKeySet;
  readonly tenant: string;
  readonly deployment: string;
  readonly customerSignedIn: boolean;
  readonly trustChanged: boolean;
  readonly bindings: readonly {
    readonly bindingKey: string;
    readonly connectorId: string;
    readonly operation?: string;
    readonly audience: string;
    readonly verified: boolean;
  }[];
}

interface CapturedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

interface VerifiedExchange {
  readonly protectedHeader: Record<string, unknown>;
  readonly payload: JWTPayload;
}

function randomCredential(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString('base64url')}`;
}

describe('local Devtools delegated token exchange', () => {
  it('synchronizes a live managed audience before assertion exchange and downstream validation', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'noodle-delegated-exchange-e2e-'));
    const cleanup: Array<() => void | Promise<void>> = [
      () => rmSync(projectRoot, { recursive: true }),
    ];
    const clientSecret = randomCredential('client-secret');
    const downstreamToken = randomCredential('downstream-token');

    try {
      const oidc = await fakeOidcIssuer();
      cleanup.push(oidc.close);
      const exchange = await fakeExchangeEndpoint({
        clientSecret,
        downstreamToken,
        customerIssuer: () => oidc.issuer,
      });
      cleanup.push(exchange.close);
      const downstream = await fakeDownstreamApi(downstreamToken);
      cleanup.push(downstream.close);

      const serverPath = join(projectRoot, 'server.ts');
      writeFileSync(
        serverPath,
        authoredServer({
          issuer: oidc.issuer,
          exchangeUrl: exchange.url,
          exchangeOrigin: exchange.origin,
          downstreamOrigin: downstream.origin,
          exchangeAudienceVariable: EXCHANGE_AUDIENCE_VARIABLE,
        }),
      );
      mkdirSync(join(projectRoot, '.noodle'), { recursive: true });
      writeFileSync(
        join(projectRoot, '.noodle', 'project.json'),
        JSON.stringify({
          entrypoint: 'server.ts',
          ...LINKED_TARGET,
          serviceUrl: 'https://borg.noodleseed.com',
          accessMode: 'customers',
        }),
      );
      const targetResolution = resolveEffectiveLocalTarget({
        cwd: projectRoot,
        manifestPath: serverPath,
      });
      expect(targetResolution).toMatchObject({ target: LINKED_TARGET, mode: 'linked' });
      setLocalConfigValue(projectRoot, {
        kind: 'secret',
        scope: { level: 'env', ...LINKED_TARGET },
        name: CLIENT_SECRET_NAME,
        value: clientSecret,
      });
      setLocalConfigValue(projectRoot, {
        kind: 'variable',
        scope: { level: 'env', ...LINKED_TARGET },
        name: EXCHANGE_AUDIENCE_VARIABLE,
        value: INITIAL_EXCHANGE_AUDIENCE,
      });

      const devLog: string[] = [];
      const handle = await dev({
        manifestPath: serverPath,
        projectRoot,
        ...targetResolution.target,
        interactive: false,
        watch: false,
        log: (line) => devLog.push(line),
        customerVerifierAllowInsecureLocalhost: true,
      });
      cleanup.push(handle.close);
      expect(handle.boot, JSON.stringify(handle.boot)).toMatchObject({
        ok: true,
        toolNames: ['read_profile'],
      });
      expect(handle.customerAuth()).toMatchObject({ kind: 'oidc', issuer: oidc.issuer });
      expect(handle.localDelegatedExchange()?.bindings).toEqual([
        expect.objectContaining({ connectorId: 'local_customer_api', verified: false }),
      ]);
      oidc.setExpectedResource(handle.url);

      const customerAuth = handle.customerAuth();
      const delegatedCredentialSink = handle.delegatedCredentialSink();
      const preview = await startPreview({
        mcpUrl: handle.url,
        theme: 'both',
        device: 'both',
        ...(customerAuth === undefined ? {} : { customerAuth }),
        ...(delegatedCredentialSink === undefined ? {} : { delegatedCredentialSink }),
        localDelegatedExchange: () => handle.localDelegatedExchange(),
      });
      cleanup.push(preview.close);

      const shell = await (await fetch(preview.url)).text();
      const capability = capabilityFrom(shell);
      expect(capability).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(Buffer.from(capability, 'base64url')).toHaveLength(32);

      const capabilityErrorResponse = await fetch(
        new URL('/delegated-exchange/status', preview.url),
        { headers: { 'x-noodle-devtools-capability': `${capability}wrong` } },
      );
      const capabilityError = await capabilityErrorResponse.text();
      expect(capabilityErrorResponse.status).toBe(403);
      expect(capabilityError).toBe('forbidden');

      const initialStatus = await exchangeStatus(preview.url, capability);
      expect(initialStatus).toMatchObject({
        issuer: expect.stringMatching(/^urn:noodleseed:devtools:/u),
        tenant: `${LINKED_TARGET.org}/${LINKED_TARGET.app}/${LINKED_TARGET.env}`,
        deployment: expect.stringMatching(new RegExp(`^${APP}-[0-9a-f]{8}$`, 'u')),
        customerSignedIn: false,
        trustChanged: false,
        bindings: [
          {
            connectorId: 'local_customer_api',
            audience: INITIAL_EXCHANGE_AUDIENCE,
            verified: false,
          },
        ],
      });
      expect(initialStatus.jwks.keys).toHaveLength(1);
      expect(initialStatus.jwks.keys[0]).not.toHaveProperty('d');
      exchange.installStatusReader(() => exchangeStatus(preview.url, capability));

      const start = await fetch(new URL('/auth/start', preview.url), {
        method: 'POST',
        headers: { 'x-noodle-devtools-capability': capability },
      });
      const startBody = (await start.json()) as { authorizationUrl: string };
      expect(start.status).toBe(200);
      const authorizationUrl = new URL(startBody.authorizationUrl);
      expect(authorizationUrl.origin).toBe(oidc.issuer);
      expect(authorizationUrl.searchParams.get('resource')).toBe(handle.url);
      expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
      expect(oidc.registrations).toEqual([
        expect.objectContaining({
          application_type: 'native',
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
        }),
      ]);
      const registeredRedirects = oidc.registrations[0]?.redirect_uris;
      expect(registeredRedirects).toEqual([
        expect.stringMatching(
          new RegExp(`^${escapeRegExp(preview.url)}auth/callback/[A-Za-z0-9_-]{32}$`, 'u'),
        ),
      ]);

      const authorize = await fetch(authorizationUrl, { redirect: 'manual' });
      expect(authorize.status).toBe(302);
      const callbackUrl = new URL(authorize.headers.get('location') ?? 'about:blank');
      expect(callbackUrl.origin).toBe(new URL(preview.url).origin);
      expect(callbackUrl.pathname).toMatch(/^\/auth\/callback\/[A-Za-z0-9_-]{32}$/u);
      expect(callbackUrl.searchParams.get('iss')).toBe(oidc.issuer);
      const callback = await fetch(callbackUrl);
      const callbackHtml = await callback.text();
      expect(callback.status).toBe(200);
      expect(callbackHtml).toContain('noodle:auth-complete');
      expect(oidc.pkceVerified()).toBe(true);
      expect(
        oidc.authorizationRequests.map((request) => request.searchParams.get('resource')),
      ).toEqual([handle.url]);
      expect(oidc.tokenRequests).toHaveLength(1);
      const oidcTokenRequest = oidc.tokenRequests[0] as CapturedRequest;
      const oidcTokenFields = new URLSearchParams(oidcTokenRequest.body);
      expect(oidcTokenRequest.headers.authorization).toBeUndefined();
      expect(oidcTokenFields.get('client_secret')).toBeNull();
      expect(oidcTokenFields.get('client_assertion')).toBeNull();
      expect(oidcTokenFields.get('client_assertion_type')).toBeNull();
      expect(oidcTokenFields.get('resource')).toBe(handle.url);

      const inboundAccessToken = oidc.accessToken();
      expect(inboundAccessToken).toBeTruthy();
      const inbound = await jwtVerify(inboundAccessToken as string, createLocalJWKSet(oidc.jwks), {
        issuer: oidc.issuer,
        audience: OIDC_AUDIENCE,
        algorithms: ['RS256'],
      });
      expect(inbound.payload).toMatchObject({
        sub: SUBJECT,
        email: EMAIL,
        name: NAME,
        resource: handle.url,
      });
      expect(inbound.payload.aud).toEqual([OIDC_AUDIENCE, handle.url]);
      expect(callbackHtml).not.toContain(inboundAccessToken as string);

      const authResponse = await fetch(new URL('/auth/status', preview.url), {
        headers: { 'x-noodle-devtools-capability': capability },
      });
      const authStatus = (await authResponse.json()) as Record<string, unknown>;
      expect(authStatus).toMatchObject({ state: 'signed_in', issuer: oidc.issuer });
      const signedInStatus = await exchangeStatus(preview.url, capability);
      expect(signedInStatus).toMatchObject({
        customerSignedIn: true,
        bindings: [{ connectorId: 'local_customer_api', verified: false }],
      });

      const initialBindingKey = initialStatus.bindings[0]?.bindingKey;
      setLocalConfigValue(projectRoot, {
        kind: 'variable',
        scope: { level: 'env', ...LINKED_TARGET },
        name: EXCHANGE_AUDIENCE_VARIABLE,
        value: EXCHANGE_AUDIENCE,
      });

      const toolResponse = await rpc(preview.url, capability, 'tools/call', {
        name: 'read_profile',
        arguments: {},
      });
      const toolBody = (await toolResponse.json()) as Record<string, unknown>;
      expect(toolResponse.status).toBe(200);
      expect(toolBody).toMatchObject({
        result: {
          structuredContent: { source: 'downstream', subject: SUBJECT },
        },
      });

      const verifiedStatus = await exchangeStatus(preview.url, capability);
      expect(verifiedStatus).toMatchObject({
        customerSignedIn: true,
        trustChanged: false,
        bindings: [
          {
            connectorId: 'local_customer_api',
            audience: EXCHANGE_AUDIENCE,
            verified: true,
          },
        ],
      });
      expect(verifiedStatus.bindings[0]?.bindingKey).not.toBe(initialBindingKey);
      expect(exchange.requests).toHaveLength(1);
      expect(exchange.verified).toHaveLength(1);
      expect(exchange.observedStatuses).toMatchObject([
        {
          bindings: [
            {
              connectorId: 'local_customer_api',
              audience: EXCHANGE_AUDIENCE,
              verified: false,
            },
          ],
        },
      ]);
      expect(downstream.requests).toHaveLength(1);

      const exchangeRequest = exchange.requests[0] as CapturedRequest;
      const exchangeFields = new URLSearchParams(exchangeRequest.body);
      const assertion = exchangeFields.get('subject_token');
      expect(assertion).toBeTruthy();
      expect(assertion).not.toBe(inboundAccessToken);
      expect(exchangeRequest.method).toBe('POST');
      expect(exchangeRequest.url).toBe(exchange.url);
      expect(exchangeRequest.headers.authorization).toBeUndefined();
      expect(exchangeFields.get('client_id')).toBe(CLIENT_ID);
      expect(exchangeFields.get('client_secret')).toBe(clientSecret);
      expect(exchangeFields.get('grant_type')).toBe(
        'urn:ietf:params:oauth:grant-type:token-exchange',
      );
      expect(exchangeFields.get('subject_token_type')).toBe('urn:ietf:params:oauth:token-type:jwt');
      expect(exchangeFields.get('scope')).toBe('profile:read');
      expect(exchangeFields.get('audience')).toBe(EXCHANGE_AUDIENCE);

      const verifiedAssertion = await jwtVerify(
        assertion as string,
        createLocalJWKSet(initialStatus.jwks),
        {
          issuer: initialStatus.issuer,
          audience: EXCHANGE_AUDIENCE,
          algorithms: ['RS256'],
        },
      );
      expect(verifiedAssertion.protectedHeader).toMatchObject({
        alg: 'RS256',
        typ: 'JWT',
        kid: initialStatus.jwks.keys[0]?.kid,
      });
      expect(verifiedAssertion.payload).toMatchObject({
        sub: SUBJECT,
        email: EMAIL,
        name: NAME,
        tenant: initialStatus.tenant,
        deployment: initialStatus.deployment,
        customer_identity: { version: 1, issuer: oidc.issuer },
        aud: EXCHANGE_AUDIENCE,
        jti: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
        ),
      });
      expectAssertionContext(
        verifiedAssertion.payload,
        exchange.observedStatuses[0] as ExchangeStatus,
      );
      expect(Object.keys(verifiedAssertion.payload).sort()).toEqual([
        'aud',
        'customer_identity',
        'deployment',
        'email',
        'exp',
        'iat',
        'iss',
        'jti',
        'name',
        'sub',
        'tenant',
      ]);
      const decodedAssertionWire = JSON.stringify(verifiedAssertion.payload);
      for (const credential of [
        inboundAccessToken as string,
        oidc.refreshToken,
        clientSecret,
        downstreamToken,
      ]) {
        expect(decodedAssertionWire).not.toContain(credential);
      }
      expect(typeof verifiedAssertion.payload.iat).toBe('number');
      expect(typeof verifiedAssertion.payload.exp).toBe('number');
      expect(
        (verifiedAssertion.payload.exp as number) - (verifiedAssertion.payload.iat as number),
      ).toBe(120);
      expect(verifiedAssertion.payload.iat as number).toBeLessThanOrEqual(
        Math.floor(Date.now() / 1000),
      );
      expect(exchange.verified[0]).toEqual({
        protectedHeader: verifiedAssertion.protectedHeader,
        payload: verifiedAssertion.payload,
      });

      writeFileSync(
        serverPath,
        authoredServer({
          issuer: oidc.issuer,
          exchangeUrl: exchange.url,
          exchangeOrigin: exchange.origin,
          downstreamOrigin: downstream.origin,
          title: 'Delegated Exchange E2E Reloaded',
        }),
      );
      expect(await handle.reload()).toMatchObject({ ok: true });
      const reloadedStatus = await exchangeStatus(preview.url, capability);
      expect(reloadedStatus).toMatchObject({
        tenant: initialStatus.tenant,
        bindings: [{ audience: EXCHANGE_AUDIENCE }],
      });
      expect(reloadedStatus.deployment).not.toBe(initialStatus.deployment);
      exchange.installStatus(reloadedStatus);

      const reloadedToolResponse = await rpc(preview.url, capability, 'tools/call', {
        name: 'read_profile',
        arguments: {},
      });
      expect(reloadedToolResponse.status).toBe(200);
      expect(exchange.requests).toHaveLength(2);
      expect(exchange.verified).toHaveLength(2);
      const reloadedAssertion = new URLSearchParams(
        (exchange.requests[1] as CapturedRequest).body,
      ).get('subject_token');
      expect(reloadedAssertion).toBeTruthy();
      const verifiedReloadedAssertion = await jwtVerify(
        reloadedAssertion as string,
        createLocalJWKSet(reloadedStatus.jwks),
        {
          issuer: reloadedStatus.issuer,
          audience: reloadedStatus.bindings[0]?.audience,
          algorithms: ['RS256'],
        },
      );
      expectAssertionContext(verifiedReloadedAssertion.payload, reloadedStatus);

      const downstreamRequest = downstream.requests[0] as CapturedRequest;
      expect(downstreamRequest).toMatchObject({
        method: 'GET',
        url: `${downstream.origin}/api/profile`,
        body: '',
      });
      expect(downstreamRequest.headers.authorization).toBe(`Bearer ${downstreamToken}`);
      expect(downstreamRequest.headers.cookie).toBeUndefined();
      expect(downstreamRequest.headers['x-api-key']).toBeUndefined();

      const exchangeWire = JSON.stringify(exchange.requests);
      const downstreamWire = JSON.stringify(downstream.requests);
      expect(exchangeWire).not.toContain(inboundAccessToken as string);
      expect(downstreamWire).not.toContain(inboundAccessToken as string);
      expect(downstreamWire).not.toContain(assertion as string);
      expect(downstreamWire).not.toContain(clientSecret);
      expect(
        occurrences(
          [
            oidcTokenRequest.body,
            JSON.stringify(oidcTokenRequest.headers),
            exchangeRequest.body,
            JSON.stringify(exchangeRequest.headers),
            downstreamWire,
          ].join('\n'),
          clientSecret,
        ),
      ).toBe(1);

      const serializedSafeOutput = JSON.stringify({
        boot: handle.boot,
        status: handle.localDelegatedExchange(),
        initialStatus,
        signedInStatus,
        verifiedStatus,
        reloadedStatus,
        authStatus,
        toolBody,
        activityLog: preview.log,
        error: capabilityError,
        devLog,
      });
      for (const credential of [
        inboundAccessToken as string,
        oidc.refreshToken,
        assertion as string,
        clientSecret,
        downstreamToken,
      ]) {
        expect(serializedSafeOutput).not.toContain(credential);
      }
    } finally {
      await runCleanup(cleanup);
    }
  });

  it('signs an unlinked project assertion with its deterministic local target', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'noodle-unlinked-delegated-exchange-e2e-'));
    const home = mkdtempSync(join(tmpdir(), 'noodle-unlinked-delegated-exchange-home-'));
    const cleanup: Array<() => void | Promise<void>> = [
      () => rmSync(projectRoot, { recursive: true }),
      () => rmSync(home, { recursive: true }),
    ];
    const clientSecret = randomCredential('client-secret');
    const downstreamToken = randomCredential('downstream-token');

    try {
      const oidc = await fakeOidcIssuer();
      cleanup.push(oidc.close);
      const exchange = await fakeExchangeEndpoint({
        clientSecret,
        downstreamToken,
        customerIssuer: () => oidc.issuer,
      });
      cleanup.push(exchange.close);
      const downstream = await fakeDownstreamApi(downstreamToken);
      cleanup.push(downstream.close);

      const serverPath = join(projectRoot, 'server.ts');
      writeFileSync(join(projectRoot, 'noodle.json'), JSON.stringify({ name: UNLINKED_APP }));
      writeConfig(
        { defaultOrg: 'saved-hosted-org', defaultApp: 'saved-hosted-app', defaultEnv: 'prod' },
        home,
      );
      writeFileSync(
        serverPath,
        authoredServer({
          issuer: oidc.issuer,
          exchangeUrl: exchange.url,
          exchangeOrigin: exchange.origin,
          downstreamOrigin: downstream.origin,
        }),
      );
      const targetResolution = resolveEffectiveLocalTarget({
        cwd: projectRoot,
        home,
        manifestPath: serverPath,
      });
      expect(targetResolution).toMatchObject({
        target: { org: 'local', app: UNLINKED_APP, env: 'dev' },
        mode: 'unlinked',
        ignoredSavedTarget: true,
      });
      setLocalConfigValue(projectRoot, {
        kind: 'secret',
        scope: { level: 'env', ...targetResolution.target },
        name: CLIENT_SECRET_NAME,
        value: clientSecret,
      });

      const handle = await dev({
        manifestPath: serverPath,
        projectRoot,
        ...targetResolution.target,
        interactive: false,
        watch: false,
        log: () => {},
        customerVerifierAllowInsecureLocalhost: true,
      });
      cleanup.push(handle.close);
      expect(handle.boot, JSON.stringify(handle.boot)).toMatchObject({ ok: true });
      oidc.setExpectedResource(handle.url);
      const customerAuth = handle.customerAuth();
      const delegatedCredentialSink = handle.delegatedCredentialSink();
      const preview = await startPreview({
        mcpUrl: handle.url,
        theme: 'both',
        device: 'both',
        ...(customerAuth === undefined ? {} : { customerAuth }),
        ...(delegatedCredentialSink === undefined ? {} : { delegatedCredentialSink }),
        localDelegatedExchange: () => handle.localDelegatedExchange(),
      });
      cleanup.push(preview.close);

      const capability = capabilityFrom(await (await fetch(preview.url)).text());
      const status = await exchangeStatus(preview.url, capability);
      expect(status).toMatchObject({
        tenant: `local/${UNLINKED_APP}/dev`,
        bindings: [{ audience: EXCHANGE_AUDIENCE, verified: false }],
      });
      exchange.installStatus(status);

      await completeOidcSignIn(preview.url, capability, oidc);
      const toolResponse = await rpc(preview.url, capability, 'tools/call', {
        name: 'read_profile',
        arguments: {},
      });
      expect(toolResponse.status).toBe(200);
      expect(exchange.verified).toHaveLength(1);
      expectAssertionContext((exchange.verified[0] as VerifiedExchange).payload, status);
    } finally {
      await runCleanup(cleanup);
    }
  });

  it('does not create a signing key when no delegated binding is compiled or listed', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'noodle-no-delegated-exchange-e2e-'));
    const serverPath = join(projectRoot, 'server.ts');
    writeFileSync(serverPath, OPEN_SERVER);
    const keyPath = join(projectRoot, KEY_PATH);

    try {
      const handle = await dev({
        manifestPath: serverPath,
        projectRoot,
        app: 'no-exchange',
        interactive: false,
        watch: false,
        log: () => {},
      });
      try {
        const preview = await startPreview({
          mcpUrl: handle.url,
          theme: 'both',
          device: 'both',
          localDelegatedExchange: () => handle.localDelegatedExchange(),
        });
        try {
          expect(handle.boot, JSON.stringify(handle.boot)).toMatchObject({
            ok: true,
            toolNames: ['health'],
          });
          expect(handle.localDelegatedExchange()).toBeUndefined();
          expect(existsSync(keyPath)).toBe(false);
          const capability = capabilityFrom(await (await fetch(preview.url)).text());
          const response = await rpc(preview.url, capability, 'tools/list', {});
          expect(response.status).toBe(200);
          expect(await response.json()).toMatchObject({
            result: {
              resultType: 'complete',
              tools: [expect.objectContaining({ name: 'health' })],
            },
          });
          expect(handle.localDelegatedExchange()).toBeUndefined();
          expect(existsSync(keyPath)).toBe(false);
        } finally {
          await preview.close();
        }
      } finally {
        await handle.close();
      }
      expect(handle.localDelegatedExchange()).toBeUndefined();
      expect(existsSync(keyPath)).toBe(false);
    } finally {
      rmSync(projectRoot, { recursive: true });
    }
  });
});

async function fakeOidcIssuer(): Promise<{
  readonly issuer: string;
  readonly jwks: JSONWebKeySet;
  readonly registrations: readonly Record<string, unknown>[];
  readonly authorizationRequests: readonly URL[];
  readonly tokenRequests: readonly CapturedRequest[];
  readonly accessToken: () => string | undefined;
  readonly refreshToken: string;
  readonly pkceVerified: () => boolean;
  setExpectedResource(resource: string): void;
  close(): Promise<void>;
}> {
  const keys = await generateKeyPair('RS256', { extractable: true });
  const kid = `oidc-${randomBytes(12).toString('base64url')}`;
  const publicJwk = {
    ...(await exportJWK(keys.publicKey)),
    alg: 'RS256',
    kid,
    use: 'sig',
  };
  const jwks: JSONWebKeySet = { keys: [publicJwk] };
  const registrations: Record<string, unknown>[] = [];
  const authorizationRequests: URL[] = [];
  const tokenRequests: CapturedRequest[] = [];
  const authorizationCode = randomCredential('code');
  const refreshToken = randomCredential('refresh');
  const clientId = randomCredential('dcr-client');
  let origin = '';
  let expectedResource: string | undefined;
  let redirectUri: string | undefined;
  let codeChallenge: string | undefined;
  let issuedAccessToken: string | undefined;
  let verifiedPkce = false;

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', origin || 'http://127.0.0.1');
      if (
        req.method === 'GET' &&
        (url.pathname === '/.well-known/oauth-authorization-server' ||
          url.pathname === '/.well-known/openid-configuration')
      ) {
        writeJson(res, {
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          jwks_uri: `${origin}/jwks`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
          authorization_response_iss_parameter_supported: true,
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/jwks') {
        writeJson(res, jwks);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/register') {
        const registration = JSON.parse(await readBody(req)) as Record<string, unknown>;
        registrations.push(registration);
        const registeredRedirects = registration.redirect_uris;
        if (
          registration.application_type !== 'native' ||
          registration.token_endpoint_auth_method !== 'none' ||
          !Array.isArray(registeredRedirects) ||
          typeof registeredRedirects[0] !== 'string'
        ) {
          writeJson(res, { error: 'invalid_client_metadata' }, 400);
          return;
        }
        redirectUri = registeredRedirects[0];
        writeJson(res, {
          client_id: clientId,
          token_endpoint_auth_method: 'none',
          redirect_uris: [redirectUri],
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/authorize') {
        authorizationRequests.push(new URL(url));
        if (
          expectedResource === undefined ||
          redirectUri === undefined ||
          url.searchParams.get('response_type') !== 'code' ||
          url.searchParams.get('client_id') !== clientId ||
          url.searchParams.get('redirect_uri') !== redirectUri ||
          url.searchParams.get('resource') !== expectedResource ||
          url.searchParams.get('code_challenge_method') !== 'S256' ||
          !url.searchParams.get('code_challenge') ||
          !url.searchParams.get('state')
        ) {
          writeJson(res, { error: 'invalid_request' }, 400);
          return;
        }
        codeChallenge = url.searchParams.get('code_challenge') ?? undefined;
        const callback = new URL(redirectUri);
        callback.searchParams.set('code', authorizationCode);
        callback.searchParams.set('state', url.searchParams.get('state') ?? '');
        callback.searchParams.set('iss', origin);
        res.writeHead(302, { location: callback.href });
        res.end();
        return;
      }
      if (req.method === 'POST' && url.pathname === '/token') {
        const bodyText = await readBody(req);
        const body = new URLSearchParams(bodyText);
        tokenRequests.push({
          method: req.method,
          url: url.href,
          headers: { ...req.headers },
          body: bodyText,
        });
        const verifier = body.get('code_verifier');
        verifiedPkce =
          verifier !== null &&
          codeChallenge !== undefined &&
          createHash('sha256').update(verifier).digest('base64url') === codeChallenge;
        if (
          expectedResource === undefined ||
          body.get('grant_type') !== 'authorization_code' ||
          body.get('code') !== authorizationCode ||
          body.get('client_id') !== clientId ||
          body.get('redirect_uri') !== redirectUri ||
          body.get('resource') !== expectedResource ||
          req.headers.authorization !== undefined ||
          body.has('client_secret') ||
          body.has('client_assertion') ||
          body.has('client_assertion_type') ||
          !verifiedPkce
        ) {
          writeJson(res, { error: 'invalid_grant' }, 400);
          return;
        }
        issuedAccessToken = await new SignJWT({
          email: EMAIL,
          name: NAME,
          resource: expectedResource,
        })
          .setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' })
          .setIssuer(origin)
          .setSubject(SUBJECT)
          .setAudience([OIDC_AUDIENCE, expectedResource])
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(keys.privateKey);
        writeJson(res, {
          access_token: issuedAccessToken,
          refresh_token: refreshToken,
          token_type: 'Bearer',
          expires_in: 300,
          scope: 'tools:read',
        });
        return;
      }
      res.writeHead(404).end();
    })().catch(() => writeJson(res, { error: 'server_error' }, 500));
  });
  origin = await listen(server);

  return {
    issuer: origin,
    jwks,
    registrations,
    authorizationRequests,
    tokenRequests,
    accessToken: () => issuedAccessToken,
    refreshToken,
    pkceVerified: () => verifiedPkce,
    setExpectedResource(resource) {
      expectedResource = resource;
    },
    close: () => closeServer(server),
  };
}

async function fakeExchangeEndpoint(input: {
  readonly clientSecret: string;
  readonly downstreamToken: string;
  readonly customerIssuer: () => string;
}): Promise<{
  readonly origin: string;
  readonly url: string;
  readonly requests: readonly CapturedRequest[];
  readonly verified: readonly VerifiedExchange[];
  readonly observedStatuses: readonly ExchangeStatus[];
  installStatus(status: ExchangeStatus): void;
  installStatusReader(reader: () => Promise<ExchangeStatus>): void;
  close(): Promise<void>;
}> {
  const requests: CapturedRequest[] = [];
  const verified: VerifiedExchange[] = [];
  const observedStatuses: ExchangeStatus[] = [];
  let status: ExchangeStatus | undefined;
  let statusReader: (() => Promise<ExchangeStatus>) | undefined;
  let origin = '';
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', origin || 'http://127.0.0.1');
      const body = await readBody(req);
      requests.push({
        method: req.method ?? '',
        url: url.href,
        headers: { ...req.headers },
        body,
      });
      if (req.method !== 'POST' || url.pathname !== '/oauth/token') {
        res.writeHead(404).end();
        return;
      }
      const fields = new URLSearchParams(body);
      const currentStatus = statusReader === undefined ? status : await statusReader();
      if (currentStatus !== undefined) observedStatuses.push(structuredClone(currentStatus));
      if (
        currentStatus === undefined ||
        req.headers.authorization !== undefined ||
        fields.get('client_id') !== CLIENT_ID ||
        fields.get('client_secret') !== input.clientSecret ||
        fields.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:token-exchange' ||
        fields.get('subject_token_type') !== 'urn:ietf:params:oauth:token-type:jwt' ||
        fields.get('scope') !== 'profile:read' ||
        fields.get('audience') !== currentStatus.bindings[0]?.audience
      ) {
        writeJson(res, { error: 'invalid_client' }, 401);
        return;
      }
      const assertion = fields.get('subject_token') ?? '';
      try {
        const result = await jwtVerify(assertion, createLocalJWKSet(currentStatus.jwks), {
          issuer: currentStatus.issuer,
          audience: currentStatus.bindings[0]?.audience,
          algorithms: ['RS256'],
        });
        const payload = result.payload;
        expectAssertionContext(payload, currentStatus);
        const claimMismatches = [
          payload.sub === SUBJECT ? undefined : 'sub',
          JSON.stringify(payload.customer_identity) ===
          JSON.stringify({ version: 1, issuer: input.customerIssuer() })
            ? undefined
            : 'customer_identity',
          typeof payload.iat === 'number' ? undefined : 'iat',
          typeof payload.exp === 'number' ? undefined : 'exp',
          typeof payload.iat === 'number' &&
          typeof payload.exp === 'number' &&
          payload.exp - payload.iat === 120
            ? undefined
            : 'ttl',
          typeof payload.jti === 'string' && payload.jti.length > 0 ? undefined : 'jti',
        ].filter((value): value is string => value !== undefined);
        if (claimMismatches.length > 0) {
          writeJson(res, { error: 'invalid_grant' }, 400);
          return;
        }
        verified.push({
          protectedHeader: result.protectedHeader as Record<string, unknown>,
          payload,
        });
      } catch {
        writeJson(res, { error: 'invalid_grant' }, 400);
        return;
      }
      writeJson(res, {
        access_token: input.downstreamToken,
        token_type: 'Bearer',
        expires_in: 60,
      });
    })().catch(() => writeJson(res, { error: 'server_error' }, 500));
  });
  origin = await listen(server);
  return {
    origin,
    url: `${origin}/oauth/token`,
    requests,
    verified,
    observedStatuses,
    installStatus(candidate) {
      status = structuredClone(candidate);
      statusReader = undefined;
    },
    installStatusReader(reader) {
      statusReader = reader;
    },
    close: () => closeServer(server),
  };
}

async function fakeDownstreamApi(token: string): Promise<{
  readonly origin: string;
  readonly requests: readonly CapturedRequest[];
  close(): Promise<void>;
}> {
  const requests: CapturedRequest[] = [];
  let origin = '';
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', origin || 'http://127.0.0.1');
      const body = await readBody(req);
      requests.push({
        method: req.method ?? '',
        url: url.href,
        headers: { ...req.headers },
        body,
      });
      if (req.method !== 'GET' || url.pathname !== '/api/profile') {
        res.writeHead(404).end();
        return;
      }
      if (req.headers.authorization !== `Bearer ${token}`) {
        writeJson(res, { error: 'unauthorized' }, 401);
        return;
      }
      writeJson(res, { source: 'downstream', subject: SUBJECT });
    })().catch(() => writeJson(res, { error: 'server_error' }, 500));
  });
  origin = await listen(server);
  return { origin, requests, close: () => closeServer(server) };
}

function authoredServer(input: {
  readonly issuer: string;
  readonly exchangeUrl: string;
  readonly exchangeOrigin: string;
  readonly downstreamOrigin: string;
  readonly exchangeAudienceVariable?: string;
  readonly title?: string;
}): string {
  const exchangeAudience =
    input.exchangeAudienceVariable === undefined
      ? JSON.stringify(EXCHANGE_AUDIENCE)
      : JSON.stringify(`\${env.${input.exchangeAudienceVariable}}`);
  return `
import { annotations, connector, customerAuth, secret, server, tool, z } from '@noodleseed/one';

const customerApi = connector('local_customer_api')
  .version('1.0.0')
  .http({
    baseUrl: ${JSON.stringify(`${input.downstreamOrigin}/api`)},
    allowedOrigins: [${JSON.stringify(input.downstreamOrigin)}, ${JSON.stringify(input.exchangeOrigin)}],
    auth: {
      kind: 'delegatedTokenExchange',
      tokenUrl: ${JSON.stringify(input.exchangeUrl)},
      clientId: ${JSON.stringify(CLIENT_ID)},
      clientSecret: secret(${JSON.stringify(CLIENT_SECRET_NAME)}),
      scopes: ['profile:read'],
      audience: ${exchangeAudience},
      authMethod: 'client_secret_post',
    },
    operations: {
      read_profile: {
        type: 'read',
        method: 'GET',
        path: '/profile',
        output: z.object({ source: z.string(), subject: z.string() }),
      },
    },
  });

export default server(${JSON.stringify(SERVER_NAME)}, {
  title: ${JSON.stringify(input.title ?? 'Delegated Exchange E2E')},
  version: '1.0.0',
  auth: customerAuth.oidc({
    issuer: ${JSON.stringify(input.issuer)},
    audience: ${JSON.stringify(OIDC_AUDIENCE)},
  }),
  use: { customer_api: customerApi },
}, [
  tool('read_profile', {
    description: 'Read the signed-in customer profile.',
    annotations: annotations.readOnly(),
    input: z.object({}),
    output: z.object({ source: z.string(), subject: z.string() }),
    fulfil: ({ connectors }) => {
      const profile = connectors.customer_api.read_profile({});
      return { source: profile.source, subject: profile.subject };
    },
  }),
]);
`;
}

const OPEN_SERVER = `
import { annotations, server, tool, z } from '@noodleseed/one';

export default server('no_exchange', { title: 'No Exchange', version: '1.0.0' }, [
  tool('health', {
    description: 'Return local health.',
    annotations: annotations.readOnly(),
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    fulfil: () => ({ ok: true }),
  }),
]);
`;

async function rpc(
  previewUrl: string,
  capability: string,
  method: string,
  params: Record<string, unknown>,
): Promise<Response> {
  return fetch(new URL('/rpc', previewUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-noodle-devtools-capability': capability,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

async function exchangeStatus(previewUrl: string, capability: string): Promise<ExchangeStatus> {
  const response = await fetch(new URL('/delegated-exchange/status', previewUrl), {
    headers: { 'x-noodle-devtools-capability': capability },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as ExchangeStatus;
}

async function completeOidcSignIn(
  previewUrl: string,
  capability: string,
  oidc: Awaited<ReturnType<typeof fakeOidcIssuer>>,
): Promise<void> {
  const start = await fetch(new URL('/auth/start', previewUrl), {
    method: 'POST',
    headers: { 'x-noodle-devtools-capability': capability },
  });
  expect(start.status).toBe(200);
  const { authorizationUrl } = (await start.json()) as { authorizationUrl: string };
  const authorize = await fetch(authorizationUrl, { redirect: 'manual' });
  expect(authorize.status).toBe(302);
  const callbackUrl = authorize.headers.get('location');
  expect(callbackUrl).toBeTruthy();
  const callback = await fetch(callbackUrl as string);
  expect(callback.status).toBe(200);
  expect(oidc.pkceVerified()).toBe(true);
}

function expectAssertionContext(assertion: JWTPayload, status: ExchangeStatus): void {
  expect(assertion.tenant).toBe(status.tenant);
  expect(assertion.deployment).toBe(status.deployment);
  expect(assertion.aud).toBe(status.bindings[0]?.audience);
}

function capabilityFrom(shell: string): string {
  const capability = shell.match(/var RPC_CAPABILITY="([^"]+)"/u)?.[1];
  if (capability === undefined) throw new Error('Devtools shell did not contain a capability');
  return capability;
}

function occurrences(text: string, value: string): number {
  return text.split(value).length - 1;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function writeJson(res: ServerResponse, body: unknown, status = 200): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function runCleanup(cleanup: Array<() => void | Promise<void>>): Promise<void> {
  const errors: unknown[] = [];
  while (cleanup.length > 0) {
    try {
      await cleanup.pop()?.();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw errors[0];
}
