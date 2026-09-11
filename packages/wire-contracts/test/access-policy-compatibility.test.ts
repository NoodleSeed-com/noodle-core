import { describe, expect, it } from 'vitest';
import {
  accessUpdateClientResponseSchema,
  accessUpdateResponseSchema,
  deploymentAuthenticationSchema,
} from '../src/index.js';

describe('access policy compatibility', () => {
  it('accepts only the bounded effective authentication authorities', () => {
    expect(deploymentAuthenticationSchema.options).toEqual(['none', 'platform', 'customer']);
    expect(deploymentAuthenticationSchema.safeParse('hybrid').success).toBe(false);
  });

  it('accepts a future policy-only change while retaining additive client compatibility', () => {
    const response = {
      ok: true,
      target: { org: 'acme', app: 'support', env: 'prod' },
      deployment: {
        deploymentId: 'dep_policy',
        accessMode: 'mixed',
        authentication: 'customer',
      },
      previousAccessMode: 'mixed',
      accessChanged: false,
      ownerChanged: false,
      policyChanged: true,
      changed: true,
    } as const;

    expect(accessUpdateResponseSchema.safeParse(response).success).toBe(true);
    expect(accessUpdateClientResponseSchema.parse(response)).toMatchObject({
      deployment: { authentication: 'customer' },
      accessChanged: false,
      ownerChanged: false,
      policyChanged: true,
      changed: true,
    });
  });

  it('rejects malformed or incomplete authentication policy metadata', () => {
    const response = {
      ok: true,
      target: { org: 'acme', app: 'support', env: 'prod' },
      deployment: {
        deploymentId: 'dep_policy',
        accessMode: 'mixed',
        authentication: 'customer',
      },
      previousAccessMode: 'mixed',
      accessChanged: false,
      ownerChanged: false,
      policyChanged: true,
      changed: true,
    } as const;

    expect(
      accessUpdateClientResponseSchema.safeParse({
        ...response,
        deployment: { ...response.deployment, authentication: 'hybrid' },
      }).success,
    ).toBe(false);
    expect(
      accessUpdateClientResponseSchema.safeParse({ ...response, policyChanged: undefined }).success,
    ).toBe(false);
    expect(
      accessUpdateClientResponseSchema.safeParse({ ...response, accessChanged: undefined }).success,
    ).toBe(false);
    expect(
      accessUpdateClientResponseSchema.safeParse({ ...response, changed: false }).success,
    ).toBe(false);
  });
});
