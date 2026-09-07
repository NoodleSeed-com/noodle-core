import { describe, expect, it } from 'vitest';
import {
  validateMcpSubdomain,
  validateOpenAIAppsChallenge,
  validateOrgRole,
  validateSlug,
  validateUserOwnedOrgSlug,
} from '../src/index.js';

describe('control-plane organization contracts', () => {
  it.each([
    ['a', 'a'],
    ['arez-io', 'arez-io'],
    ['a'.repeat(63), 'a'.repeat(63)],
  ])('accepts the existing tenant DNS-label contract for %s', (input, expected) => {
    expect(validateSlug('org', input)).toBe(expected);
  });

  it.each([
    'Arez',
    ' arez',
    'arez ',
    '-arez',
    'arez-',
    'a'.repeat(64),
    'mcp',
  ])('rejects an invalid or reserved organization label: %s', (input) =>
    expect(() => validateSlug('org', input)).toThrow());

  it('keeps the local organization reserved for system bootstrap', () => {
    expect(() => validateUserOwnedOrgSlug('local')).toThrow(
      'organization slug "local" is reserved for system use',
    );
  });

  it.each([
    ['a', 'a'],
    ['arez-io', 'arez-io'],
    ['a'.repeat(63), 'a'.repeat(63)],
  ])('accepts an MCP subdomain using the tenant DNS-label contract: %s', (input, expected) => {
    expect(validateMcpSubdomain(input)).toBe(expected);
  });

  it.each([
    'Arez',
    ' arez',
    'arez ',
    '-arez',
    'arez-',
    'a'.repeat(64),
    'mcp',
    'local',
  ])('rejects an invalid or reserved MCP subdomain: %s', (input) =>
    expect(() => validateMcpSubdomain(input)).toThrow());

  it('keeps exact organization roles and one-line OpenAI challenges', () => {
    expect(validateOrgRole('owner')).toBe('owner');
    expect(validateOrgRole('developer')).toBe('developer');
    expect(() => validateOrgRole('admin')).toThrow();
    expect(validateOpenAIAppsChallenge('challenge-value')).toBe('challenge-value');
    expect(() => validateOpenAIAppsChallenge('line-1\nline-2')).toThrow();
  });
});
