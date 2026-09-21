import { projectArtifactForSurface } from '@noodle-borg/assistant-gateway/portable';
import {
  BUILTIN_RECORD_CATALOG_CONNECTOR,
  compileManifest,
  InMemoryCatalog,
  type OperationSignature,
} from '@noodle-borg/compiler';
import { describe, expect, it } from 'vitest';
import { messagingProjectionIneligibility } from '../src/channels/messaging-eligibility.js';

const readSignature: OperationSignature = {
  type: 'read',
  input: { type: 'object', properties: { id: { type: 'string' } }, additionalProperties: false },
  output: { type: 'object', properties: { ok: { type: 'boolean' } }, additionalProperties: false },
};
const actionSignature: OperationSignature = {
  type: 'action',
  input: { type: 'object', properties: { email: { type: 'string' } }, additionalProperties: false },
  output: { type: 'object', properties: { ok: { type: 'boolean' } }, additionalProperties: false },
};
const catalog = new InMemoryCatalog([
  { id: 'acme', version: '1.0.0', operations: { look_up: readSignature, book: actionSignature } },
  BUILTIN_RECORD_CATALOG_CONNECTOR,
]);
const brief = {
  type: 'object',
  properties: { workflow: { type: 'string' } },
  required: ['workflow'],
  additionalProperties: false,
};
const enquiry = {
  type: 'object',
  properties: {
    workflow: { type: 'string' },
    fullName: { type: 'string' },
    consentToContact: { type: 'boolean', const: true },
  },
  required: ['workflow', 'fullName', 'consentToContact'],
  additionalProperties: false,
};
const collect = (action: string) => ({
  kind: 'collect',
  action,
  initialValues: { workflow: { fromOutput: 'workflow' } },
  fields: [
    { key: 'fullName', control: 'text' },
    { key: 'consentToContact', control: 'consent' },
  ],
  review: 'all',
  outcome: { success: 'Saved.' },
});
const empty = { type: 'object', properties: {}, additionalProperties: false };
const tool = (name: string) => ({ kind: 'tool' as const, name });

/**
 * The messaging surface authors only what the compiler admits; the website surface carries the rest so
 * the runtime gate can be handed projections an operator selection could never legitimately produce.
 */
const manifest = {
  manifestVersion: '2',
  server: {
    name: 'acme_site',
    title: 'Acme Site',
    version: '1.0.0',
    assistant: {
      model: { kind: 'noodle-managed' },
      allowedOrigins: ['https://acme.example'],
      surfaces: [
        {
          kind: 'messaging',
          channel: 'whatsapp',
          mode: 'public',
          capabilities: [tool('open_contact_form'), tool('submit_enquiry'), tool('health')],
        },
        {
          mode: 'public',
          origins: ['https://acme.example'],
          capabilities: [
            tool('open_demo_request'),
            tool('book_external'),
            tool('show_card'),
            tool('look_up'),
            tool('bare_write'),
          ],
        },
      ],
    },
  },
  connectors: {
    acme: { id: 'acme', version: '1.0.0' },
    records: { id: 'noodle_records', version: '1.0.0' },
  },
  widgets: [
    { name: 'card', tool: 'show_card', html: '<main/>' },
    { name: 'contact_widget', tool: 'open_contact_form', html: '<main/>' },
  ],
  tools: [
    {
      name: 'open_contact_form',
      description: 'Opener with a browser view.',
      inputSchema: brief,
      outputSchema: brief,
      annotations: { readOnlyHint: true },
      fulfilment: { steps: [], output: { workflow: '${input.workflow}' } },
      interaction: collect('submit_enquiry'),
    },
    {
      name: 'submit_enquiry',
      description: 'Native action.',
      inputSchema: enquiry,
      annotations: { readOnlyHint: false, confirm: true },
      visibility: ['app'],
      fulfilment: {
        steps: [
          {
            id: 'saved',
            use: 'records.submit_record',
            args: { collection: 'leads', payload: { contact_name: '${input.fullName}' } },
          },
        ],
        output: { ok: '${steps.saved.ok}' },
      },
    },
    {
      name: 'open_demo_request',
      description: 'Opener whose action leaves the platform.',
      inputSchema: brief,
      outputSchema: brief,
      annotations: { readOnlyHint: true },
      fulfilment: { steps: [], output: { workflow: '${input.workflow}' } },
      interaction: collect('book_external'),
    },
    {
      name: 'book_external',
      description: 'External action.',
      inputSchema: enquiry,
      annotations: { readOnlyHint: false, confirm: true },
      fulfilment: { use: 'acme.book', args: { email: '${input.fullName}' } },
    },
    {
      name: 'show_card',
      description: 'Widget read without an interaction.',
      inputSchema: empty,
      annotations: { readOnlyHint: true },
      fulfilment: { steps: [], output: { ok: true } },
    },
    {
      name: 'health',
      description: 'Pure read.',
      inputSchema: empty,
      annotations: { readOnlyHint: true },
      fulfilment: { steps: [], output: { ok: true } },
    },
    {
      name: 'look_up',
      description: 'Connector read.',
      inputSchema: empty,
      annotations: { readOnlyHint: true },
      fulfilment: { use: 'acme.look_up', args: { id: 'x' } },
    },
    {
      name: 'bare_write',
      description: 'Write without an interaction.',
      inputSchema: empty,
      annotations: { readOnlyHint: false, confirm: true },
      fulfilment: { steps: [], output: { ok: true } },
    },
  ],
};

function projected(...names: string[]) {
  const compiled = compileManifest(manifest, { catalog });
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
  return projectArtifactForSurface(compiled.artifact, names.map(tool));
}

describe('messaging projection eligibility (runtime gate C)', () => {
  it('accepts an opener with a browser view when its native-record action is selected beside it', () => {
    expect(messagingProjectionIneligibility(projected('open_contact_form', 'submit_enquiry'))).toBe(
      undefined,
    );
    expect(
      messagingProjectionIneligibility(projected('open_contact_form', 'submit_enquiry', 'health')),
    ).toBe(undefined);
    expect(messagingProjectionIneligibility(projected('health'))).toBe(undefined);
  });

  it('names the missing action when a binding selects the opener alone', () => {
    expect(messagingProjectionIneligibility(projected('open_contact_form'))).toBe(
      'channel_dependency_missing',
    );
  });

  it('still refuses the action without its opener, bare writes and widget reads', () => {
    expect(messagingProjectionIneligibility(projected('submit_enquiry'))).toBe(
      'messaging_action_unsupported',
    );
    expect(messagingProjectionIneligibility(projected('bare_write'))).toBe(
      'messaging_action_unsupported',
    );
    expect(messagingProjectionIneligibility(projected('show_card'))).toBe(
      'messaging_action_unsupported',
    );
  });

  it('still refuses connector reads and an action whose operation leaves the native records connector', () => {
    expect(messagingProjectionIneligibility(projected('look_up'))).toBe(
      'external_lookup_not_enabled',
    );
    expect(messagingProjectionIneligibility(projected('open_demo_request', 'book_external'))).toBe(
      'external_lookup_not_enabled',
    );
  });
});
