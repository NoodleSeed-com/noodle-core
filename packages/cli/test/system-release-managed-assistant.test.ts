import { describe, expect, it } from 'vitest';
import {
  managedAssistantReleaseConfig,
  parseManagedAssistantBetaTargets,
  parseManagedAssistantDefaultTier,
  parseManagedAssistantTurnsPerDay,
} from '../../../scripts/system-release-runtime-config.mjs';

describe('System Release managed-assistant configuration', () => {
  it('canonicalizes exact beta targets retained for rollback cohorts', () => {
    expect(parseManagedAssistantBetaTargets(undefined)).toBe('');
    expect(
      parseManagedAssistantBetaTargets(
        ' noodleseed/site-assistant/prod,acme/support/staging,noodleseed/site-assistant/prod ',
      ),
    ).toBe('acme/support/staging,noodleseed/site-assistant/prod');
    expect(() => parseManagedAssistantBetaTargets('noodleseed/*/prod')).toThrow(
      /invalid org\/app\/env target/i,
    );
  });

  it('validates the universal tier and bounded non-negative ceilings', () => {
    expect(parseManagedAssistantDefaultTier(undefined)).toBe('free');
    expect(parseManagedAssistantDefaultTier(' off ')).toBe('off');
    expect(() => parseManagedAssistantDefaultTier('paid')).toThrow(/free or off/i);
    expect(
      parseManagedAssistantTurnsPerDay(
        undefined,
        'NOODLE_MANAGED_ASSISTANT_ACCOUNT_TURNS_PER_DAY',
        100,
        100_000,
      ),
    ).toBe('100');
    expect(() =>
      parseManagedAssistantTurnsPerDay(
        '100001',
        'NOODLE_MANAGED_ASSISTANT_ACCOUNT_TURNS_PER_DAY',
        100,
        100_000,
      ),
    ).toThrow(/between 0 and 100000/i);
  });

  it('projects production defaults as one runtime-config unit', () => {
    expect(managedAssistantReleaseConfig({})).toEqual({
      managedAssistantBetaTargets: '',
      managedAssistantDefaultTier: 'free',
      managedAssistantAccountTurnsPerDay: '100',
      managedAssistantGlobalTurnsPerDay: '10000',
    });
  });
});
