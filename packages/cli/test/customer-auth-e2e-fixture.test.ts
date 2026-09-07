import { readFileSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { afterAll, describe, expect, it } from 'vitest';
import { initCustomerAuthIssuers } from '../../../scripts/e2e/customer-auth.mjs';
import { cleanup } from '../../../scripts/e2e/harness.mjs';

afterAll(cleanup);

describe('customer-auth E2E issuer', () => {
  it('serves generic-host RFC 8414 metadata with a reachable JWKS', async () => {
    const issuers = await initCustomerAuthIssuers();
    const { oidc } = issuers;
    const metadataResponse = await getJson(
      new URL('/.well-known/oauth-authorization-server', oidc.issuer),
      oidc.caCertPath,
    );

    expect(metadataResponse.status).toBe(200);
    expect(metadataResponse.contentType).toBe('application/json');
    expect(metadataResponse.body).toEqual({
      issuer: oidc.issuer,
      authorization_endpoint: `${oidc.issuer}/authorize`,
      token_endpoint: `${oidc.issuer}/token`,
      registration_endpoint: `${oidc.issuer}/register`,
      jwks_uri: oidc.jwksUri,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });

    const jwksResponse = await getJson(new URL(oidc.jwksUri), oidc.caCertPath);
    expect(jwksResponse.status).toBe(200);
    expect(jwksResponse.contentType).toBe('application/json');
    expect(jwksResponse.body).toMatchObject({
      keys: [expect.objectContaining({ kty: 'RSA' })],
    });
    expect(issuers.serviceEnv).toEqual({
      NOODLE_CUSTOMER_IDP_ALLOW_INSECURE_LOCALHOST: 'true',
      NOODLE_CUSTOMER_FIREBASE_JWKS_URI: issuers.firebase.jwksUri,
      NODE_EXTRA_CA_CERTS: issuers.oidc.caCertPath,
    });
  });
});

interface JsonResponse {
  readonly status: number | undefined;
  readonly contentType: string | undefined;
  readonly body: unknown;
}

function getJson(url: URL, caCertPath?: string): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const get = url.protocol === 'https:' ? httpsGet : httpGet;
    const request = get(
      url,
      url.protocol === 'https:' && caCertPath
        ? {
            ca: readFileSync(caCertPath),
          }
        : undefined,
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          try {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve({
              status: response.statusCode,
              contentType: response.headers['content-type'],
              body:
                response.headers['content-type'] === 'application/json' ? JSON.parse(text) : text,
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on('error', reject);
  });
}
