import type { ExecuteDeps } from '@noodle-borg/runtime';
import { describe, expect, it } from 'vitest';
import { withAssistantTurnExecutionAuthority } from '../src/assistant-turn-context.js';
import {
  messagingSurfaceOf,
  publicSurfaceOf,
  surfaceBindingForOrigin,
} from '../src/public-surface.js';

describe('messaging context isolation', () => {
  it('selects messaging independently from website surfaces and never grants an origin', () => {
    const messaging = {
      kind: 'messaging',
      mode: 'public',
      channel: 'whatsapp',
      capabilities: [{ kind: 'tool', name: 'identity' }],
      instructions: 'Keep it short',
    };
    const assistant = {
      surfaces: [
        messaging,
        { mode: 'public', origins: ['https://noodleseed.dev'], capabilities: [] },
      ],
    };
    expect(messagingSurfaceOf(assistant)?.instructions).toBe('Keep it short');
    expect(publicSurfaceOf(assistant)?.origins).toEqual(['https://noodleseed.dev']);
    expect(surfaceBindingForOrigin({ surfaces: [messaging] }, 'https://noodleseed.dev')).toEqual({
      kind: 'unowned',
    });
  });
  it('does not create or inherit customer identity from a messaging participant', () => {
    const deps = { customerIssuer: 'must-not-leak' } as ExecuteDeps;
    const result = withAssistantTurnExecutionAuthority(deps, {}, { kind: 'messaging' });
    expect(result).not.toHaveProperty('customerIssuer');
  });
});
