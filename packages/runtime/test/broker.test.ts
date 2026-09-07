import { describe, expect, it } from 'vitest';
import type { DownstreamCredential } from '../src/index.js';
import { CredentialUnavailableError, MapServiceBroker } from '../src/index.js';

const req = (connectorId: string, operation: string) => ({
  connectorId,
  connectorVersion: '1.0.0',
  operation,
});

describe('MapServiceBroker', () => {
  it('resolves an exact (connectorId, operation) entry', async () => {
    const entries = new Map<string, DownstreamCredential>([
      [MapServiceBroker.key('api', 'get'), { token: 'op-token' }],
    ]);
    const broker = new MapServiceBroker(entries);
    expect(await broker.getCredential(req('api', 'get'))).toEqual({ token: 'op-token' });
  });

  it('falls back to the connector-level default for an op without its own entry', async () => {
    const entries = new Map<string, DownstreamCredential>([
      [MapServiceBroker.key('api'), { token: 'default-token' }],
    ]);
    const broker = new MapServiceBroker(entries);
    expect(await broker.getCredential(req('api', 'anything'))).toEqual({ token: 'default-token' });
  });

  it('prefers the exact entry over the connector-level default', async () => {
    const entries = new Map<string, DownstreamCredential>([
      [MapServiceBroker.key('api'), { token: 'default-token' }],
      [MapServiceBroker.key('api', 'get'), { token: 'op-token' }],
    ]);
    const broker = new MapServiceBroker(entries);
    expect(await broker.getCredential(req('api', 'get'))).toEqual({ token: 'op-token' });
    expect(await broker.getCredential(req('api', 'other'))).toEqual({ token: 'default-token' });
  });

  it('returns the empty-token fallback for an unbound operation (preserves public-API behavior)', async () => {
    const broker = new MapServiceBroker(new Map());
    expect(await broker.getCredential(req('api', 'get'))).toEqual({ token: '' });
  });

  it('honors a custom fallback credential', async () => {
    const broker = new MapServiceBroker(new Map(), { token: 'fb' });
    expect(await broker.getCredential(req('api', 'get'))).toEqual({ token: 'fb' });
  });

  it('isolates two brokers — one tenant never sees the other tenant token', async () => {
    const a = new MapServiceBroker(
      new Map([[MapServiceBroker.key('api', 'get'), { token: 'tenant-a' }]]),
    );
    const b = new MapServiceBroker(
      new Map([[MapServiceBroker.key('api', 'get'), { token: 'tenant-b' }]]),
    );
    expect(await a.getCredential(req('api', 'get'))).toEqual({ token: 'tenant-a' });
    expect(await b.getCredential(req('api', 'get'))).toEqual({ token: 'tenant-b' });
  });

  it('uses a custom fallback only for unbound ops, the entry for bound ops', async () => {
    const broker = new MapServiceBroker(
      new Map([[MapServiceBroker.key('api', 'get'), { token: 'bound' }]]),
      { token: 'fb' },
    );
    expect(await broker.getCredential(req('api', 'get'))).toEqual({ token: 'bound' });
    expect(await broker.getCredential(req('api', 'other'))).toEqual({ token: 'fb' });
    expect(await broker.getCredential(req('elsewhere', 'x'))).toEqual({ token: 'fb' });
  });

  it('resolves a connector-level secret shared by multiple operations', async () => {
    const broker = new MapServiceBroker(
      new Map([[MapServiceBroker.key('api'), { token: 'shared' }]]),
    );
    for (const op of ['list', 'get', 'create']) {
      expect(await broker.getCredential(req('api', op))).toEqual({ token: 'shared' });
    }
  });

  it('produces distinct keys for distinct (connectorId, operation) pairs', () => {
    // The separator must keep "a"+"b.c" distinct from "a.b"+"c" etc. — no collisions for normal ids.
    const keys = new Set([
      MapServiceBroker.key('a', 'b'),
      MapServiceBroker.key('ab', ''),
      MapServiceBroker.key('a'),
      MapServiceBroker.key('a', ''),
      MapServiceBroker.key('', 'a'),
    ]);
    expect(keys.size).toBe(5);
  });

  it('uses collision-proof canonical keys for adversarial separator-bearing fields', () => {
    expect(MapServiceBroker.key('a\u0000b', 'c')).not.toBe(MapServiceBroker.key('a', 'b\u0000c'));
    const base = {
      ...req('mail', 'search'),
      bindingId: 'a\u0000b',
      connectionId: 'c\u001fd',
      connectionConfigRevision: 'sha256:r',
      profile: 'delegated',
      presentation: { kind: 'bearer' } as const,
      requiredScopes: ['scope\u0000one', 'scope\u001ftwo'],
    };
    expect(MapServiceBroker.bindingKey(base)).not.toBe(
      MapServiceBroker.bindingKey({
        ...base,
        bindingId: 'a',
        connectionId: 'b\u0000c\u001fd',
      }),
    );
    expect(MapServiceBroker.bindingKey(base)).toBe(
      MapServiceBroker.bindingKey({
        ...base,
        requiredScopes: ['scope\u001ftwo', 'scope\u0000one'],
      }),
    );
  });

  it('resolves binding-scoped credentials only by the complete exact binding request', async () => {
    const personal = {
      ...req('mail', 'search'),
      bindingId: 'personal',
      connectionId: 'personal_mail',
      connectionConfigRevision: 'sha256:personal',
      profile: 'delegated',
      presentation: { kind: 'bearer' } as const,
      requiredScopes: ['mail.read'],
      requiredAudience: 'https://mail.example.com',
    };
    const work = {
      ...personal,
      bindingId: 'work',
      connectionId: 'work_mail',
      connectionConfigRevision: 'sha256:work',
    };
    const broker = new MapServiceBroker(
      new Map([
        [MapServiceBroker.bindingKey(personal), { token: 'personal-token' }],
        [MapServiceBroker.bindingKey(work), { token: 'work-token' }],
        [MapServiceBroker.key('mail', 'search'), { token: 'legacy-operation-token' }],
        [MapServiceBroker.key('mail'), { token: 'legacy-default-token' }],
      ]),
      { token: 'fallback-token' },
    );
    await expect(broker.getCredential(personal)).resolves.toEqual({ token: 'personal-token' });
    await expect(broker.getCredential(work)).resolves.toEqual({ token: 'work-token' });
    await expect(
      broker.getCredential({ ...personal, connectionConfigRevision: 'sha256:drifted' }),
    ).rejects.toBeInstanceOf(CredentialUnavailableError);
  });

  it('never falls back to connector, default, or empty credentials for a new binding', async () => {
    const request = {
      ...req('mail', 'search'),
      bindingId: 'personal',
      connectionId: 'personal_mail',
      connectionConfigRevision: 'sha256:personal',
      profile: 'delegated',
      presentation: { kind: 'bearer' } as const,
      requiredScopes: ['mail.read'],
    };
    for (const broker of [
      new MapServiceBroker(new Map()),
      new MapServiceBroker(new Map([[MapServiceBroker.key('mail'), { token: 'connector' }]])),
      new MapServiceBroker(new Map(), { token: 'fallback' }),
    ]) {
      await expect(broker.getCredential(request)).rejects.toMatchObject({
        reason: 'credential_not_configured',
      });
    }
  });

  it('rejects a partial binding descriptor instead of falling back to legacy credentials', async () => {
    const complete = {
      ...req('mail', 'search'),
      bindingId: 'personal',
      connectionId: 'personal_mail',
      connectionConfigRevision: 'sha256:personal',
      profile: 'delegated',
      presentation: { kind: 'bearer' } as const,
      requiredScopes: ['mail.read'],
    };
    const { bindingId: _bindingId, ...partial } = complete;
    const broker = new MapServiceBroker(
      new Map([
        [MapServiceBroker.key('mail', 'search'), { token: 'legacy-operation-token' }],
        [MapServiceBroker.key('mail'), { token: 'legacy-default-token' }],
      ]),
      { token: 'fallback-token' },
    );

    await expect(broker.getCredential(partial)).rejects.toMatchObject({
      reason: 'credential_not_configured',
    });
  });
});
