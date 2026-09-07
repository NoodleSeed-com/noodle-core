import { EffectiveConfigResponseSchema } from '@noodle-borg/wire-contracts';
import { describe, expect, it } from 'vitest';
import { projectEffectiveConfig } from '../src/config-value-projection.js';
import type { ConfigValueMetadata } from '../src/store.js';

const organization = { id: 'acme' };
const app = { id: 'support' };
const environment = { id: 'release', name: 'release', isProduction: true };

function value(
  kind: 'secret' | 'variable',
  name: string,
  scope: ConfigValueMetadata['scope'],
  content: string,
): ConfigValueMetadata {
  return {
    kind,
    name,
    scope,
    updatedAt: '2026-07-23T00:00:00.000Z',
    ...(kind === 'variable' ? { value: content } : {}),
  };
}

describe('projectEffectiveConfig', () => {
  it('rejects a secret response that contains a value key', () => {
    expect(
      EffectiveConfigResponseSchema.safeParse({
        kind: 'secret',
        environment,
        capabilities: { canManage: true, canReveal: true },
        entries: [
          {
            name: 'TOKEN',
            source: { kind: 'organization', organizationId: 'acme' },
            value: 'must-not-leak',
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('projects organization values with stable names and no secret values', () => {
    const response = projectEffectiveConfig({
      kind: 'secret',
      organization,
      app,
      environment,
      organizationValues: [
        value('secret', 'ZEBRA', { level: 'org', org: 'acme' }, 'zebra-secret'),
        value('secret', 'ALPHA', { level: 'org', org: 'acme' }, 'alpha-secret'),
      ],
      appValues: [],
      environmentValues: [],
    });

    expect(response).toEqual([
      {
        name: 'ALPHA',
        source: { kind: 'organization', organizationId: 'acme' },
      },
      {
        name: 'ZEBRA',
        source: { kind: 'organization', organizationId: 'acme' },
      },
    ]);
    expect(JSON.stringify(response)).not.toContain('secret');
  });

  it('uses app and environment overrides while retaining the next lower-precedence fallback', () => {
    const response = projectEffectiveConfig({
      kind: 'variable',
      organization,
      app,
      environment,
      organizationValues: [
        value('variable', 'REGION', { level: 'org', org: 'acme' }, 'us'),
        value('variable', 'ORG_ONLY', { level: 'org', org: 'acme' }, 'org'),
      ],
      appValues: [
        value('variable', 'REGION', { level: 'app', org: 'acme', app: 'support' }, 'eu'),
        value('variable', 'APP_ONLY', { level: 'app', org: 'acme', app: 'support' }, 'app'),
      ],
      environmentValues: [
        value(
          'variable',
          'REGION',
          { level: 'env', org: 'acme', app: 'support', env: 'release' },
          'apac',
        ),
      ],
    });

    expect(response).toEqual([
      {
        name: 'APP_ONLY',
        source: { kind: 'app', organizationId: 'acme', appId: 'support' },
        value: 'app',
      },
      {
        name: 'ORG_ONLY',
        source: { kind: 'organization', organizationId: 'acme' },
        value: 'org',
      },
      {
        name: 'REGION',
        source: {
          kind: 'environment',
          organizationId: 'acme',
          appId: 'support',
          environmentId: 'release',
          environmentName: 'release',
          isProduction: true,
        },
        fallbackSource: { kind: 'app', organizationId: 'acme', appId: 'support' },
        value: 'apac',
      },
    ]);
  });

  it('retains the organization source after an app override is deleted', () => {
    const response = projectEffectiveConfig({
      kind: 'variable',
      organization,
      app,
      environment,
      organizationValues: [value('variable', 'REGION', { level: 'org', org: 'acme' }, 'us')],
      appValues: [],
      environmentValues: [],
    });

    expect(response).toEqual([
      {
        name: 'REGION',
        source: { kind: 'organization', organizationId: 'acme' },
        value: 'us',
      },
    ]);
  });
});
