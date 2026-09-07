import { describe, expect, it } from 'vitest';
import { resumeTurnMessage, shouldAutoResume } from '../src/session-resume.js';

describe('shouldAutoResume', () => {
  it('is on by default and the per-exchange override wins both ways', () => {
    expect(shouldAutoResume(undefined)).toBe(true);
    expect(shouldAutoResume(true)).toBe(true);
    expect(shouldAutoResume(false)).toBe(false);
  });
});

describe('resumeTurnMessage', () => {
  it('is a platform message that names the tool and countermands the interception guidance', () => {
    const message = resumeTurnMessage('time_off_balance');
    expect(message.startsWith('[platform] ')).toBe(true);
    expect(message).toContain('"time_off_balance"');
    // The interception told the model to "offer to try again"; the resume must instruct the
    // opposite — complete the request without asking the visitor to repeat it.
    expect(message).toContain('do not ask them to repeat');
  });
});
