import { afterEach, describe, expect, it } from 'vitest';
import { createDualEraMcpHandler } from '../src/v2/handler.js';
import { goldenTarget } from './golden-target.js';
import { legacyRpc, modernRpc } from './v2-harness.js';

const handlers: Array<ReturnType<typeof createDualEraMcpHandler>> = [];

function handler(authenticated = false) {
  const target = goldenTarget();
  target.artifact = {
    ...target.artifact,
    resources: [
      ...(target.artifact.resources ?? []),
      {
        name: 'order',
        uri: 'orders://{id}',
        isTemplate: true,
        mimeType: 'application/json',
        fulfilment: { kind: 'value', value: { id: '${variables.id}' } },
      },
    ],
  };
  const value = createDualEraMcpHandler(target, {
    ...(authenticated ? { caller: { subject: 'user_123', scopes: ['orders.read'] } } : {}),
  });
  handlers.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(handlers.splice(0).map((item) => item.close()));
});

const operations = [
  ['server/discover', {}],
  ['tools/list', {}],
  ['prompts/list', {}],
  ['resources/list', {}],
  ['resources/templates/list', {}],
  ['resources/read', { uri: 'ui://golden_server/ticket_card' }],
] as const;

describe('modern cache hints', () => {
  it.each(
    operations,
  )('adds required hints to %s only in the modern era', async (method, params) => {
    const target = handler();
    const modern = await modernRpc(target, method, params, {
      ...(method === 'resources/read' ? { nameHeader: 'ui://golden_server/ticket_card' } : {}),
    });
    expect(modern.json).toMatchObject({
      result: {
        resultType: 'complete',
        ttlMs: 0,
        cacheScope: 'private',
      },
    });

    const legacy = await legacyRpc(target, method, params);
    if (method === 'server/discover') {
      expect(legacy.json).toMatchObject({ error: { code: -32601 } });
    } else {
      expect(legacy.json).toHaveProperty('result');
    }
    expect(legacy.text).not.toContain('resultType');
    expect(legacy.text).not.toContain('ttlMs');
    expect(legacy.text).not.toContain('cacheScope');
  });

  it('keeps authorization-varying results private and immediately stale', async () => {
    const target = handler(true);
    const listed = await modernRpc(target, 'tools/list');
    expect(listed.json).toMatchObject({
      result: { ttlMs: 0, cacheScope: 'private' },
    });
  });
});
