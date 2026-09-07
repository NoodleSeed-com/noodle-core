import { describe, expect, it } from 'vitest';
import { resolveContinuity } from '../src/continuity-bounds.js';
import {
  ASSISTANT_CONTINUITY_MAX_RESTORES,
  ASSISTANT_CONTINUITY_RESTORE_CEILING,
  ASSISTANT_CONTINUITY_WINDOW_CEILING_MS,
  ASSISTANT_CONTINUITY_WINDOW_MS,
} from '../src/continuity-store.js';

/**
 * The clamp from ADR 0223 clause 15: a developer declares safe defaults in `server.ts`, an operator may
 * tighten them, and neither may exceed the structural ceiling.
 *
 * One direction only. An operator who could widen a window would be spending a bound the platform set
 * on behalf of visitors whose conversation text is at stake, and an operator who could *enable*
 * continuity the developer never declared would be turning on a capability for a surface whose author
 * never reasoned about it.
 */
describe('resolving a surface continuity declaration against an operator override', () => {
  it('is off when nothing is declared, so silence never enables a capability', () => {
    expect(resolveContinuity(undefined, undefined).enabled).toBe(false);
    expect(resolveContinuity({}, undefined).enabled).toBe(false);
    expect(resolveContinuity({ enabled: false }, undefined).enabled).toBe(false);
  });

  it('uses the shipped defaults when the developer declares nothing but `enabled`', () => {
    expect(resolveContinuity({ enabled: true }, undefined)).toEqual({
      enabled: true,
      windowMs: ASSISTANT_CONTINUITY_WINDOW_MS,
      maxRestores: ASSISTANT_CONTINUITY_MAX_RESTORES,
    });
  });

  it('takes the developer’s declared values when they are inside the ceiling', () => {
    expect(
      resolveContinuity({ enabled: true, windowSeconds: 120, maxRestores: 2 }, undefined),
    ).toEqual({ enabled: true, windowMs: 120_000, maxRestores: 2 });
  });

  it('never exceeds the structural ceiling, whoever asked', () => {
    const declared = resolveContinuity(
      { enabled: true, windowSeconds: 99_999, maxRestores: 99 },
      undefined,
    );
    expect(declared.windowMs).toBe(ASSISTANT_CONTINUITY_WINDOW_CEILING_MS);
    expect(declared.maxRestores).toBe(ASSISTANT_CONTINUITY_RESTORE_CEILING);

    const overridden = resolveContinuity(
      { enabled: true },
      { windowSeconds: 99_999, maxRestores: 99 },
    );
    expect(overridden.windowMs).toBe(ASSISTANT_CONTINUITY_WINDOW_MS);
    expect(overridden.maxRestores).toBe(ASSISTANT_CONTINUITY_MAX_RESTORES);
  });

  it('lets an operator tighten either bound', () => {
    expect(
      resolveContinuity(
        { enabled: true, windowSeconds: 300, maxRestores: 5 },
        { windowSeconds: 60 },
      ),
    ).toEqual({ enabled: true, windowMs: 60_000, maxRestores: 5 });

    expect(
      resolveContinuity({ enabled: true, windowSeconds: 300, maxRestores: 5 }, { maxRestores: 1 }),
    ).toEqual({ enabled: true, windowMs: 300_000, maxRestores: 1 });
  });

  it('refuses to let an operator widen what a developer declared', () => {
    const resolved = resolveContinuity(
      { enabled: true, windowSeconds: 60, maxRestores: 1 },
      { windowSeconds: 600, maxRestores: 10 },
    );
    expect(resolved).toEqual({ enabled: true, windowMs: 60_000, maxRestores: 1 });
  });

  it('lets an operator switch continuity off, and never on', () => {
    expect(resolveContinuity({ enabled: true }, { enabled: false }).enabled).toBe(false);
    // The developer never declared it, so an operator asking for it changes nothing.
    expect(resolveContinuity(undefined, { enabled: true }).enabled).toBe(false);
    expect(resolveContinuity({ enabled: false }, { enabled: true }).enabled).toBe(false);
  });

  it('treats a zero bound from either party as the kill switch', () => {
    // Zero is a real value, not "unset": it disables continuity with no deploy, which is the whole
    // point of letting an operator reach for it.
    expect(resolveContinuity({ enabled: true, windowSeconds: 0 }, undefined).enabled).toBe(false);
    expect(resolveContinuity({ enabled: true, maxRestores: 0 }, undefined).enabled).toBe(false);
    expect(resolveContinuity({ enabled: true }, { windowSeconds: 0 }).enabled).toBe(false);
    expect(resolveContinuity({ enabled: true }, { maxRestores: 0 }).enabled).toBe(false);
  });

  it('fails a malformed bound closed rather than to the default', () => {
    // The opposite of the spend ladder's malformed allowance, and for the opposite reason: there, an
    // outage is worse than a day of unbudgeted cost. Here the thing configured is a capability, and
    // the safe failure for a capability is not to exist.
    for (const broken of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
      expect(resolveContinuity({ enabled: true, windowSeconds: broken }, undefined).enabled).toBe(
        false,
      );
      expect(resolveContinuity({ enabled: true, maxRestores: broken }, undefined).enabled).toBe(
        false,
      );
      expect(resolveContinuity({ enabled: true }, { windowSeconds: broken }).enabled).toBe(false);
      expect(resolveContinuity({ enabled: true }, { maxRestores: broken }).enabled).toBe(false);
    }
  });

  it('reports zeroed bounds when disabled, so a caller cannot read a live window off an off surface', () => {
    expect(resolveContinuity({ enabled: false }, undefined)).toEqual({
      enabled: false,
      windowMs: 0,
      maxRestores: 0,
    });
  });
});
