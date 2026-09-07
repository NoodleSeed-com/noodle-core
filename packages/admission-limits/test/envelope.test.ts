import { describe, expect, it } from 'vitest';
import {
  ADMISSION_DEFAULTS,
  ADMISSION_MAXIMUM,
  type AdmissionEnvelope,
  clamp,
  isDisabled,
} from '../src/envelope.js';

describe('public admission envelope', () => {
  it('uses the operator defaults when nothing is requested', () => {
    expect(clamp()).toEqual(ADMISSION_DEFAULTS);
  });

  /**
   * The envelope is non-bypassable by construction: neither app code nor managed config may raise a
   * bound. Table-driven so a new field cannot be added without deciding its ceiling.
   */
  it.each(
    Object.keys(ADMISSION_MAXIMUM) as (keyof AdmissionEnvelope)[],
  )('clamps %s down to the structural maximum', (field) => {
    const clamped = clamp({ [field]: ADMISSION_MAXIMUM[field] * 10 });
    expect(clamped[field]).toBe(ADMISSION_MAXIMUM[field]);
  });

  it.each(
    Object.keys(ADMISSION_MAXIMUM) as (keyof AdmissionEnvelope)[],
  )('honours a lower %s exactly', (field) => {
    const lower = Math.floor(ADMISSION_MAXIMUM[field] / 2);
    expect(clamp({ [field]: lower })[field]).toBe(lower);
  });

  it('falls back to the default for a missing, negative, or non-finite request', () => {
    expect(clamp({ turnsPerDay: -5 }).turnsPerDay).toBe(ADMISSION_DEFAULTS.turnsPerDay);
    expect(clamp({ turnsPerDay: Number.NaN }).turnsPerDay).toBe(ADMISSION_DEFAULTS.turnsPerDay);
    expect(clamp({ turnsPerDay: Number.POSITIVE_INFINITY }).turnsPerDay).toBe(
      ADMISSION_DEFAULTS.turnsPerDay,
    );
  });

  it('preserves zero, because zero is the kill switch', () => {
    const off = clamp({ turnsPerDay: 0 });
    expect(off.turnsPerDay).toBe(0);
    expect(isDisabled(off)).toBe(true);
    expect(isDisabled(clamp({ mintsPerDay: 0 }))).toBe(true);
    expect(isDisabled(clamp())).toBe(false);
  });

  it('defaults the daily caps well below their ceilings', () => {
    // A first pilot should fail safe on cost, not open at the structural maximum.
    expect(ADMISSION_DEFAULTS.turnsPerDay).toBeLessThan(ADMISSION_MAXIMUM.turnsPerDay);
    expect(ADMISSION_DEFAULTS.mintsPerDay).toBeLessThan(ADMISSION_MAXIMUM.mintsPerDay);
  });

  it('keeps the ADR 0201 per-session bounds as the ceiling', () => {
    expect(ADMISSION_MAXIMUM).toMatchObject({
      messageCharacters: 4_000,
      turnsPerSession: 40,
      modelStepsPerTurn: 6,
      toolCallsPerTurn: 8,
      pendingInteractions: 1,
      confirmationTtlMs: 600_000,
      sessionIdleMs: 1_800_000,
      sessionAbsoluteMs: 7_200_000,
    });
  });
});
