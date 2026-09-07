import type { ArtifactState } from '@noodle-borg/compiler';
import { describe, expect, it } from 'vitest';
import { claimableStateHandleNames } from '../src/index.js';

describe('claimable state declarations', () => {
  it('projects only opted-in handles in canonical order', () => {
    const state: ArtifactState = {
      handles: {
        workflow: {
          kind: 'workflow',
          schema: { type: 'object' },
          version: 'v2',
          scope: 'caller',
          ttlSeconds: 600,
          claimOnAuthentication: true,
        },
        privateSelection: {
          kind: 'selection',
          schema: { type: 'object' },
          version: 'v1',
          scope: 'caller',
          ttlSeconds: 600,
        },
        draft: {
          kind: 'draft',
          schema: { type: 'object' },
          version: 'v1',
          scope: 'caller',
          ttlSeconds: 600,
          claimOnAuthentication: true,
        },
      },
    };

    expect(claimableStateHandleNames(state)).toEqual(['draft', 'workflow']);
    expect(claimableStateHandleNames(undefined)).toEqual([]);
  });
});
