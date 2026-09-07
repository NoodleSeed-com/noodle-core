import { createStaticSigningKeyProvider } from '@noodle-borg/auth';
import { SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import {
  assertExternalCredentialProviderConformance,
  canonicalizeExternalCredentialScopes,
  createFakeExternalCredentialProvider,
  EXTERNAL_CREDENTIAL_ASSERTION_TTL_SECONDS,
  type ExternalCredentialWorkloadClaims,
  externalCredentialExchangeRequestSchema,
  externalCredentialExchangeResponseSchema,
  externalCredentialRequestFromForm,
  externalCredentialWorkloadClaimsSchema,
  InMemoryAssertionReplayStore,
  signExternalCredentialWorkloadAssertion,
  verifyExternalCredentialWorkloadAssertion,
} from '../src/index.js';

const NOW_MS = 1_800_000_000_000;
const ISSUER = 'https://cloud.noodleseed.test';
const PROVIDER_AUDIENCE = 'urn:example:credential-provider';

const workload: Omit<ExternalCredentialWorkloadClaims, 'iss' | 'aud' | 'iat' | 'exp' | 'jti'> = {
  tenant: 'acme/mail/prod',
  deployment: 'deploy-123',
  connector_id: 'gmail',
  connector_version: '1.0.0',
  operation: 'search',
  binding_id: 'personal',
  connection_id: 'personal_mail',
  connection_revision: 'sha256:connection-v1',
  profile: 'oauth',
  presentation: { kind: 'bearer' },
  scopes: ['gmail.readonly'],
  requested_audience: 'https://gmail.googleapis.com/',
};

async function fixture() {
  const signer = await createStaticSigningKeyProvider();
  const key = await signer.signingKey();
  const assertion = await signExternalCredentialWorkloadAssertion({
    issuer: ISSUER,
    audience: PROVIDER_AUDIENCE,
    workload,
    signingKey: key,
    nowMs: NOW_MS,
    jti: 'exchange-once-123',
  });
  return { signer, key, assertion };
}

describe('external credential workload assertion contract', () => {
  it('signs and verifies the exact deployment workload claims', async () => {
    const { signer, key, assertion } = await fixture();
    const replayStore = new InMemoryAssertionReplayStore();
    const claims = await verifyExternalCredentialWorkloadAssertion(assertion, {
      issuer: ISSUER,
      audience: PROVIDER_AUDIENCE,
      algorithms: ['RS256'],
      keyId: key.kid,
      verificationKey: await signer.verifierKey(),
      replayStore,
      nowMs: NOW_MS,
    });

    expect(claims).toEqual({
      iss: ISSUER,
      aud: PROVIDER_AUDIENCE,
      iat: Math.floor(NOW_MS / 1000),
      exp: Math.floor(NOW_MS / 1000) + EXTERNAL_CREDENTIAL_ASSERTION_TTL_SECONDS,
      jti: 'exchange-once-123',
      ...workload,
    });
    await expect(
      verifyExternalCredentialWorkloadAssertion(assertion, {
        issuer: ISSUER,
        audience: PROVIDER_AUDIENCE,
        algorithms: ['RS256'],
        keyId: key.kid,
        verificationKey: await signer.verifierKey(),
        replayStore,
        nowMs: NOW_MS,
      }),
    ).rejects.toThrow(/replay/i);
  });

  it('rejects signature, issuer, audience, expiry, algorithm, and key-id drift', async () => {
    const { signer, key, assertion } = await fixture();
    const otherSigner = await createStaticSigningKeyProvider();
    const cases = [
      { name: 'signature', verificationKey: await otherSigner.verifierKey() },
      { name: 'issuer', issuer: 'https://other-issuer.test' },
      { name: 'audience', audience: 'urn:other-provider' },
      {
        name: 'expiry',
        nowMs: NOW_MS + (EXTERNAL_CREDENTIAL_ASSERTION_TTL_SECONDS + 1) * 1000,
      },
      { name: 'key-id', keyId: 'other-key' },
    ];
    for (const testCase of cases) {
      await expect(
        verifyExternalCredentialWorkloadAssertion(assertion, {
          issuer: ISSUER,
          audience: PROVIDER_AUDIENCE,
          algorithms: ['RS256'],
          keyId: key.kid,
          verificationKey: await signer.verifierKey(),
          replayStore: new InMemoryAssertionReplayStore(),
          nowMs: NOW_MS,
          ...testCase,
        }),
        testCase.name,
      ).rejects.toThrow();
    }

    const hs256 = await new SignJWT(workload)
      .setProtectedHeader({ alg: 'HS256', kid: key.kid, typ: 'JWT' })
      .setIssuer(ISSUER)
      .setAudience(PROVIDER_AUDIENCE)
      .setIssuedAt(Math.floor(NOW_MS / 1000))
      .setExpirationTime(Math.floor(NOW_MS / 1000) + 60)
      .setJti('wrong-algorithm')
      .sign(new TextEncoder().encode('not-the-platform-key'));
    await expect(
      verifyExternalCredentialWorkloadAssertion(hs256, {
        issuer: ISSUER,
        audience: PROVIDER_AUDIENCE,
        algorithms: ['RS256'],
        keyId: key.kid,
        verificationKey: await signer.verifierKey(),
        replayStore: new InMemoryAssertionReplayStore(),
        nowMs: NOW_MS,
      }),
    ).rejects.toThrow();
  });

  it('rejects wrong or absent typ, future iat, and excessive assertion lifetime', async () => {
    const { signer, key } = await fixture();
    const now = Math.floor(NOW_MS / 1_000);
    const cases = [
      {
        name: 'wrong typ',
        header: { alg: 'RS256' as const, kid: key.kid, typ: 'not-jwt' },
        iat: now,
        exp: now + 60,
      },
      {
        name: 'absent typ',
        header: { alg: 'RS256' as const, kid: key.kid },
        iat: now,
        exp: now + 60,
      },
      {
        name: 'future iat',
        header: { alg: 'RS256' as const, kid: key.kid, typ: 'JWT' },
        iat: now + 1,
        exp: now + 60,
      },
      {
        name: 'excessive lifetime',
        header: { alg: 'RS256' as const, kid: key.kid, typ: 'JWT' },
        iat: now,
        exp: now + EXTERNAL_CREDENTIAL_ASSERTION_TTL_SECONDS + 1,
      },
    ];
    for (const testCase of cases) {
      const assertion = await new SignJWT({
        ...workload,
        iss: ISSUER,
        aud: PROVIDER_AUDIENCE,
        iat: testCase.iat,
        exp: testCase.exp,
        jti: `invalid-${testCase.name}`,
      })
        .setProtectedHeader(testCase.header)
        .sign(key.privateKey);
      await expect(
        verifyExternalCredentialWorkloadAssertion(assertion, {
          issuer: ISSUER,
          audience: PROVIDER_AUDIENCE,
          algorithms: ['RS256'],
          keyId: key.kid,
          verificationKey: await signer.verifierKey(),
          replayStore: new InMemoryAssertionReplayStore(),
          nowMs: NOW_MS,
        }),
        testCase.name,
      ).rejects.toThrow();
    }
  });

  it('keeps signed fields byte-faithful and rejects whitespace, controls, and invalid headers', () => {
    const valid = {
      iss: ISSUER,
      aud: PROVIDER_AUDIENCE,
      iat: Math.floor(NOW_MS / 1_000),
      exp: Math.floor(NOW_MS / 1_000) + 60,
      jti: 'jti:punctuation-._~',
      ...workload,
      presentation: { kind: 'apiKey' as const, header: 'X-Api_Key' },
    };
    expect(externalCredentialWorkloadClaimsSchema.parse(valid)).toEqual(valid);

    for (const mutation of [
      { iss: ` ${ISSUER}` },
      { tenant: ' acme/mail/prod' },
      { tenant: 'acme/mail/prod\n' },
      { presentation: { kind: 'apiKey', header: ' X-Api-Key' } },
      { presentation: { kind: 'apiKey', header: 'X Api Key' } },
      { presentation: { kind: 'apiKey', header: 'X-Api-Key\nInjected' } },
      { requested_audience: 'x'.repeat(513) },
    ]) {
      expect(() =>
        externalCredentialWorkloadClaimsSchema.parse({ ...valid, ...mutation }),
      ).toThrow();
    }
  });

  it('requires canonical RFC 6749 scope tokens without duplicates or ambiguous spacing', () => {
    const base = {
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange' as const,
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt' as const,
      subject_token: 'assertion',
    };
    expect(
      externalCredentialExchangeRequestSchema.parse({ ...base, scope: 'mail.read mail.send' }),
    ).toEqual({ ...base, scope: 'mail.read mail.send' });
    expect(() =>
      externalCredentialExchangeRequestSchema.parse({ ...base, subject_token: ' assertion ' }),
    ).toThrow();
    for (const scope of [
      ' mail.read',
      'mail.read ',
      'mail.read  mail.send',
      'mail.send mail.read',
      'mail.read mail.read',
      'mail"read',
      'mail\\read',
      'mail\nread',
    ]) {
      expect(() => externalCredentialExchangeRequestSchema.parse({ ...base, scope })).toThrow();
    }

    const claims = {
      iss: ISSUER,
      aud: PROVIDER_AUDIENCE,
      iat: Math.floor(NOW_MS / 1_000),
      exp: Math.floor(NOW_MS / 1_000) + 60,
      jti: 'canonical-scopes',
      ...workload,
    };
    for (const scopes of [
      ['mail.send', 'mail.read'],
      ['mail.read', 'mail.read'],
      ['mail read'],
      ['mail"read'],
    ]) {
      expect(() => externalCredentialWorkloadClaimsSchema.parse({ ...claims, scopes })).toThrow();
    }
  });

  it('applies one aggregate scope bound to claims, canonicalization, and form requests', () => {
    const aggregateScopeMaxLength = 8_192;
    const base = {
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange' as const,
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt' as const,
      subject_token: 'assertion',
    };
    const scopesAtLimit = Array.from({ length: 16 }, (_, index) => {
      const length = index === 15 ? 497 : 512;
      const prefix = `${String(index).padStart(2, '0')}-`;
      return `${prefix}${'x'.repeat(length - prefix.length)}`;
    });
    const scopesOverLimit = [...scopesAtLimit.slice(0, -1), `${scopesAtLimit[15]}x`];
    const claims = {
      iss: ISSUER,
      aud: PROVIDER_AUDIENCE,
      iat: Math.floor(NOW_MS / 1_000),
      exp: Math.floor(NOW_MS / 1_000) + 60,
      jti: 'aggregate-scope-bound',
      ...workload,
    };

    expect(scopesAtLimit.join(' ')).toHaveLength(aggregateScopeMaxLength);
    expect(
      externalCredentialWorkloadClaimsSchema.parse({ ...claims, scopes: scopesAtLimit }).scopes,
    ).toEqual(scopesAtLimit);
    expect(canonicalizeExternalCredentialScopes([...scopesAtLimit].reverse())).toEqual(
      scopesAtLimit,
    );
    expect(
      externalCredentialExchangeRequestSchema.parse({
        ...base,
        scope: scopesAtLimit.join(' '),
      }).scope,
    ).toBe(scopesAtLimit.join(' '));

    expect(scopesOverLimit.join(' ')).toHaveLength(aggregateScopeMaxLength + 1);
    expect(() =>
      externalCredentialWorkloadClaimsSchema.parse({ ...claims, scopes: scopesOverLimit }),
    ).toThrow();
    expect(() => canonicalizeExternalCredentialScopes(scopesOverLimit)).toThrow();
    expect(() =>
      externalCredentialExchangeRequestSchema.parse({
        ...base,
        scope: scopesOverLimit.join(' '),
      }),
    ).toThrow();
  });
});

describe('external credential provider conformance', () => {
  it('strictly validates requests, verifies the assertion once, and validates provider output', async () => {
    const { signer, key, assertion } = await fixture();
    const issueCredential = vi.fn(async (claims: ExternalCredentialWorkloadClaims) => ({
      access_token: `token-for-${claims.binding_id}`,
      token_type: 'Bearer' as const,
      expires_in: 900,
      connection_subject: 'acct_opaque_123',
      connection_revision: 'provider-rev-7',
    }));
    const provider = createFakeExternalCredentialProvider({
      verifier: {
        issuer: ISSUER,
        audience: PROVIDER_AUDIENCE,
        algorithms: ['RS256'],
        keyId: key.kid,
        verificationKey: await signer.verifierKey(),
        replayStore: new InMemoryAssertionReplayStore(),
        nowMs: NOW_MS,
      },
      issueCredential,
    });
    const request = {
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange' as const,
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt' as const,
      subject_token: assertion,
      scope: 'gmail.readonly',
      audience: 'https://gmail.googleapis.com/',
    };

    await expect(
      assertExternalCredentialProviderConformance({ provider, request }),
    ).resolves.toEqual({
      access_token: 'token-for-personal',
      token_type: 'Bearer',
      expires_in: 900,
      connection_subject: 'acct_opaque_123',
      connection_revision: 'provider-rev-7',
    });
    expect(issueCredential).toHaveBeenCalledWith(expect.objectContaining(workload));
    await expect(provider.exchange({ ...request, unsafe: true })).rejects.toThrow();
  });

  it('rejects duplicate form fields and request/assertion capability mismatch', async () => {
    expect(() =>
      externalCredentialRequestFromForm(
        `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:token-exchange')}` +
          `&subject_token_type=${encodeURIComponent('urn:ietf:params:oauth:token-type:jwt')}` +
          '&subject_token=one&subject_token=two',
      ),
    ).toThrow(/duplicate/i);

    const { signer, key, assertion } = await fixture();
    const provider = createFakeExternalCredentialProvider({
      verifier: {
        issuer: ISSUER,
        audience: PROVIDER_AUDIENCE,
        algorithms: ['RS256'],
        keyId: key.kid,
        verificationKey: await signer.verifierKey(),
        replayStore: new InMemoryAssertionReplayStore(),
        nowMs: NOW_MS,
      },
      issueCredential: async () => ({
        access_token: 'token',
        token_type: 'Bearer',
        expires_in: 60,
        connection_subject: 'subject',
        connection_revision: 'revision',
      }),
    });
    await expect(
      provider.exchange({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
        subject_token: assertion,
        scope: 'gmail.modify',
        audience: workload.requested_audience,
      }),
    ).rejects.toThrow(/capability mismatch/i);
  });

  it.each([
    [{ token_type: 'Bearer', expires_in: 60, connection_subject: 's', connection_revision: 'r' }],
    [
      {
        access_token: 'token',
        token_type: 'bearer',
        expires_in: 60,
        connection_subject: 's',
        connection_revision: 'r',
      },
    ],
    [
      {
        access_token: 'token',
        token_type: 'Bearer',
        expires_in: 86_400,
        connection_subject: 's',
        connection_revision: 'r',
      },
    ],
    [
      {
        access_token: 'token',
        token_type: 'Bearer',
        expires_in: 60,
        connection_subject: '',
        connection_revision: 'r',
      },
    ],
    [
      {
        access_token: 'token',
        token_type: 'Bearer',
        expires_in: 60,
        connection_subject: 's',
        connection_revision: '',
      },
    ],
    [
      {
        access_token: 'token',
        token_type: 'Bearer',
        expires_in: 60,
        connection_subject: 's',
        connection_revision: 'r',
        extra: 'unsafe',
      },
    ],
  ])('rejects a malformed or unsafe provider response %#', (response) => {
    expect(() => externalCredentialExchangeResponseSchema.parse(response)).toThrow();
  });
});
