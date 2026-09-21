import {
  BUILTIN_RECORD_CATALOG_CONNECTOR,
  compileManifest,
  InMemoryCatalog,
  type RuntimeArtifact,
} from '@noodle-borg/compiler';
import {
  type ExecuteDeps,
  InMemoryConnectorRegistry,
  type InvocationContext,
} from '@noodle-borg/runtime';
import { describe, expect, it } from 'vitest';
import type { MessagingTurnContext } from '../src/assistant-turn-context.js';
import type { CollectionLedger } from '../src/collection-ledger.js';
import {
  dispatchMessagingReadTool,
  type MessagingCollectionPort,
} from '../src/messaging-tool-dispatch.js';

const NOW = 1_800_000_000_000;
const CONTEXT: InvocationContext = {
  temporal: {
    instant: new Date(NOW).toISOString(),
    localDate: '2027-01-15',
    localTime: '08:00:00',
    utcOffset: '+00:00',
    weekday: 'Friday',
    timeZone: 'UTC',
    locale: 'en-US',
    source: { locale: 'platform-default', timeZone: 'platform-default' },
  },
  ambientStatus: 'not_configured',
};
const brief = {
  type: 'object',
  properties: { workflow: { type: 'string' }, policy: { type: 'string' } },
  required: ['workflow'],
  additionalProperties: false,
};
const enquiry = {
  type: 'object',
  properties: {
    workflow: { type: 'string' },
    fullName: { type: 'string', title: 'Your name' },
    workEmail: { type: 'string', format: 'email', title: 'Work email' },
    consentToContact: { type: 'boolean', const: true },
  },
  required: ['workflow', 'fullName', 'workEmail', 'consentToContact'],
  additionalProperties: false,
};
const manifest = {
  manifestVersion: '2',
  server: {
    name: 'acme_site',
    title: 'Acme Site',
    version: '1.0.0',
    assistant: {
      model: { kind: 'noodle-managed' },
      allowedOrigins: [],
      surfaces: [
        {
          kind: 'messaging',
          channel: 'whatsapp',
          mode: 'public',
          capabilities: [
            { kind: 'tool', name: 'open_contact_form' },
            { kind: 'tool', name: 'submit_enquiry' },
            { kind: 'tool', name: 'health' },
          ],
        },
      ],
    },
  },
  connectors: { records: { id: 'noodle_records', version: '1.0.0' } },
  widgets: [{ name: 'contact_widget', tool: 'open_contact_form', html: '<main/>' }],
  tools: [
    {
      name: 'open_contact_form',
      description: 'Opener.',
      inputSchema: brief,
      outputSchema: brief,
      annotations: { readOnlyHint: true },
      fulfilment: {
        steps: [],
        output: { workflow: '${input.workflow}', policy: 'The form below is ready.' },
      },
      interaction: {
        kind: 'collect',
        action: 'submit_enquiry',
        initialValues: { workflow: { fromOutput: 'workflow' } },
        fields: [
          { key: 'fullName', control: 'text' },
          { key: 'workEmail', control: 'email', private: true },
          { key: 'consentToContact', control: 'consent' },
        ],
        review: 'all',
        outcome: { success: 'Saved.' },
      },
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
      name: 'health',
      description: 'Pure read.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      fulfilment: { steps: [], output: { ok: true } },
    },
    {
      name: 'bare_write',
      description: 'Write without an interaction.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false, confirm: true },
      fulfilment: { steps: [], output: { ok: true } },
    },
  ],
};

function compiled(): RuntimeArtifact {
  const result = compileManifest(manifest, {
    catalog: new InMemoryCatalog([BUILTIN_RECORD_CATALOG_CONNECTOR]),
  });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.artifact;
}
const session: MessagingTurnContext = {
  kind: 'messaging',
  channel: 'whatsapp',
  id: 'evt_1',
  bindingId: 'wa_1',
  participantId: 'p_1',
  tenant: { org: 'acme', app: 'site', env: 'prod' },
  deploymentId: 'dep_1',
  caller: { identityKind: 'anonymous', subject: 'p_1', roles: [], scopes: [] },
  history: [],
  modelToolUses: [],
};
const deps: ExecuteDeps = {
  connectors: new InMemoryConnectorRegistry([]),
  broker: { getCredential: async () => ({ token: '' }) },
};
function port(open?: CollectionLedger) {
  const saved: CollectionLedger[] = [];
  const collection: MessagingCollectionPort = {
    open,
    now: NOW,
    retentionMs: 86_400_000,
    confirmationExpiryMs: 600_000,
    save: async (ledger) => {
      saved.push(ledger);
    },
  };
  return { collection, saved };
}
async function dispatch(name: string, collection?: MessagingCollectionPort, args: unknown = {}) {
  const artifact = compiled();
  const tool = artifact.tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(name);
  return dispatchMessagingReadTool({
    artifact,
    tool,
    arguments: args,
    executeDeps: deps,
    context: CONTEXT,
    session,
    claimTool: async () => true,
    ...(collection === undefined ? {} : { collection }),
  });
}

describe('messaging tool dispatch (gate D)', () => {
  it('opens a seeded collection for a collect opener and shows the model only the ledger view', async () => {
    const { collection, saved } = port();
    const result = await dispatch('open_contact_form', collection, {
      workflow: 'Answer questions on WhatsApp',
    });
    expect(result.kind).toBe('tool_result');
    if (result.kind !== 'tool_result') return;
    expect(result.output).toMatchObject({
      collection: 'opened',
      phase: 'collecting',
      pendingProposal: false,
      fields: [
        { key: 'fullName', title: 'Your name', status: 'missing' },
        { key: 'workEmail', title: 'Work email', status: 'missing' },
      ],
      values: {},
    });
    expect(JSON.stringify(result.output)).not.toContain('form below');
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      bindingId: 'wa_1',
      participantId: 'p_1',
      interactionId: 'open_contact_form',
      action: 'submit_enquiry',
      phase: 'collecting',
      values: { workflow: 'Answer questions on WhatsApp' },
    });
  });

  it('returns the current view instead of opening a second collection', async () => {
    const first = port();
    await dispatch('open_contact_form', first.collection, { workflow: 'Answer questions' });
    const second = port(first.saved[0]);
    const result = await dispatch('open_contact_form', second.collection, { workflow: 'Again' });
    expect(result).toMatchObject({ kind: 'tool_result', output: { collection: 'already_open' } });
    expect(second.saved).toHaveLength(0);
  });

  it('still denies the confirmed action, bare writes, and a widget opener without collection support', async () => {
    const { collection } = port();
    for (const name of ['submit_enquiry', 'bare_write']) {
      expect(await dispatch(name, collection)).toMatchObject({
        kind: 'event',
        event: 'error',
        data: { code: 'messaging_action_unsupported' },
      });
    }
    expect(await dispatch('open_contact_form', undefined, { workflow: 'x' })).toMatchObject({
      kind: 'event',
      event: 'error',
      data: { code: 'messaging_action_unsupported' },
    });
  });

  it('runs an ordinary read exactly as before', async () => {
    expect(await dispatch('health', port().collection)).toEqual({
      kind: 'tool_result',
      output: { ok: true },
    });
  });
});
