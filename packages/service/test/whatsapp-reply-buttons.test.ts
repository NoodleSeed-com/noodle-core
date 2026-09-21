import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { reviewButtonBinding } from '../src/channels/reply-buttons.js';

const key = randomBytes(32).toString('base64');
const maya = reviewButtonBinding(key, 'binding-1', 'p_maya');

describe('WhatsApp review buttons', () => {
  it('renders three opaque, content-free ids that resolve only for their own proposal and participant', () => {
    const buttons = maya.render('proposal-1');
    expect(buttons.map((button) => button.title)).toEqual(['Confirm', 'Edit', 'Cancel']);
    for (const button of buttons) {
      expect(button.id).toMatch(/^b_[A-Za-z0-9_-]{43}$/);
      expect(button.id).not.toMatch(/maya|proposal|binding|confirm|edit|cancel/i);
    }
    expect(buttons.map((button) => maya.act('proposal-1', button.id))).toEqual([
      'confirm',
      'edit',
      'cancel',
    ]);
    const [confirm] = buttons;
    if (confirm === undefined) throw new Error('buttons');
    // Stale: the same participant's earlier review. Foreign: another participant, or another
    // binding, holding the same proposal id. Forged: anything not minted with the private seed.
    expect(maya.act('proposal-2', confirm.id)).toBeUndefined();
    expect(
      reviewButtonBinding(key, 'binding-1', 'p_other').act('proposal-1', confirm.id),
    ).toBeUndefined();
    expect(
      reviewButtonBinding(key, 'binding-2', 'p_maya').act('proposal-1', confirm.id),
    ).toBeUndefined();
    expect(
      reviewButtonBinding(randomBytes(32).toString('base64'), 'binding-1', 'p_maya').act(
        'proposal-1',
        confirm.id,
      ),
    ).toBeUndefined();
    expect(maya.act('proposal-1', `${confirm.id}x`)).toBeUndefined();
    expect(maya.act('proposal-1', 'b_forged')).toBeUndefined();
  });
});
