import type { AccessMode } from '@noodle-borg/module';
import { describe, expect, it } from 'vitest';
import { deploymentAuthenticationFor } from '../src/deployment-authentication.js';

function authority(input: {
  readonly schemaVersion?: number;
  readonly accessMode?: AccessMode;
  readonly hasServerAuth?: boolean;
}) {
  return deploymentAuthenticationFor({
    schemaVersion: input.schemaVersion ?? 1,
    accessMode: input.accessMode,
    ...(input.hasServerAuth === true
      ? { serverAuth: { issuer: 'https://idp.example', audience: 'api://app' } }
      : {}),
  });
}

describe('deployment authentication authority projection', () => {
  it.each([
    ['public', 'none'],
    ['owner-only', 'platform'],
    ['org-members', 'platform'],
    ['authenticated', 'platform'],
    ['mixed', 'platform'],
    ['customers', 'customer'],
  ] as const)('projects schema-version 1 %s access as %s authority', (accessMode, expected) => {
    expect(authority({ accessMode, hasServerAuth: true })).toBe(expected);
  });

  it('does not infer authority from an absent legacy access mode', () => {
    expect(authority({})).toBeUndefined();
  });

  it('does not project authority for an unsupported record version', () => {
    expect(
      authority({ schemaVersion: 3, accessMode: 'mixed', hasServerAuth: true }),
    ).toBeUndefined();
  });

  it('reports schema-2 mixed customer authority only when customer auth is declared', () => {
    expect(authority({ schemaVersion: 2, accessMode: 'mixed', hasServerAuth: true })).toBe(
      'customer',
    );
    expect(authority({ schemaVersion: 2, accessMode: 'mixed' })).toBe('platform');
  });
});
