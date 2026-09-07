import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createStaticSigningKeyProvider } from '@noodle-borg/auth';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOAuthApp } from '../src/oauth/app.js';
import type { GoogleAuthenticator } from '../src/oauth/google.js';
import { NoodleOAuthProvider } from '../src/oauth/provider.js';
import { InMemoryOAuthStore } from '../src/oauth/store.js';
import { form, raw } from './oauth-http-test-helpers.js';

const ISSUER = 'https://as.noodle.test';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const DEVICE_CALLBACK = `${ISSUER}/oauth/device/callback`;

let http: Server;
let base: string;

beforeEach(async () => {
  const signer = await createStaticSigningKeyProvider();
  const google: GoogleAuthenticator = {
    authorizationUrl: (state) =>
      `https://accounts.google.test/auth?state=${encodeURIComponent(state)}`,
    exchange: () => Promise.resolve({ subject: 'owner-sub', email: 'owner@noodleseed.com' }),
  };
  const provider = new NoodleOAuthProvider({
    issuer: ISSUER,
    store: new InMemoryOAuthStore(),
    signer,
    google,
    allowedEmailDomain: '@noodleseed.com',
  });
  http = createServer(createOAuthApp(provider));
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    http.close((error) => (error ? reject(error) : resolve())),
  );
});

describe('OA-2 RFC 8628 device authorization', () => {
  it('authorizes without a loopback callback and enforces polling semantics', async () => {
    const clientId = await registerDeviceClient();
    const started = await raw(
      'POST',
      `${base}/device_authorization`,
      form({ client_id: clientId, resource: ISSUER, scope: 'openid email' }),
    );
    expect(started.status).toBe(200);
    const device = JSON.parse(started.text) as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      verification_uri_complete: string;
      expires_in: number;
      interval: number;
    };
    expect(device).toMatchObject({
      verification_uri: `${ISSUER}/device`,
      expires_in: 600,
      interval: 5,
    });
    expect(device.user_code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(new URL(device.verification_uri_complete).searchParams.get('user_code')).toBe(
      device.user_code,
    );

    const verificationPage = await raw(
      'GET',
      `${base}/device?user_code=${encodeURIComponent(device.user_code)}`,
    );
    expect(verificationPage.status).toBe(200);
    expect(verificationPage.text).toContain(device.user_code);
    expect(verificationPage.text).toContain('matches the code shown in your terminal');

    await expect(poll(clientId, device.device_code)).resolves.toMatchObject({
      status: 400,
      text: expect.stringContaining('authorization_pending'),
    });
    await expect(poll(clientId, device.device_code)).resolves.toMatchObject({
      status: 400,
      text: expect.stringContaining('slow_down'),
    });

    const verification = await raw('POST', `${base}/device`, form({ user_code: device.user_code }));
    const authorizePublic = new URL(verification.headers.location as string);
    expect(authorizePublic.origin + authorizePublic.pathname).toBe(`${ISSUER}/authorize`);
    expect(authorizePublic.searchParams.get('redirect_uri')).toBe(DEVICE_CALLBACK);
    const authorize = await raw(
      'GET',
      `${base}${authorizePublic.pathname}${authorizePublic.search}`,
    );
    const googleState = new URL(authorize.headers.location as string).searchParams.get('state');
    const googleCallback = await raw(
      'GET',
      `${base}/oauth/google/callback?code=g-code&state=${encodeURIComponent(googleState as string)}`,
    );
    const consentToken = /name="consent_token" value="([^"]+)"/.exec(googleCallback.text)?.[1];
    const consent = await raw(
      'POST',
      `${base}/oauth/consent`,
      form({ consent_token: consentToken as string, decision: 'approve' }),
    );
    const callback = new URL(consent.headers.location as string);
    const completed = await raw('GET', `${base}${callback.pathname}${callback.search}`);
    expect(completed.status).toBe(200);
    expect(completed.text).toContain('You can return to your terminal');

    const token = await poll(clientId, device.device_code, ISSUER);
    expect(token.status).toBe(200);
    expect(JSON.parse(token.text)).toMatchObject({
      access_token: expect.any(String),
      refresh_token: expect.any(String),
      token_type: 'bearer',
    });
    await expect(poll(clientId, device.device_code)).resolves.toMatchObject({
      status: 400,
      text: expect.stringContaining('expired_token'),
    });
  });
});

async function registerDeviceClient(): Promise<string> {
  const response = await raw('POST', `${base}/register`, {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Noodle CLI',
      application_type: 'native',
      redirect_uris: [DEVICE_CALLBACK],
      token_endpoint_auth_method: 'none',
      grant_types: [DEVICE_GRANT, 'authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  expect(response.status).toBe(201);
  return JSON.parse(response.text).client_id as string;
}

function poll(clientId: string, deviceCode: string, resource?: string) {
  return raw(
    'POST',
    `${base}/token`,
    form({
      grant_type: DEVICE_GRANT,
      device_code: deviceCode,
      client_id: clientId,
      ...(resource === undefined ? {} : { resource }),
    }),
  );
}
