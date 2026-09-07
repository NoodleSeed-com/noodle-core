import { describe, expect, it } from 'vitest';
import { managedCollection, server, tool, z } from '../src/index.js';

describe('managed collection authoring', () => {
  it('projects a Zod record schema into the canonical Core v2 manifest', async () => {
    const requests = managedCollection('service_requests', {
      title: 'Service requests',
      description: 'Customer requests that the business can review and resolve.',
      schemaVersion: 1,
      record: z.object({
        workspaceReference: z.string().min(1).max(120),
        category: z.enum(['question', 'change']),
        summary: z.string().min(1).max(1000),
      }),
    });
    const app = server(
      'customer_service',
      {
        title: 'Customer service',
        version: '1.0.0',
        collections: [requests],
      },
      [
        tool('health', {
          description: 'Return service health.',
          input: z.object({}),
          output: z.object({ ok: z.boolean() }),
          fulfil: () => ({ ok: true }),
        }),
      ],
    );

    await expect(app.toManifest()).resolves.toMatchObject({
      manifestVersion: '2',
      server: {
        collections: [
          {
            name: 'service_requests',
            title: 'Service requests',
            description: 'Customer requests that the business can review and resolve.',
            schemaVersion: 1,
            recordSchema: {
              type: 'object',
              required: ['workspaceReference', 'category', 'summary'],
              additionalProperties: false,
            },
          },
        ],
      },
    });
  });
});
