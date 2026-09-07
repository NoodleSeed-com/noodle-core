import { decodeJwt } from 'jose';
import { describe, expect, it } from 'vitest';
import { createStaticSigningKeyProvider, mintAccessToken } from '../src/index.js';

const ISSUER = 'https://as.noodle.test';
const RESOURCE = 'https://cloud.noodle.test';

describe('mintAccessToken authentication time', () => {
  it('maps a trusted application authentication time to the JWT NumericDate claim', async () => {
    const token = await mintAccessToken(
      await createStaticSigningKeyProvider(),
      {
        issuer: ISSUER,
        subject: 'principal-1',
        audience: RESOURCE,
        authTime: 1_700_000_000,
      },
      3_600,
    );

    expect(decodeJwt(token)).toMatchObject({
      iss: ISSUER,
      sub: 'principal-1',
      aud: RESOURCE,
      auth_time: 1_700_000_000,
    });
  });

  it('mints trusted bridge roles in the Noodle-owned private claim', async () => {
    const token = await mintAccessToken(
      await createStaticSigningKeyProvider(),
      {
        issuer: ISSUER,
        subject: 'principal-1',
        audience: RESOURCE,
        roles: ['admin', 'support'],
      },
      3_600,
    );

    expect(decodeJwt(token)).toMatchObject({
      noodle_roles: ['admin', 'support'],
    });
    expect(decodeJwt(token)).not.toHaveProperty('roles');
  });

  it('mints the verified customer issuer only in the Noodle-owned private claim', async () => {
    const token = await mintAccessToken(
      await createStaticSigningKeyProvider(),
      {
        issuer: ISSUER,
        subject: 'customer-subject-1',
        audience: RESOURCE,
        identityKind: 'customer',
        customerIssuer: 'https://login.microsoftonline.com/tenant-1/v2.0',
      },
      3_600,
    );

    expect(decodeJwt(token)).toMatchObject({
      noodle_customer_issuer: 'https://login.microsoftonline.com/tenant-1/v2.0',
    });
    expect(decodeJwt(token)).not.toHaveProperty('customerIssuer');
  });

  it('omits auth_time when no trusted authentication event was supplied', async () => {
    const token = await mintAccessToken(
      await createStaticSigningKeyProvider(),
      {
        issuer: ISSUER,
        subject: 'principal-1',
        audience: RESOURCE,
      },
      3_600,
    );

    expect(decodeJwt(token)).not.toHaveProperty('auth_time');
  });

  it('mints a service identity with private lifecycle bindings', async () => {
    const token = await mintAccessToken(
      await createStaticSigningKeyProvider(),
      {
        issuer: ISSUER,
        subject: 'spn_11111111-1111-4111-8111-111111111111',
        audience: RESOURCE,
        scope: 'todos.read',
        identityKind: 'service',
        oauthClientId: 'spn_11111111-1111-4111-8111-111111111111',
        servicePrincipalGrantId: 'spg_1',
        servicePrincipalCredentialId: 'spc_1',
      },
      600,
    );

    expect(decodeJwt(token)).toMatchObject({
      sub: 'spn_11111111-1111-4111-8111-111111111111',
      client_id: 'spn_11111111-1111-4111-8111-111111111111',
      noodle_identity: 'service',
      noodle_service_grant_id: 'spg_1',
      noodle_service_credential_id: 'spc_1',
    });
  });
});
