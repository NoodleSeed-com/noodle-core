import { describe, expect, it, vi } from 'vitest';
import { type AssistantViewAvailableDetail, createAssistantClient } from '../src/client.js';

function session(): Response {
  return Response.json({
    token: 'session-token',
    expiresAt: '2030-01-01T00:00:00Z',
    endpoints: {
      turns: 'https://cloud.example/v1/assistant/turns',
      toolConfirmations: 'https://cloud.example/v1/assistant/tool-confirmations',
      interactions: 'https://cloud.example/v1/assistant/interactions',
    },
  });
}

describe('headless assistant view availability', () => {
  it('narrows view_available to a safe typed renderer event', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(session())
      .mockResolvedValueOnce(
        new Response(
          'event: view_available\ndata: {"id":"call_1","tool":"open_order","resourceUri":"ui://orders/order_card","title":"Order","result":{"orderId":"order_1"}}\n\nevent: done\ndata: {}\n\n',
        ),
      );
    const views: AssistantViewAvailableDetail[] = [];
    const client = createAssistantClient({
      sessionEndpoint: '/api/assistant/session',
      fetch: fetchMock,
    });
    client.subscribe((event) => {
      if (event.event === 'view_available') views.push(event.data);
    });

    await client.sendMessage('Open my order');

    expect(views).toEqual([
      {
        id: 'call_1',
        tool: 'open_order',
        resourceUri: 'ui://orders/order_card',
        title: 'Order',
        result: { orderId: 'order_1' },
      },
    ]);
  });

  it('does not surface an unsafe view URI as a renderable event', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(session())
      .mockResolvedValueOnce(
        new Response(
          'event: view_available\ndata: {"id":"call_1","tool":"open_order","resourceUri":"https://evil.example/widget","result":{}}\n\nevent: done\ndata: {}\n\n',
        ),
      );
    const names: string[] = [];
    const client = createAssistantClient({
      sessionEndpoint: '/api/assistant/session',
      fetch: fetchMock,
    });
    client.subscribe((event) => names.push(event.event));

    await client.sendMessage('Open my order');

    expect(names).not.toContain('view_available');
    expect(names).toContain('unrecognized');
  });
});
