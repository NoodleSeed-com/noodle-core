import { describe, expect, it } from 'vitest';
import { delegatedTokenExchangeIdentityErrors, type SecretBinding } from '../src/index.js';

const delegatedBinding: SecretBinding = {
  connectorId: 'acmehr_api',
  connectorVersion: '1.0.0',
  operation: 'list_time_off',
  secretRef: 'ACMEHR_DELEG_CLIENT_SECRET',
  authKind: 'delegatedTokenExchange',
  tokenExchange: {
    tokenUrl: 'https://app.acmehr.example/oauth/token?private=redacted',
    clientId: 'deleg-client-id',
    authMethod: 'client_secret_basic',
  },
};

describe('delegated token exchange customer identity preflight', () => {
  it('rejects delegated exchange when the server cannot produce a verified customer caller', () => {
    const errors = delegatedTokenExchangeIdentityErrors([delegatedBinding], {});

    expect(errors).toEqual([
      {
        code: 'delegated_token_exchange_identity_required',
        path: 'server.auth',
        message:
          'delegatedTokenExchange on acmehr_api.list_time_off requires a verified customer identity source; declare server.auth with customerAuth(...) or server.assistant with embeddedAssistant(...)',
      },
    ]);
    expect(JSON.stringify(errors)).not.toContain('private=redacted');
    expect(JSON.stringify(errors)).not.toContain('ACMEHR_DELEG_CLIENT_SECRET');
  });

  it.each([
    ['customer auth', { auth: { kind: 'oidc' } }],
    ['embedded assistant', { assistant: { allowedOrigins: ['https://app.example.com'] } }],
  ])('accepts delegated exchange with %s as the customer identity source', (_name, server) => {
    expect(delegatedTokenExchangeIdentityErrors([delegatedBinding], server)).toEqual([]);
  });

  it('does not count an assistant whose only surfaces are public', () => {
    // A pure-public assistant has no sign-in and never produces a verified customer caller, so
    // declaring it must not satisfy the identity requirement — that was how a deployment with a
    // guaranteed-broken delegated tool sailed through preflight.
    const errors = delegatedTokenExchangeIdentityErrors([delegatedBinding], {
      assistant: {
        surfaces: [{ mode: 'public', origins: ['https://www.example.com'], capabilities: [] }],
      },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('delegated_token_exchange_identity_required');
  });

  it.each([
    ['mixed'],
    ['authenticated'],
  ])('counts an assistant with a %s surface as an identity source', (mode) => {
    expect(
      delegatedTokenExchangeIdentityErrors([delegatedBinding], {
        assistant: {
          surfaces: [
            { mode: 'public', origins: ['https://www.example.com'], capabilities: [] },
            { mode, origins: ['https://app.example.com'] },
          ],
        },
      }),
    ).toEqual([]);
  });

  it('keeps the permissive answer for surface shapes it cannot read', () => {
    // Absent or malformed surfaces stay permissive: this preflight must never invent a deploy
    // failure for an artifact shape a newer authoring layer produced and it does not understand.
    for (const surfaces of [undefined, [], ['not-a-surface']]) {
      expect(
        delegatedTokenExchangeIdentityErrors([delegatedBinding], {
          assistant: surfaces === undefined ? {} : { surfaces },
        }),
      ).toEqual([]);
    }
  });

  it('accepts the explicit loopback-only customer identity supplied by local Devtools', () => {
    expect(
      delegatedTokenExchangeIdentityErrors(
        [delegatedBinding],
        {},
        {
          localDevtoolsCustomerIdentity: true,
        },
      ),
    ).toEqual([]);
  });

  it('ignores connector auth modes that do not consume a customer caller', () => {
    expect(
      delegatedTokenExchangeIdentityErrors(
        [{ ...delegatedBinding, authKind: 'static', tokenExchange: undefined }],
        {},
      ),
    ).toEqual([]);
  });
});
