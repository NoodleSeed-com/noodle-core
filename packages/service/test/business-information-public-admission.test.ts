import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  type AtomicCounterAttemptOutcome,
  type CounterRequest,
  clientAddressBucket,
  InMemoryDailyCounterStore,
} from '@noodle-borg/admission-limits/portable';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryBusinessInformationStore } from '../src/business-information/portable.js';
import {
  createServiceHandler,
  InMemoryArtifactStore,
  InMemoryControlPlaneStore,
  ServerRegistry,
  type ServiceOptions,
} from '../src/index.js';
import { activateRecordFixture } from './business-information-test-application.js';

class ObservedCounters extends InMemoryDailyCounterStore {
  readonly batches: Array<readonly CounterRequest[]> = [];

  override async consumeAllOnce(
    requests: readonly CounterRequest[],
    attempt: { readonly key: string; readonly fingerprint: string },
    now: Date,
  ): Promise<AtomicCounterAttemptOutcome> {
    this.batches.push(requests);
    return super.consumeAllOnce(requests, attempt, now);
  }
}

let http: Server;
let base: string;
let publicId: string;
let installationId: string;
let businessStore: InMemoryBusinessInformationStore;
let controlPlane: InMemoryControlPlaneStore;
let counters: ObservedCounters;
let registry: ServerRegistry;

const gate = {
  authorize: () =>
    Promise.resolve({
      ok: true as const,
      identity: { subject: 'owner-sub', email: 'owner@example.test', superAdmin: false },
    }),
};

async function start(overrides: Partial<ServiceOptions> = {}): Promise<void> {
  http = createServer(
    createServiceHandler(registry, {
      controlPlaneStore: controlPlane,
      deployGate: gate,
      businessInformationStore: businessStore,
      admissionCounters: counters,
      ...overrides,
    }),
  );
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
}

async function install(app = 'travel-desk'): Promise<{ publicId: string; installationId: string }> {
  const result = await businessStore.createInstallation({
    scope: { org: 'acme', app, env: 'prod', installationId: `${app}-prod` },
    profileKey: 'travel',
    managedCollections: ['travel_requests'],
    retentionDays: 30,
    actorSubject: 'owner-sub',
    actorEmail: 'owner@example.test',
  });
  if (result.disposition === 'conflict') throw new Error('installation conflict');
  await activateRecordFixture(registry, businessStore, result.installation.scope);
  return {
    publicId: result.installation.publicId,
    installationId: result.installation.scope.installationId,
  };
}

function intakeUrl(id = publicId): string {
  return `${base}/v1/solution-intake/${id}/travel_requests/records`;
}

function submit(
  key: string,
  summary: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(intakeUrl(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': key,
      ...headers,
    },
    body: JSON.stringify({ payload: { request_type: 'service', summary } }),
  });
}

beforeEach(async () => {
  counters = new ObservedCounters();
  registry = new ServerRegistry(new InMemoryArtifactStore());
  businessStore = new InMemoryBusinessInformationStore();
  controlPlane = new InMemoryControlPlaneStore();
  await controlPlane.createOrg({ slug: 'acme' });
  ({ publicId, installationId } = await install());
  await start();
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    http.close((error) => (error ? reject(error) : resolve())),
  );
});

