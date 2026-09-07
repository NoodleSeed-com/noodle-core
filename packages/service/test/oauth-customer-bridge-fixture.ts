import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createJwtVerifier, createStaticSigningKeyProvider } from '@noodle-borg/auth';
import { SignJWT } from 'jose';
import {
  createCustomerVerifierFactory,
  createServiceHandler,
  GoogleControlPlaneGate,
  type GoogleIdTokenVerifier,
  InMemoryControlPlaneStore,
  ServerRegistry,
  type TenantAuthConfig,
} from '../src/index.js';
import { createOAuthApp } from '../src/oauth/app.js';
import { NoodleOAuthProvider } from '../src/oauth/provider.js';
import { InMemoryOAuthStore } from '../src/oauth/store.js';

interface CustomerBridgeFixtureOptions {
  readonly signer: Awaited<ReturnType<typeof createStaticSigningKeyProvider>>;
  readonly issuer: string;
  readonly ownerSubject: string;
  readonly firebaseProjectId: string;
  readonly controlGoogle: GoogleIdTokenVerifier;
}

export async function buildCustomerBridgeServer(options: CustomerBridgeFixtureOptions): Promise<{
  base: string;
  close: () => Promise<void>;
  firebaseToken: () => Promise<string>;
  store: InMemoryOAuthStore;
}> {
  const firebaseSigner = await createStaticSigningKeyProvider();
  const firebaseJwks = await firebaseSigner.publicJwks();
  const customerVerifier = createCustomerVerifierFactory({ firebaseJwks });
  let registry: ServerRegistry;
  const store = new InMemoryOAuthStore();
  const provider = new NoodleOAuthProvider({
    issuer: options.issuer,
    store,
    signer: options.signer,
    google: {
      authorizationUrl: (state) =>
        `https://accounts.google.test/auth?state=${encodeURIComponent(state)}`,
      exchange: () =>
        Promise.resolve({
          subject: options.ownerSubject,
          email: 'owner@noodleseed.com',
        }),
    },
    customerBridgeAuthForResource: async (resource) => bridgeAuthForResource(registry, resource),
    verifyCustomerBridgeToken: async (auth, token) =>
      (await customerVerifier(auth)(token))?.caller ?? null,
    sealCustomerCredential: async (token) => ({ enc: 'none', values: { token } }),
  });
  const platformVerifier = createJwtVerifier({
    issuer: options.issuer,
    keyResolver: await options.signer.verifierKey(),
  });
  registry = new ServerRegistry(undefined, undefined, undefined, {
    customerVerifierFactory: (auth: TenantAuthConfig) => {
      if (auth.kind !== 'bridge') return customerVerifier(auth);
      return async (token, resource) => {
        const verification = await platformVerifier(token, resource);
        if (
          verification?.caller.identityKind !== 'customer' ||
          verification.caller.identityProvider !== auth.provider
        ) {
          return null;
        }
        return verification;
      };
    },
  });
  const controlPlane = new InMemoryControlPlaneStore();
  await controlPlane.addOrgMember({
    org: 'acme',
    subject: options.ownerSubject,
    email: 'owner@noodleseed.com',
    role: 'owner',
  });
  const server = createServer(
    createServiceHandler(registry, {
      deployGate: new GoogleControlPlaneGate({
        audience: 'cp',
        admins: [],
        verifier: options.controlGoogle,
      }),
      controlPlaneStore: controlPlane,
      verifyOwnerToken: platformVerifier,
      authServerIssuer: options.issuer,
      authServerApp: createOAuthApp(provider) as never,
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
    firebaseToken: () => mintFirebaseIdToken(firebaseSigner, options.firebaseProjectId),
    store,
  };
}

async function bridgeAuthForResource(
  registry: ServerRegistry,
  resource: string,
): Promise<Extract<TenantAuthConfig, { kind: 'bridge' }> | undefined> {
  const url = new URL(resource);
  const match = /^\/o\/([^/]+)\/([^/]+)(?:\/v\d+(?:_\d+){0,2})?\/mcp$/.exec(url.pathname);
  if (!match) return undefined;
  const target = await registry.getActiveByTenant({
    org: decodeURIComponent(match[1] as string),
    app: decodeURIComponent(match[2] as string),
    env: 'prod',
  });
  const auth = target?.served.artifact.server.auth;
  return auth?.kind === 'bridge' ? auth : undefined;
}

async function mintFirebaseIdToken(
  provider: Awaited<ReturnType<typeof createStaticSigningKeyProvider>>,
  projectId: string,
): Promise<string> {
  const key = await provider.signingKey();
  return new SignJWT({
    email: 'customer@noodleseed.com',
    name: 'Firebase Customer',
    locale: 'fr-fr',
    zoneinfo: 'europe/paris',
    app: { scopes: ['tickets.read', 'tickets.write'] },
  })
    .setProtectedHeader({ alg: key.alg, kid: key.kid })
    .setIssuer(`https://securetoken.google.com/${projectId}`)
    .setSubject('firebase-customer-sub')
    .setAudience(projectId)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key.privateKey);
}
