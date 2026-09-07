/**
 * Characterization lock for `@noodle-borg/service`'s public export surface (ADR 0203 carve-out).
 *
 * `packages/service` is the composition root shared by `noodle dev` and the hosted service, and it
 * is about to be split: billing and the hosted control plane move to their own packages while
 * `serveService` and the data plane stay. Moving a symbol out is only safe if the move is *visible*
 * — otherwise an export disappears mid-refactor and nothing fails until something downstream breaks
 * at runtime.
 *
 * So the export list is snapshotted. During the carve-out it must not change: code moves packages,
 * the public API does not. When the surface is deliberately trimmed, the snapshot diff is the
 * review artifact and the *only* place that reduction is allowed to show up.
 *
 * The companion `route-surface-lock.test.ts` does the same for the HTTP routes.
 */
import { describe, expect, it } from 'vitest';
import * as service from '../src/index.js';

const EXPORTS = Object.keys(service).sort();

describe('service export surface lock', () => {
  it('exports exactly this set of names', () => {
    expect(EXPORTS).toMatchSnapshot();
  });

  it('keeps serveService exported so `noodle dev` composition is unaffected', () => {
    // packages/cli/src/dev.ts boots the local dev server through this exact symbol. The carve-out
    // must not change its identity or its arity, whatever moves out from under it.
    expect(typeof service.serveService).toBe('function');
    expect(EXPORTS).toContain('serveService');
  });

  it('reports the surface size so a bulk loss is visible in the diff', () => {
    // A single dropped export is caught by the snapshot above; this line makes wholesale collapse
    // (a barrel file failing to re-export) obvious at a glance in review.
    expect(EXPORTS.length).toMatchSnapshot();
  });
});
