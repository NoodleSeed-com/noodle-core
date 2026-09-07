import type { LocalDevtoolsDelegatedExchangeBindingProjection } from '@noodle-borg/service';
import type { JSONWebKeySet } from 'jose';
import { describe, expect, it } from 'vitest';
import { createDevtoolsDelegatedExchangeState } from '../src/devtools-delegated-exchange-state.js';

const JWKS_A: JSONWebKeySet = {
  keys: [{ kty: 'RSA', n: 'public-modulus-a', e: 'AQAB', kid: 'key-a', alg: 'RS256', use: 'sig' }],
};
const JWKS_B: JSONWebKeySet = {
  keys: [{ kty: 'RSA', n: 'public-modulus-b', e: 'AQAB', kid: 'key-b', alg: 'RS256', use: 'sig' }],
};

const FIRST: LocalDevtoolsDelegatedExchangeBindingProjection = {
  bindingKey: 'sha256:first',
  connectorId: 'crm',
  operation: 'list',
  audience: 'crm-api',
};
const SECOND: LocalDevtoolsDelegatedExchangeBindingProjection = {
  bindingKey: 'sha256:second',
  connectorId: 'calendar',
  audience: 'calendar-api',
};
const CONTEXT_A = { tenant: 'local/customer-auth-demo/dev', deployment: 'deploy-a' } as const;
const CONTEXT_B = { tenant: 'local/customer-auth-demo/dev', deployment: 'deploy-b' } as const;

describe('Devtools delegated-exchange state', () => {
  it('is absent when no delegated bindings exist', () => {
    const state = createDevtoolsDelegatedExchangeState();

    expect(state.snapshot()).toBeUndefined();
    state.replace(undefined, [], undefined);
    expect(state.snapshot()).toBeUndefined();
  });

  it('retains verification only for identical binding keys under the same issuer', () => {
    const state = createDevtoolsDelegatedExchangeState();
    state.replace(
      { issuer: 'urn:test:a', jwks: JWKS_A, trustChanged: false },
      [FIRST, SECOND],
      CONTEXT_A,
    );
    state.markVerified({ bindingKey: FIRST.bindingKey });
    state.markVerified({ bindingKey: SECOND.bindingKey });

    state.replace(
      { issuer: 'urn:test:a', jwks: JWKS_A, trustChanged: false },
      [
        FIRST,
        {
          bindingKey: 'sha256:changed',
          connectorId: SECOND.connectorId,
          audience: SECOND.audience,
        },
      ],
      CONTEXT_B,
    );

    expect(state.snapshot()).toEqual({
      issuer: 'urn:test:a',
      jwks: JWKS_A,
      trustChanged: false,
      tenant: CONTEXT_B.tenant,
      deployment: CONTEXT_B.deployment,
      bindings: [
        { ...FIRST, verified: true },
        {
          bindingKey: 'sha256:changed',
          connectorId: 'calendar',
          audience: 'calendar-api',
          verified: false,
        },
      ],
    });
  });

  it('replaces a live attempted binding before exchange and clears stale verification', () => {
    const state = createDevtoolsDelegatedExchangeState();
    state.replace({ issuer: 'urn:test:a', jwks: JWKS_A, trustChanged: false }, [FIRST], CONTEXT_A);
    state.markVerified({ bindingKey: FIRST.bindingKey });

    state.recordAttempt(FIRST);
    expect(state.snapshot()?.bindings).toEqual([{ ...FIRST, verified: true }]);

    const changed = {
      ...FIRST,
      bindingKey: 'sha256:live-variable-change',
      audience: 'crm-api-next',
    };
    state.recordAttempt(changed);

    expect(state.snapshot()).toMatchObject({
      tenant: CONTEXT_A.tenant,
      deployment: CONTEXT_A.deployment,
      bindings: [{ ...changed, verified: false }],
    });
  });

  it('clears all verification and reports trust rotation when the issuer changes', () => {
    const state = createDevtoolsDelegatedExchangeState();
    state.replace({ issuer: 'urn:test:a', jwks: JWKS_A, trustChanged: false }, [FIRST], CONTEXT_A);
    state.markVerified({ bindingKey: FIRST.bindingKey });

    state.replace({ issuer: 'urn:test:b', jwks: JWKS_B, trustChanged: false }, [FIRST], CONTEXT_B);

    expect(state.snapshot()).toMatchObject({
      issuer: 'urn:test:b',
      trustChanged: true,
      tenant: CONTEXT_B.tenant,
      deployment: CONTEXT_B.deployment,
      bindings: [{ ...FIRST, verified: false }],
    });
  });

  it('reports a rotation detected before this process started', () => {
    const state = createDevtoolsDelegatedExchangeState();

    state.replace({ issuer: 'urn:test:b', jwks: JWKS_B, trustChanged: true }, [FIRST], CONTEXT_A);

    expect(state.snapshot()).toMatchObject({
      issuer: 'urn:test:b',
      trustChanged: true,
      tenant: CONTEXT_A.tenant,
      deployment: CONTEXT_A.deployment,
      bindings: [{ ...FIRST, verified: false }],
    });
  });

  it('ignores unknown success events and returns only cloned, deeply frozen public data', () => {
    const state = createDevtoolsDelegatedExchangeState();
    state.replace({ issuer: 'urn:test:a', jwks: JWKS_A, trustChanged: false }, [FIRST], CONTEXT_A);
    const unknownEvent = {
      bindingKey: 'sha256:unknown',
      token: 'not-public',
      error: 'not-public',
    };
    state.markVerified(unknownEvent);

    const first = state.snapshot();
    const second = state.snapshot();
    expect(first).toEqual({
      issuer: 'urn:test:a',
      jwks: JWKS_A,
      trustChanged: false,
      tenant: CONTEXT_A.tenant,
      deployment: CONTEXT_A.deployment,
      bindings: [{ ...FIRST, verified: false }],
    });
    expect(first).not.toBe(second);
    expect(first?.jwks).not.toBe(JWKS_A);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first?.jwks)).toBe(true);
    expect(Object.isFrozen(first?.jwks.keys)).toBe(true);
    expect(Object.isFrozen(first?.jwks.keys[0])).toBe(true);
    expect(Object.isFrozen(first?.bindings)).toBe(true);
    expect(Object.isFrozen(first?.bindings[0])).toBe(true);
    expect(JSON.stringify(first)).not.toMatch(/not-public|token|error/u);
  });

  it('requires active assertion context when delegated bindings are present', () => {
    const state = createDevtoolsDelegatedExchangeState();

    expect(() =>
      state.replace(
        { issuer: 'urn:test:a', jwks: JWKS_A, trustChanged: false },
        [FIRST],
        undefined,
      ),
    ).toThrow('delegated-exchange projections require public trust and active assertion context');
  });

  it('requires public trust when delegated bindings and assertion context are present', () => {
    const state = createDevtoolsDelegatedExchangeState();

    expect(() => state.replace(undefined, [FIRST], CONTEXT_A)).toThrow(
      'delegated-exchange projections require public trust and active assertion context',
    );
  });
});
