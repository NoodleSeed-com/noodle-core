/**
 * Golden fixture (ADR 0150): the headless authoring surface — a declared connector, an HTTP
 * connector with a `secret()` credential slot, a `variable()` managed config ref, a flow tool, a
 * resource, and a prompt. Its emitted manifest is pinned in `headless-orders.manifest.json` and its
 * connector catalog in `headless-orders.connectors.json`.
 */
import {
  connector,
  prompt,
  resource,
  secret,
  server,
  tool,
  variable,
  z,
} from '../../../src/index.js';

const acme = connector('acme_orders')
  .version('1.2.0')
  .operation('get_order', {
    type: 'read',
    input: z.object({ id: z.string(), region: z.string().optional() }),
    output: z.object({ id: z.string(), status: z.string() }),
  })
  .operation('get_tracking', {
    type: 'read',
    input: z.object({ order_id: z.string() }),
    output: z.object({ url: z.string().optional() }),
  });

const statusApi = connector('status_api')
  .version('1.0.0')
  .http({
    baseUrl: 'https://status.acme.example',
    allowedOrigins: ['https://status.acme.example'],
    auth: { kind: 'bearer', secret: secret('STATUS_API_TOKEN') },
    operations: {
      ping: {
        type: 'read',
        method: 'GET',
        path: '/ping',
        output: z.object({ ok: z.boolean().optional() }),
        response: { ok: true },
      },
    },
  });

export default server(
  'acme_support',
  { title: 'Acme Support', version: '1.0.0', use: { acme, status: statusApi } },
  [
    tool('track_order', {
      description: 'Look up an order and fetch its tracking link.',
      input: z.object({ order_id: z.string() }),
      output: z.object({ status: z.string(), url: z.string().optional() }),
      fulfil({ input, connectors }) {
        const order = connectors.acme.getOrder({ id: input.order_id, region: variable('REGION') });
        const tracking = connectors.acme.getTracking({ order_id: input.order_id });
        return { status: order.status, url: tracking.url };
      },
    }),
    tool('service_status', {
      description: 'Check the upstream status endpoint.',
      input: z.object({}),
      output: z.object({ ok: z.boolean().optional() }),
      fulfil({ connectors }) {
        const status = connectors.status.ping({});
        return { ok: status.ok };
      },
    }),
    resource('support_hours', {
      uri: 'doc://acme/support-hours',
      description: 'Support hours document.',
      mimeType: 'text/plain',
      fulfil: () => 'Mon-Fri 9:00-17:00 UTC',
    }),
    prompt('escalation', {
      description: 'Draft an escalation summary.',
      arguments: z.object({ order_id: z.string() }),
      fulfil: ({ input }) => `Escalate order ${input.order_id} to tier two.`,
    }),
  ],
);
