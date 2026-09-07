import { compileManifest, InMemoryCatalog, type Manifest } from '@noodle-borg/compiler';
import type { ServedArtifact } from '../src/index.js';
import { buildDeps } from './harness.js';

export const goldenManifest: Manifest = {
  manifestVersion: '1',
  server: {
    name: 'golden_server',
    title: 'Golden Server',
    version: '1.2.3',
    instructions: 'Use the golden tools exactly as described.',
  },
  tools: [
    {
      name: 'open_ticket',
      title: 'Open ticket',
      description: 'Open a support ticket.',
      inputSchema: {
        type: 'object',
        properties: { subject: { type: 'string' } },
        required: ['subject'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: { ticket: { type: 'string' } },
        required: ['ticket'],
        additionalProperties: false,
      },
      fulfilment: { steps: [], output: { ticket: 'T-100' } },
    },
    {
      name: 'choose_team',
      description: 'Choose the team for a request.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      fulfilment: {
        steps: [
          {
            id: 'team',
            elicit: {
              message: 'Which team?',
              requestedSchema: {
                type: 'object',
                properties: { team: { type: 'string', enum: ['support', 'platform'] } },
                required: ['team'],
              },
            },
          },
        ],
        output: { team: '${steps.team.team}' },
      },
    },
  ],
  prompts: [
    {
      name: 'triage',
      description: 'Triage a ticket.',
      arguments: [{ name: 'id', description: 'Ticket id', required: true }],
      fulfilment: { steps: [], output: { value: 'Triage ticket ${input.id}' } },
    },
  ],
  widgets: [
    {
      name: 'ticket_card',
      tool: 'open_ticket',
      title: 'Ticket card',
      description: 'Shows the opened ticket.',
      html: '<!doctype html><main data-bind="ticket">Ticket</main>',
      csp: { connectDomains: ['https://api.example.com'] },
      permissions: { clipboardWrite: {} },
    },
  ],
};

export function goldenTarget(options: { restricted?: boolean } = {}): ServedArtifact {
  const compiled = compileManifest(goldenManifest, { catalog: new InMemoryCatalog([]) });
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
  return {
    artifact: options.restricted
      ? {
          ...compiled.artifact,
          tools: compiled.artifact.tools.map((tool) =>
            tool.name === 'open_ticket'
              ? { ...tool, authorization: { requiredScopes: ['tickets.write'] } }
              : tool,
          ),
        }
      : compiled.artifact,
    deps: buildDeps(),
  };
}
