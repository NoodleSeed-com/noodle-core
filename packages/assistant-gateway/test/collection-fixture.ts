import { vi } from 'vitest';
import type { CollectionLedger, CollectionSpec } from '../src/collection-ledger.js';
import { openCollection } from '../src/collection-ledger.js';
import type { AssistantModelMessage, ResolvedAssistantModel } from '../src/model-request.js';

/** The lead packet the WhatsApp slice collects; one field per typed control keeps parsers unambiguous. */
export const leadSpec: CollectionSpec = {
  interactionId: 'start_lead',
  action: 'save_lead',
  fields: [
    { key: 'name', title: 'Name', control: 'text', schema: { type: 'string', minLength: 1 } },
    {
      key: 'email',
      title: 'Work email',
      control: 'email',
      private: true,
      schema: { type: 'string', minLength: 3, maxLength: 254 },
    },
    { key: 'company', title: 'Company', control: 'text', schema: { type: 'string', minLength: 1 } },
    {
      key: 'website',
      title: 'Website',
      control: 'url',
      optional: true,
      schema: { type: 'string' },
    },
    {
      key: 'size',
      title: 'Team size',
      control: 'select',
      optional: true,
      options: ['1-10', '11-50', '51+'],
      schema: { type: 'string', enum: ['1-10', '11-50', '51+'] },
    },
    {
      key: 'workflow',
      title: 'Request',
      control: 'textarea',
      schema: { type: 'string', minLength: 1, maxLength: 2000 },
    },
    {
      key: 'consent',
      title: 'Contact permission',
      control: 'consent',
      schema: { type: 'boolean' },
    },
  ],
  consentQuestion: 'Do you agree to Noodle Seed contacting you about this request? Yes or no.',
  successMessage: 'Your enquiry was saved.',
  confirmationExpiryMs: 600_000,
};

export const NOW = 1_800_000_000_000;

export const binding: ResolvedAssistantModel = {
  source: 'operator',
  baseUrl: 'https://models.example/v1',
  model: 'assistant-model',
  apiKey: 'operator-secret',
};

export function openLead(now = NOW): CollectionLedger {
  return openCollection(leadSpec, { id: 'col_1', bindingId: 'wa_1', participantId: 'p_1', now });
}

/** Deterministic provider: one canned JSON reply per call, every request body recorded for inspection. */
export function jsonFetcher(replies: readonly unknown[]) {
  const requests: { messages: AssistantModelMessage[]; body: Record<string, unknown> }[] = [];
  let index = 0;
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    requests.push({ messages: body.messages as AssistantModelMessage[], body });
    const reply = replies[index++];
    const content = typeof reply === 'string' ? reply : JSON.stringify(reply);
    return Response.json({ choices: [{ message: { role: 'assistant', content } }] });
  });
  return { fetcher, requests };
}

export function messageText(requests: { messages: AssistantModelMessage[] }[]): string {
  return JSON.stringify(requests.map((request) => request.messages));
}
