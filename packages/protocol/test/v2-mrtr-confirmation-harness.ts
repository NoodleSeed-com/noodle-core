import { compileManifest, InMemoryCatalog } from '@noodle-borg/compiler';
import {
  InMemoryConnector,
  InMemoryConnectorRegistry,
  StaticServiceBroker,
} from '@noodle-borg/runtime';
import type { ProtocolObservation } from '../src/observation.js';
import {
  type ConfirmationNonceLedger,
  RequestStateManager,
  requestStateSecretBox,
} from '../src/request-state.js';
import { createDualEraMcpHandler } from '../src/v2/handler.js';

const confirmationSignature = {
  type: 'action' as const,
  input: {
    type: 'object' as const,
    properties: {
      days: { type: 'number' as const },
      reason: { type: 'string' as const },
    },
    required: ['days', 'reason'],
    additionalProperties: false,
  },
  output: {
    type: 'object' as const,
    properties: { requestId: { type: 'string' as const } },
    required: ['requestId'],
    additionalProperties: false,
  },
};

const openPayloadSignature = {
  type: 'action' as const,
  input: {
    type: 'object' as const,
    properties: { payload: { type: 'object' as const } },
    required: ['payload'],
    additionalProperties: false,
  },
  output: confirmationSignature.output,
};

export class TestConfirmationLedger implements ConfirmationNonceLedger {
  readonly consumed = new Set<string>();
  available = true;

  async consume(nonce: string): Promise<boolean> {
    if (!this.available) throw new Error('ledger unavailable');
    if (this.consumed.has(nonce)) return false;
    this.consumed.add(nonce);
    return true;
  }
}

export function setupConfirmationApp(
  ledger: ConfirmationNonceLedger | undefined,
  options: {
    readonly elicit?: boolean;
    readonly confirmationFallback?: 'host';
    readonly openActionPayload?: boolean;
  } = {},
) {
  let calls = 0;
  const observations: ProtocolObservation[] = [];
  const signature = options.openActionPayload ? openPayloadSignature : confirmationSignature;
  const compiled = compileManifest(
    {
      manifestVersion: '1',
      server: {
        name: 'confirmation',
        title: 'Confirmation',
        version: '1.0.0',
        ...(options.confirmationFallback === undefined
          ? {}
          : { interactions: { confirmationFallback: options.confirmationFallback } }),
      },
      connectors: { actions: { id: 'actions', version: '1.0.0' } },
      tools: [
        {
          name: 'book_leave',
          description: 'Book the requested leave.',
          annotations: { confirm: true },
          inputSchema: {
            type: 'object',
            properties: {
              days: { type: 'number' },
              ...(options.elicit ? {} : { reason: { type: 'string' } }),
              apiToken: { type: 'string', 'x-sensitive': true },
            },
            required: options.elicit ? ['days'] : ['days', 'reason'],
            additionalProperties: false,
          },
          fulfilment: options.elicit
            ? {
                steps: [
                  {
                    id: 'reason',
                    elicit: {
                      message: 'Why are you taking leave?',
                      requestedSchema: {
                        type: 'object',
                        properties: { reason: { type: 'string' } },
                        required: ['reason'],
                      },
                    },
                  },
                  {
                    id: 'submit',
                    use: 'actions.submit',
                    args: {
                      days: '${input.days}',
                      reason: '${steps.reason.reason}',
                    },
                  },
                ],
                output: { requestId: '${steps.submit.requestId}' },
              }
            : options.openActionPayload
              ? {
                  use: 'actions.submit',
                  args: { payload: { lastReference: '${input.reason}' } },
                }
              : {
                  use: 'actions.submit',
                  args: { days: '${input.days}', reason: '${input.reason}' },
                },
        },
      ],
    },
    {
      catalog: new InMemoryCatalog([
        {
          id: 'actions',
          version: '1.0.0',
          kind: 'catalog',
          operations: { submit: signature },
        },
      ]),
    },
  );
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
  const connector = new InMemoryConnector('actions', '1.0.0', {
    submit: {
      signature,
      handler: () => {
        calls += 1;
        return { requestId: `request-${calls}` };
      },
    },
  });
  const requestState = new RequestStateManager(requestStateSecretBox(Buffer.alloc(32, 8)));
  const handler = createDualEraMcpHandler(
    {
      artifact: compiled.artifact,
      deps: {
        connectors: new InMemoryConnectorRegistry([connector]),
        broker: new StaticServiceBroker({ token: 'service-token' }),
      },
    },
    {
      deploymentId: 'dep_confirmation',
      requestState,
      ...(ledger === undefined ? {} : { confirmationNonceLedger: ledger }),
      observe: (observation) => observations.push(observation),
    },
  );
  return { handler, calls: () => calls, observations, requestState };
}