describe('public business-information admission', () => {
  it('recovers a committed idempotent record after day rollover and admission-receipt pruning', async () => {
    await new Promise<void>((resolve, reject) =>
      http.close((error) => (error ? reject(error) : resolve())),
    );
    let clock = new Date('2030-03-01T09:00:00Z');
    await start({ clock: () => clock });

    const first = await submit('stable-receipt', 'Keep this receipt');
    expect(first.status).toBe(201);
    const receipt = await first.json();
    const address = clientAddressBucket('127.0.0.1');
    if (!address) throw new Error('loopback address did not produce a bucket');
    clock = new Date('2030-03-04T09:00:00Z');
    expect(await counters.prune(clock)).toBeGreaterThan(0);
    await counters.consume(
      {
        key: `solution-intake:network:hour:${publicId}:${address}`,
        limit: 6_000,
        amount: 6_000,
        window: 'hour',
      },
      clock,
    );
    await counters.consume(
      { key: `solution-intake:surface:${publicId}`, limit: 10_000, amount: 10_000 },
      clock,
    );

    const batchesBeforeReplay = counters.batches.length;
    const replay = await submit('stable-receipt', 'Keep this receipt');
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toEqual(receipt);
    expect(counters.batches).toHaveLength(batchesBeforeReplay);
    expect((await submit('new-after-limit', 'Must be refused')).status).toBe(429);
  });

  it('fails closed safely when the shared counter authority is unavailable', async () => {
    await new Promise<void>((resolve, reject) =>
      http.close((error) => (error ? reject(error) : resolve())),
    );
    const unavailable = new ObservedCounters();
    unavailable.consumeAllOnce = () =>
      Promise.reject(new Error('counter database password leaked'));
    counters = unavailable;
    await start();

    const response = await submit('counter-failure', 'Do not accept this');
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'public intake admission is temporarily unavailable',
      code: 'admission_unavailable',
    });
    await expect(
      businessStore.listRequests({
        scope: { org: 'acme', app: 'travel-desk', env: 'prod', installationId },
        collectionKey: 'travel_requests',
      }),
    ).resolves.toMatchObject({ records: [] });
  });

  it('atomically consumes address and installation fairness without trusting forged forwarding headers', async () => {
    await new Promise<void>((resolve, reject) =>
      http.close((error) => (error ? reject(error) : resolve())),
    );
    await start({ tls: { trustProxy: true } });
    const response = await submit('anti-spoof', 'Use the socket peer', {
      'x-forwarded-for': '203.0.113.77',
      'x-forwarded-proto': 'https',
    });
    expect(response.status).toBe(201);
    expect(counters.batches).toHaveLength(1);
    const keys = counters.batches[0]?.map(({ key }) => key) ?? [];
    expect(keys).toContain(`solution-intake:surface:${publicId}`);
    expect(keys).toContain(
      `solution-intake:network:hour:${publicId}:${clientAddressBucket('127.0.0.1')}`,
    );
    expect(keys.join('\n')).not.toContain(String(clientAddressBucket('203.0.113.77')));
  });

  it('does not spend admission for malformed, oversized, nested, or prohibited input', async () => {
    const missingKey = await fetch(intakeUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: { request_type: 'service', summary: 'Missing key' } }),
    });
    expect(missingKey.status).toBe(400);

    const prohibited = await fetch(intakeUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'prohibited' },
      body: JSON.stringify({ payload: { summary: 'No', api_key: 'secret' } }),
    });
    expect(prohibited.status).toBe(400);

    const schemaInvalid = await fetch(intakeUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'schema-invalid' },
      body: JSON.stringify({ payload: { summary: 'Missing the required request type.' } }),
    });
    expect(schemaInvalid.status).toBe(400);

    const tooDeep = await fetch(intakeUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'too-deep' },
      body: JSON.stringify({ payload: { a: { b: { c: { d: { e: { f: 'too deep' } } } } } } }),
    });
    expect(tooDeep.status).toBe(400);

    const oversized = await fetch(intakeUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'oversized' },
      body: JSON.stringify({ payload: { summary: 'x'.repeat(33 * 1024) } }),
    });
    expect(oversized.status).toBe(413);
    expect(counters.batches).toHaveLength(0);
  });

  it('isolates noisy installations and accepts anonymous submissions from independent origins', async () => {
    const other = await install('other-travel-desk');
    const address = clientAddressBucket('127.0.0.1');
    if (!address) throw new Error('loopback address did not produce a bucket');
    const now = new Date();
    await counters.consume(
      {
        key: `solution-intake:network:hour:${publicId}:${address}`,
        limit: 6_000,
        amount: 6_000,
        window: 'hour',
      },
      now,
    );
    expect((await submit('blocked-installation', 'Noisy installation')).status).toBe(429);

    const crossOrigin = await fetch(intakeUrl(other.publicId), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'other-installation',
        origin: 'https://customer.example',
        cookie: 'ns_bp_session=must-not-be-required',
      },
      body: JSON.stringify({ payload: { request_type: 'service', summary: 'Independent' } }),
    });
    expect(crossOrigin.status).toBe(201);
    expect(crossOrigin.headers.get('access-control-allow-origin')).toBe('*');
  });
});
