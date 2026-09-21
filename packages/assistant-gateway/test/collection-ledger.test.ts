import { describe, expect, it } from 'vitest';
import { CHANNEL_RETENTION_MS } from '../src/channel-types.js';
import {
  applyCapture,
  applyConfirmation,
  applyConsent,
  attachProposal,
  cancelCollection,
  completeCollection,
  expireCollection,
  neededFields,
  pendingProposal,
  rejectField,
  withdrawProposal,
} from '../src/collection-ledger.js';
import { ledgerForModel, renderReview } from '../src/collection-review.js';
import { leadSpec, NOW, openLead } from './collection-fixture.js';

const complete = {
  name: { status: 'captured', value: 'Maya Chen' },
  email: { status: 'captured', value: 'maya@example.com' },
  company: { status: 'captured', value: 'Maple Labs' },
  workflow: { status: 'captured', value: 'Add WhatsApp to our website assistant' },
} as const;

function readyForReview() {
  const collected = applyCapture(leadSpec, openLead(), complete, NOW + 1);
  return applyConsent(leadSpec, collected, 'given', 'consent-v1', NOW + 2);
}

describe('collection ledger transitions', () => {
  it('opens with every field missing and expires with channel retention', () => {
    const ledger = openLead();
    expect(ledger.phase).toBe('collecting');
    expect(Object.keys(ledger.fields)).toEqual(leadSpec.fields.map((field) => field.key));
    expect(Object.values(ledger.fields).every((field) => field.status === 'missing')).toBe(true);
    expect(ledger.values).toEqual({});
    expect(Date.parse(ledger.expiresAt)).toBe(NOW + CHANNEL_RETENTION_MS);
    expect(neededFields(leadSpec, ledger).map((field) => field.key)).toEqual([
      'name',
      'email',
      'company',
      'website',
      'size',
      'workflow',
    ]);
  });
  it('moves to awaiting_consent once required fields are captured, optional ones may stay missing', () => {
    const partial = applyCapture(
      leadSpec,
      openLead(),
      { name: { status: 'captured', value: 'Maya Chen' } },
      NOW + 1,
    );
    expect(partial.phase).toBe('collecting');
    expect(partial.fields.name).toEqual({ status: 'captured', attempts: 1 });
    expect(partial.updatedAt).toBe(new Date(NOW + 1).toISOString());
    const collected = applyCapture(leadSpec, partial, complete, NOW + 2);
    expect(collected.phase).toBe('awaiting_consent');
    expect(collected.fields.website?.status).toBe('missing');
    expect(collected.fields.name?.attempts).toBe(2);
    expect(neededFields(leadSpec, collected).map((field) => field.key)).toEqual([
      'website',
      'size',
    ]);
  });
  it('records invalid and ambiguous outcomes as codes and keeps collecting', () => {
    const ledger = applyCapture(
      leadSpec,
      openLead(),
      {
        ...complete,
        email: { status: 'invalid', reason: 'format' },
        website: { status: 'ambiguous', reason: 'multiple_candidates' },
      },
      NOW + 1,
    );
    expect(ledger.phase).toBe('collecting');
    expect(ledger.fields.email).toEqual({ status: 'invalid', reason: 'format', attempts: 1 });
    expect(ledger.fields.website).toEqual({
      status: 'ambiguous',
      reason: 'multiple_candidates',
      attempts: 1,
    });
    expect(ledger.values).not.toHaveProperty('email');
  });
  it('rejecting a field keeps its value for correction and reopens collection', () => {
    const rejected = rejectField(leadSpec, readyForReview(), 'email', NOW + 3);
    expect(rejected.phase).toBe('collecting');
    expect(rejected.fields.email).toMatchObject({ status: 'rejected_by_user', reason: 'rejected' });
    expect(rejected.values.email).toBe('maya@example.com');
    expect(rejected.consent?.given).toBe(true);
    expect(neededFields(leadSpec, rejected).map((field) => field.key)).toContain('email');
  });
  it('stores consent as boolean, question version and time, never the reply', () => {
    const given = readyForReview();
    expect(given.phase).toBe('awaiting_confirmation');
    expect(given.consent).toEqual({
      given: true,
      questionVersion: 'consent-v1',
      at: new Date(NOW + 2).toISOString(),
    });
    expect(given.values.consent).toBe(true);
    expect(given.fields.consent?.status).toBe('captured');
    const declined = applyConsent(
      leadSpec,
      applyCapture(leadSpec, openLead(), complete, NOW + 1),
      'declined',
      'consent-v1',
      NOW + 2,
    );
    expect(declined.phase).toBe('cancelled');
    expect(declined.consent?.given).toBe(false);
    expect(declined.values).toEqual({});
    expect(() =>
      applyConsent(leadSpec, openLead(), 'given', 'consent-v1', NOW),
    ).toThrowErrorMatchingInlineSnapshot(`[CollectionError: phase_invalid]`);
  });
  it('attaches a proposal bound to the spec expiry and confirms only while it is pending', () => {
    const proposed = attachProposal(
      leadSpec,
      readyForReview(),
      { id: 'prop_1', review: 'Name: Maya Chen', continuation: { kind: 'prepared_confirmation' } },
      NOW + 3,
    );
    expect(proposed.proposal).toEqual({
      id: 'prop_1',
      review: 'Name: Maya Chen',
      continuation: { kind: 'prepared_confirmation' },
      createdAt: new Date(NOW + 3).toISOString(),
      expiresAt: new Date(NOW + 3 + leadSpec.confirmationExpiryMs).toISOString(),
    });
    expect(pendingProposal(proposed, NOW + 4)?.id).toBe('prop_1');
    expect(pendingProposal(proposed, NOW + 3 + leadSpec.confirmationExpiryMs)).toBeUndefined();
    const executing = applyConfirmation(proposed, 'confirm', NOW + 5);
    expect(executing.phase).toBe('executing');
    expect(executing.proposal?.id).toBe('prop_1');
    const completed = completeCollection(executing, NOW + 6);
    expect(completed.phase).toBe('completed');
    expect(completed.values).toEqual({});
    expect(completed.proposal).toBeUndefined();
    expect(completed.executedProposalId).toBe('prop_1');
    const withdrawn = withdrawProposal(proposed, NOW + 4);
    expect(withdrawn.proposal).toBeUndefined();
    expect(withdrawn.phase).toBe('awaiting_confirmation');
    expect(withdrawn.values).toEqual(proposed.values);
    expect(pendingProposal(withdrawn, NOW + 4)).toBeUndefined();
    expect(() =>
      applyConfirmation(proposed, 'confirm', NOW + 3 + leadSpec.confirmationExpiryMs),
    ).toThrowErrorMatchingInlineSnapshot(`[CollectionError: proposal_expired]`);
    expect(() =>
      attachProposal(leadSpec, openLead(), { id: 'x', review: '', continuation: {} }, NOW),
    ).toThrowErrorMatchingInlineSnapshot(`[CollectionError: phase_invalid]`);
  });
  it('invalidates the proposal on any new value and requires a fresh one', () => {
    const proposed = attachProposal(
      leadSpec,
      readyForReview(),
      { id: 'prop_1', review: 'r', continuation: {} },
      NOW + 3,
    );
    const edited = applyCapture(
      leadSpec,
      proposed,
      { company: { status: 'captured', value: 'Maple Labs Ltd' } },
      NOW + 4,
    );
    expect(edited.proposal).toBeUndefined();
    expect(edited.phase).toBe('awaiting_confirmation');
    expect(edited.values.company).toBe('Maple Labs Ltd');
    expect(edited.consent?.given).toBe(true);
    const untouched = applyCapture(leadSpec, proposed, {}, NOW + 4);
    expect(untouched.proposal?.id).toBe('prop_1');
    expect(untouched.phase).toBe('awaiting_confirmation');
    const broken = applyCapture(
      leadSpec,
      proposed,
      { email: { status: 'invalid', reason: 'format' } },
      NOW + 4,
    );
    expect(broken.proposal).toBeUndefined();
    expect(broken.phase).toBe('collecting');
    expect(() => applyConfirmation(edited, 'confirm', NOW + 5)).toThrowErrorMatchingInlineSnapshot(
      `[CollectionError: proposal_missing]`,
    );
  });
  it('cancels and expires without leaving values or continuations behind', () => {
    const proposed = attachProposal(
      leadSpec,
      readyForReview(),
      { id: 'prop_1', review: 'r', continuation: { secret: true } },
      NOW + 3,
    );
    const cancelled = cancelCollection(proposed, NOW + 4);
    expect(cancelled).toMatchObject({ phase: 'cancelled', values: {} });
    expect(cancelled.proposal).toBeUndefined();
    expect(applyConfirmation(proposed, 'cancel', NOW + 4).phase).toBe('cancelled');
    expect(expireCollection(proposed, NOW + 4)).toBe(proposed);
    const proposalExpired = expireCollection(proposed, NOW + 3 + leadSpec.confirmationExpiryMs);
    expect(proposalExpired.phase).toBe('awaiting_confirmation');
    expect(proposalExpired.proposal).toBeUndefined();
    expect(proposalExpired.values.email).toBe('maya@example.com');
    const gone = expireCollection(proposed, NOW + CHANNEL_RETENTION_MS);
    expect(gone).toMatchObject({ phase: 'expired', values: {} });
    expect(gone.proposal).toBeUndefined();
    expect(() =>
      applyCapture(leadSpec, gone, complete, NOW + CHANNEL_RETENTION_MS + 1),
    ).toThrowErrorMatchingInlineSnapshot(`[CollectionError: phase_invalid]`);
  });
});

