import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ChannelReplyButton } from '@noodle-borg/assistant-gateway/portable';

/**
 * Native review buttons for WhatsApp (ADR 0240 decision 5). Each id is an opaque keyed digest over
 * the binding's private index seed, the participant, the proposal and the act: it encodes nothing,
 * cannot be minted without the seed, is bound to one review revision, and dies with that proposal.
 * Nothing about the person, the values or the tool ever enters a button id or title.
 */
export type ReviewAct = 'confirm' | 'edit' | 'cancel';
const ACTS: readonly ReviewAct[] = ['confirm', 'edit', 'cancel'];
export const REVIEW_BUTTON_TITLES: Readonly<Record<ReviewAct, string>> = {
  confirm: 'Confirm',
  edit: 'Edit',
  cancel: 'Cancel',
};
export interface ReviewButtonBinding {
  /** The three buttons for one proposal, in the order the participant sees them. */
  render(proposalId: string): readonly ChannelReplyButton[];
  /** The act a tapped id proves for this proposal, or nothing for an unknown, stale or foreign token. */
  act(proposalId: string, buttonId: string): ReviewAct | undefined;
}

export function reviewButtonBinding(
  indexKey: string,
  bindingId: string,
  participantId: string,
): ReviewButtonBinding {
  const id = (proposalId: string, act: ReviewAct) =>
    `b_${createHmac('sha256', Buffer.from(indexKey, 'base64'))
      .update(JSON.stringify(['review-button', bindingId, participantId, proposalId, act]))
      .digest('base64url')}`;
  return {
    render: (proposalId) =>
      ACTS.map((act) => ({ id: id(proposalId, act), title: REVIEW_BUTTON_TITLES[act] })),
    act: (proposalId, buttonId) => {
      const tapped = Buffer.from(buttonId);
      return ACTS.find((act) => {
        const expected = Buffer.from(id(proposalId, act));
        return expected.length === tapped.length && timingSafeEqual(expected, tapped);
      });
    },
  };
}
