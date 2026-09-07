import { describe, expect, it } from 'vitest';
import { InMemoryAssistantStore } from '../src/assistant-store.js';

describe('assistant conversation history window', () => {
  it('retains the latest forty messages so a beta conversation can use its full turn budget', async () => {
    const store = new InMemoryAssistantStore();
    const now = new Date('2030-01-01T00:00:00.000Z');
    const created = await store.createSession({
      clientId: 'client_1',
      tenant: { org: 'acme', app: 'support', env: 'prod' },
      deploymentId: 'dep_1',
      origin: 'https://www.acme.test',
      caller: { subject: 'anon_1', identityKind: 'anonymous' },
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      absoluteExpiresAt: new Date(now.getTime() + 120_000).toISOString(),
    });
    await store.appendHistory(
      created.session.id,
      Array.from({ length: 45 }, (_, index) => ({
        role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
        content: `message-${index}`,
      })),
    );

    const session = await store.getSession(created.token, now);
    expect(session?.history).toHaveLength(40);
    expect(session?.history[0]?.content).toBe('message-5');
    expect(session?.history.at(-1)?.content).toBe('message-44');
  });
});