describe('review rendering and model projection', () => {
  it('renders the review verbatim, in spec order, with none for blank optionals', () => {
    const ledger = readyForReview();
    expect(renderReview(leadSpec, ledger.values, ledger.consent)).toBe(
      [
        'Name: Maya Chen',
        'Work email: maya@example.com',
        'Company: Maple Labs',
        'Website: none',
        'Team size: none',
        'Request: Add WhatsApp to our website assistant',
        'Contact permission: yes',
      ].join('\n'),
    );
    expect(renderReview(leadSpec, ledger.values, undefined)).toMatch(/Contact permission: no$/);
  });
  it('projects statuses and non-private values only', () => {
    const proposed = attachProposal(
      leadSpec,
      readyForReview(),
      { id: 'prop_1', review: 'r', continuation: { token: 'never' } },
      NOW + 3,
    );
    const view = ledgerForModel(leadSpec, proposed, NOW + 4);
    expect(view).toEqual({
      phase: 'awaiting_confirmation',
      consent: 'given',
      pendingProposal: true,
      fields: [
        { key: 'name', title: 'Name', status: 'captured' },
        { key: 'email', title: 'Work email', status: 'captured' },
        { key: 'company', title: 'Company', status: 'captured' },
        { key: 'website', title: 'Website', status: 'missing' },
        { key: 'size', title: 'Team size', status: 'missing' },
        { key: 'workflow', title: 'Request', status: 'captured' },
      ],
      values: {
        name: 'Maya Chen',
        company: 'Maple Labs',
        workflow: 'Add WhatsApp to our website assistant',
      },
    });
    const serialised = JSON.stringify(view);
    expect(serialised).not.toContain('maya@example.com');
    expect(serialised).not.toContain('never');
    const invalid = ledgerForModel(
      leadSpec,
      applyCapture(leadSpec, openLead(), { email: { status: 'invalid', reason: 'format' } }, NOW),
      NOW,
    );
    expect(invalid.fields[1]).toEqual({
      key: 'email',
      title: 'Work email',
      status: 'invalid',
      reason: 'format',
    });
    expect(invalid.pendingProposal).toBe(false);
    expect(invalid).not.toHaveProperty('consent');
  });
});
