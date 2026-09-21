import { ARTIFACT_SCHEMA_VERSION, type RuntimeArtifact } from '@noodle-borg/compiler';
import { describe, expect, it } from 'vitest';
import { applyCapture, attachProposal, openCollection } from '../src/collection-ledger.js';
import { renderReview } from '../src/collection-review.js';
import {
  collectionSpecFor,
  seedCollection,
  WHATSAPP_CONFIRMATION_EXPIRY_MS,
} from '../src/collection-spec.js';

const NOW = 1_800_000_000_000;

function artifact(options: { consent?: boolean; expirySeconds?: number } = {}): RuntimeArtifact {
  const consent = options.consent ?? true;
  return {
    artifactSchemaVersion: ARTIFACT_SCHEMA_VERSION,
    resolution: 'resolved',
    source: { manifestName: 'site', manifestVersion: '1.0.0', coreVersion: '2' },
    server: { name: 'site', version: '1.0.0', title: 'Acme Site', branding: { name: 'Acme' } },
    tools: [
      {
        name: 'open_contact_form',
        description: 'Opener.',
        inputSchema: { type: 'object', properties: {} },
        outputSchema: { type: 'object', properties: { workflow: { type: 'string' } } },
        annotations: { readOnlyHint: true },
        fulfilment: { kind: 'flow', steps: [], output: {} },
      },
      {
        name: 'submit_enquiry',
        description: 'Action.',
        inputSchema: {
          type: 'object',
          required: ['workflow', 'fullName', 'workEmail', 'demandSignal', 'consentToContact'],
          properties: {
            workflow: { type: 'string', minLength: 10, title: 'First useful workflow' },
            fullName: { type: 'string', minLength: 2, title: 'Your name' },
            workEmail: { type: 'string', format: 'email' },
            website: { type: 'string', title: 'Company website' },
            demandSignal: { type: 'string', enum: ['A customer asked', 'Evaluate'] },
            consentToContact: { type: 'boolean', const: true, title: 'Permission to contact you' },
          },
        },
        annotations: { readOnlyHint: false, confirm: true },
        fulfilment: { kind: 'flow', steps: [], output: {} },
      },
    ],
    capabilities: { tools: [] },
    toolInteractions: {
      open_contact_form: {
        kind: 'collect',
        action: 'submit_enquiry',
        initialValues: { workflow: { fromOutput: 'workflow' } },
        fields: [
          { key: 'fullName', control: 'text' },
          { key: 'workEmail', control: 'email', private: true },
          { key: 'website', control: 'url', optional: true },
          { key: 'demandSignal', control: 'select' },
          ...(consent ? [{ key: 'consentToContact', control: 'consent' as const }] : []),
        ],
        review: 'all',
        outcome: { success: 'Your enquiry was saved.' },
        ...(options.expirySeconds === undefined
          ? {}
          : { confirmationExpirySeconds: options.expirySeconds }),
      },
    },
  };
}

describe('collection spec derivation from the compiled interaction', () => {
  it('reads titles, options, privacy and validation from the action input schema', () => {
    const spec = collectionSpecFor(
      artifact(),
      'open_contact_form',
      WHATSAPP_CONFIRMATION_EXPIRY_MS,
    );
    expect(spec).toMatchObject({
      interactionId: 'open_contact_form',
      action: 'submit_enquiry',
      successMessage: 'Your enquiry was saved.',
      confirmationExpiryMs: WHATSAPP_CONFIRMATION_EXPIRY_MS,
      consentQuestion: 'Do you agree to Acme contacting you about this request? Yes or no.',
    });
    expect(spec?.fields.map((field) => [field.key, field.title, field.control])).toEqual([
      ['fullName', 'Your name', 'text'],
      ['workEmail', 'Work email', 'email'],
      ['website', 'Company website', 'url'],
      ['demandSignal', 'Demand signal', 'select'],
      ['consentToContact', 'Permission to contact you', 'consent'],
    ]);
    expect(spec?.fields[1]).toMatchObject({ private: true, schema: { format: 'email' } });
    expect(spec?.fields[2]).toMatchObject({ optional: true });
    expect(spec?.fields[3]?.options).toEqual(['A customer asked', 'Evaluate']);
  });

  it('lets the author shorten but never lengthen the profile expiry', () => {
    expect(
      collectionSpecFor(artifact({ expirySeconds: 120 }), 'open_contact_form', 600_000)
        ?.confirmationExpiryMs,
    ).toBe(120_000);
    expect(
      collectionSpecFor(artifact({ expirySeconds: 86_400 }), 'open_contact_form', 600_000)
        ?.confirmationExpiryMs,
    ).toBe(600_000);
  });

  it('returns nothing for a tool without an interaction or whose action is absent', () => {
    expect(collectionSpecFor(artifact(), 'submit_enquiry', 600_000)).toBeUndefined();
    const orphan = { ...artifact(), tools: artifact().tools.slice(0, 1) };
    expect(collectionSpecFor(orphan, 'open_contact_form', 600_000)).toBeUndefined();
  });

  it('seeds initial values: fields are captured when valid, other inputs ride along', () => {
    const spec = collectionSpecFor(artifact(), 'open_contact_form', 600_000);
    if (spec === undefined) throw new Error('spec');
    const ledger = openCollection(spec, {
      id: 'c1',
      bindingId: 'b1',
      participantId: 'p1',
      now: NOW,
    });
    const seeded = seedCollection(
      artifact(),
      spec,
      ledger,
      { workflow: 'Answer questions on WhatsApp', policy: 'The form below is ready.' },
      NOW,
    );
    expect(seeded.values).toEqual({ workflow: 'Answer questions on WhatsApp' });
    expect(seeded.fields.fullName?.status).toBe('missing');
    expect(seeded.phase).toBe('collecting');
    const base = artifact();
    const interaction = base.toolInteractions?.open_contact_form;
    if (interaction === undefined) throw new Error('interaction');
    const withField = {
      ...base,
      toolInteractions: {
        open_contact_form: {
          ...interaction,
          initialValues: {
            demandSignal: { fromOutput: 'signal' },
            fullName: { fromOutput: 'name' },
          },
        },
      },
    };
    const captured = seedCollection(
      withField,
      spec,
      ledger,
      { signal: 'Evaluate', name: 'M' },
      NOW,
    );
    expect(captured.fields.demandSignal).toMatchObject({ status: 'captured' });
    expect(captured.values.demandSignal).toBe('Evaluate');
    expect(captured.fields.fullName).toMatchObject({ status: 'invalid', reason: 'schema' });
    expect(captured.values).not.toHaveProperty('fullName');
  });

  it('completes straight to confirmation and reviews without a consent line when no consent control exists', () => {
    const spec = collectionSpecFor(artifact({ consent: false }), 'open_contact_form', 600_000);
    if (spec === undefined) throw new Error('spec');
    const ledger = applyCapture(
      spec,
      openCollection(spec, { id: 'c1', bindingId: 'b1', participantId: 'p1', now: NOW }),
      {
        fullName: { status: 'captured', value: 'Maya' },
        workEmail: { status: 'captured', value: 'maya@example.com' },
        demandSignal: { status: 'captured', value: 'Evaluate' },
      },
      NOW,
    );
    expect(ledger.phase).toBe('awaiting_confirmation');
    const proposed = attachProposal(spec, ledger, { id: 'p1', review: 'r', continuation: {} }, NOW);
    expect(proposed.proposal?.id).toBe('p1');
    expect(renderReview(spec, ledger.values, undefined)).toBe(
      'Your name: Maya\nWork email: maya@example.com\nCompany website: none\nDemand signal: Evaluate',
    );
  });
});
