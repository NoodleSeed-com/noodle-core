import { compileManifest, InMemoryCatalog } from '@noodle-borg/compiler';
import { describe, expect, it } from 'vitest';
import {
  annotations,
  noodlePlatform,
  noodlePlatformCatalog,
  server,
  type ToolInteractionOptions,
  tool,
  z,
} from '../src/index.js';

/**
 * The `interaction` option (ADR 0240) is bounded metadata on the one `tool()` primitive: an opener
 * names the confirmed action it prepares, the fields a platform renderer collects for it, and which
 * of them are private. These tests freeze its spelling; later batches render it per channel.
 */

const demandSignal = z.enum(['Move to production', 'Reach more customers']);
const brief = z.object({
  workflow: z.string().trim().min(10).max(240),
  demandSignal,
});

const submitEnquiry = tool('submit_enquiry', {
  title: 'Send the enquiry',
  visibility: ['app'],
  description: 'Save the reviewed enquiry after explicit confirmation.',
  annotations: annotations.openAction({ destructive: false, confirm: true }),
  input: brief.extend({
    fullName: z.string().trim().min(2).max(120),
    workEmail: z.email().max(240),
    website: z
      .string()
      .trim()
      .max(240)
      .regex(/^(?:|https?:\/\/[^\s]+)$/iu),
    consentToContact: z.literal(true),
  }),
  output: z.object({ ok: z.boolean() }),
  fulfil: ({ input, connectors }) => {
    const saved = connectors.records.submitRecord({
      collection: 'leads',
      payload: {
        contact_name: input.fullName,
        contact_email: input.workEmail,
        website: input.website,
        workflow_summary: input.workflow,
        demand_signal: input.demandSignal,
        consent_to_contact: input.consentToContact,
      },
    });
    return { ok: saved.ok };
  },
});

const collect: ToolInteractionOptions = {
  kind: 'collect',
  action: submitEnquiry,
  initialValues: {
    workflow: { fromOutput: 'workflow' },
    demandSignal: { fromOutput: 'demandSignal' },
  },
  fields: [
    { key: 'fullName', control: 'text' },
    { key: 'workEmail', control: 'email', private: true },
    { key: 'website', control: 'url', optional: true },
    { key: 'demandSignal', control: 'select' },
    { key: 'consentToContact', control: 'consent' },
  ],
  review: 'all',
  outcome: { success: 'Your enquiry was saved.' },
};

function openContactForm(interaction: ToolInteractionOptions | undefined) {
  return tool('open_contact_form', {
    description: 'Open the enquiry once the visitor asks to be contacted.',
    annotations: annotations.readOnly(),
    input: brief,
    output: brief,
    fulfil: ({ input }) => ({ workflow: input.workflow, demandSignal: input.demandSignal }),
    ...(interaction === undefined ? {} : { interaction }),
  });
}

function app(interaction: ToolInteractionOptions | undefined) {
  return server(
    'acme_site',
    { title: 'Acme Site', version: '1.0.0', use: { records: noodlePlatform.records.v1 } },
    [openContactForm(interaction), submitEnquiry],
  );
}

describe('tool interaction authoring', () => {
  it('serializes the block verbatim with the action by name', async () => {
    const manifest = await app(collect).toManifest();
    const opener = manifest.tools.find((entry) => entry.name === 'open_contact_form');
    expect(opener).toHaveProperty('interaction', {
      kind: 'collect',
      action: 'submit_enquiry',
      initialValues: {
        workflow: { fromOutput: 'workflow' },
        demandSignal: { fromOutput: 'demandSignal' },
      },
      fields: [
        { key: 'fullName', control: 'text' },
        { key: 'workEmail', control: 'email', private: true },
        { key: 'website', control: 'url', optional: true },
        { key: 'demandSignal', control: 'select' },
        { key: 'consentToContact', control: 'consent' },
      ],
      review: 'all',
      outcome: { success: 'Your enquiry was saved.' },
    });
    // The action carries no interaction of its own, and nothing else about it changes.
    const action = manifest.tools.find((entry) => entry.name === 'submit_enquiry');
    expect(action).not.toHaveProperty('interaction');
  });

  it('emits nothing when a tool declares no interaction', async () => {
    const manifest = await app(undefined).toManifest();
    for (const entry of manifest.tools) expect(entry).not.toHaveProperty('interaction');
  });

  it('passes a shortened confirmation expiry through in seconds', async () => {
    const manifest = await app({ ...collect, confirmationExpiry: { seconds: 300 } }).toManifest();
    const opener = manifest.tools.find((entry) => entry.name === 'open_contact_form');
    expect(opener).toHaveProperty(['interaction', 'confirmationExpiry'], { seconds: 300 });
  });

  it('compiles through the real compiler into system-owned artifact data', async () => {
    const manifest = await app(collect).toManifest();
    const result = compileManifest(manifest, {
      catalog: new InMemoryCatalog(noodlePlatformCatalog),
    });
    expect(result.ok, result.ok ? '' : JSON.stringify(result.errors)).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.toolInteractions?.open_contact_form).toMatchObject({
      kind: 'collect',
      action: 'submit_enquiry',
      fields: expect.arrayContaining([{ key: 'workEmail', control: 'email', private: true }]),
    });
    const opener = result.artifact.tools.find((entry) => entry.name === 'open_contact_form');
    expect(opener?._meta).toBeUndefined();
  });

  it('refuses an action that is not a tool component', async () => {
    const notATool = {
      kind: 'resource' as const,
      name: 'faq',
      options: { uri: 'x', fulfil: () => 'x' },
    };
    const definition = app({
      ...collect,
      action: notATool as unknown as ToolInteractionOptions['action'],
    });
    await expect(definition.toManifest()).rejects.toThrow(/interaction\.action must be a tool/);
  });
});
