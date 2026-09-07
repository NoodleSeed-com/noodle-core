import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_NAMES,
  CAPABILITY_REQUIREMENT_NAMES,
  capabilityNameSchema,
  capabilityRequirementNameSchema,
  PRODUCT_FEATURES,
  SERVICE_PROFILE_NAMES,
  serviceProfileNameSchema,
  suggestCapabilityRequirementName,
} from '../src/index.js';

describe('capability contracts', () => {
  it('keeps product capability names canonical and ordered', () => {
    expect(CAPABILITY_NAMES).toEqual([
      'identity',
      'access',
      'controls',
      'audit',
      'observability',
      'secrets',
      'connectors',
      'apps',
    ]);
    expect(capabilityNameSchema.safeParse('policy').success).toBe(false);
  });

  it('keeps manifest requirements to infrastructure-gating capabilities only', () => {
    expect(CAPABILITY_REQUIREMENT_NAMES).toEqual([
      'identity',
      'access',
      'controls',
      'audit',
      'apps',
    ]);
    expect(capabilityRequirementNameSchema.safeParse('builder').success).toBe(false);
    expect(capabilityRequirementNameSchema.safeParse('observability').success).toBe(false);
    expect(capabilityRequirementNameSchema.safeParse('connectors').success).toBe(false);
    expect(capabilityRequirementNameSchema.safeParse('secrets').success).toBe(false);
  });

  it('suggests canonical requirement names for deprecated aliases', () => {
    expect(suggestCapabilityRequirementName('customerAuth')).toBe('identity');
    expect(suggestCapabilityRequirementName('rateLimits')).toBe('controls');
    expect(suggestCapabilityRequirementName('@vendor/module-audit')).toBe('audit');
    expect(suggestCapabilityRequirementName('unknown')).toBeUndefined();
  });

  it('keeps service profile names canonical and ordered', () => {
    expect(SERVICE_PROFILE_NAMES).toEqual([
      'noodle-cloud-managed',
      'open-core',
      'enterprise-governed',
      'public-saas',
      'agency-managed',
    ]);
    expect(serviceProfileNameSchema.safeParse('enterprise').success).toBe(false);
  });

  it('advertises dual-era serving and keeps modern host behavior at preview', () => {
    expect(PRODUCT_FEATURES.find((feature) => feature.id === 'mcp-2026-07-28')).toMatchObject({
      since: 'next',
      hosts: { claude: 'preview', chatgpt: 'preview', embedded: 'preview' },
    });
    expect(PRODUCT_FEATURES.find((feature) => feature.id === 'mcp-mrtr')).toMatchObject({
      since: 'next',
      hosts: { claude: 'preview', chatgpt: 'preview', embedded: 'preview' },
    });
    expect(
      PRODUCT_FEATURES.find((feature) => feature.id === 'mcp-oauth-client-credentials'),
    ).toMatchObject({
      since: 'next',
      hosts: { claude: 'preview', chatgpt: 'preview', embedded: 'preview' },
    });
    expect(PRODUCT_FEATURES.find((feature) => feature.id === 'tasks')?.since).toBe('future');
  });
});
