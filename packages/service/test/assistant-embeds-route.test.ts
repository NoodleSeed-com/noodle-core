import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ADMISSION_DEFAULTS, InMemoryDailyCounterStore } from '@noodle-borg/admission-limits';
import { InMemoryPublicEmbedStore } from '@noodle-borg/assistant-gateway';
import type { RuntimeArtifact } from '@noodle-borg/compiler';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AssistantRouteDeps } from '../src/routes/assistant.js';
import { handleAssistantEmbeds } from '../src/routes/assistant-embeds.js';

/**
 * The operator surface for a public assistant: see the surfaces, and change what they may spend.
 *
 * `PATCH … {turnsPerDay: 0}` is the kill switch and deliberately the only documented one — revoking an
 * embed also stops a surface but destroys the paste-once id and every page carrying it.
 */

const NOW = new Date('2030-01-01T00:00:00.000Z');
const TENANT = { org: 'acme', app: 'site', env: 'prod' };
const ORIGIN = 'https://www.acme.test';

const artifactWithMode = (mode: 'public' | 'mixed'): RuntimeArtifact =>
  ({
    server: {
      assistant: {
        surfaces: [
          {
            mode,
            origins: [ORIGIN],
            capabilities: [{ kind: 'tool', name: 'ask_product' }],
          },
        ],
      },
    },
  }) as unknown as RuntimeArtifact;

const ARTIFACT = artifactWithMode('public');
let servedArtifact: RuntimeArtifact;

let http: Server;
let base: string;
let embeds: InMemoryPublicEmbedStore;
let counters: InMemoryDailyCounterStore;
let managedModelResolver: AssistantRouteDeps['managedModelResolver'] | undefined;

beforeEach(async () => {
  servedArtifact = ARTIFACT;
  managedModelResolver = undefined;
  embeds = new InMemoryPublicEmbedStore();
  counters = new InMemoryDailyCounterStore();
  const deps = {
    publicEmbeds: embeds,
    admissionCounters: counters,
    registry: {
      getActiveByTenant: () => Promise.resolve({ served: { artifact: servedArtifact } }),
    },
    // Unauthenticated local posture: the gate resolves no identity, which the route treats as the
    // trusted operator path. Membership enforcement has its own coverage on the clients route.
    gate: { authorize: () => Promise.resolve({ ok: true }) },
    controlPlane: { isOrgMember: () => Promise.resolve(true) },
    clock: () => NOW,
    maxBody: 64 * 1024,
    managedModelResolver: { resolve: async () => managedModelResolver?.resolve?.({} as never) },
  } as unknown as AssistantRouteDeps;

  http = createServer((req, res) => {
    const id = new URL(req.url ?? '', 'http://x').pathname.split('/embeds/')[1];
    void handleAssistantEmbeds(req, res, TENANT, id, deps).catch((error: unknown) => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(error instanceof Error ? error.message : 'unknown');
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}/v1/assistant/embeds`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => http.close((e) => (e ? reject(e) : resolve())));
});

const provision = () => embeds.ensure({ ...TENANT, surfaceMode: 'public', now: NOW });

const list = async () =>
  (await (await fetch(base)).json()) as { embeds: readonly Record<string, unknown>[] };

const patch = (embedId: string, body: unknown) =>
  fetch(`${base}/${embedId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('the assistant embeds route', () => {
  it('lists a surface with what a browser will actually be held to', async () => {
    const embed = await provision();
    const body = await list();

    expect(body.embeds).toHaveLength(1);
    // Origins and capabilities come from the *active* deployment, not the embed row, so an operator
    // reading this sees what mint time will enforce rather than what was true when the id was created.
    expect(body.embeds[0]).toMatchObject({
      embedId: embed.embedId,
      surfaceMode: 'public',
      origins: [ORIGIN],
      capabilities: ['ask_product'],
      turnsPerDay: ADMISSION_DEFAULTS.turnsPerDay,
      budgetIsDefault: true,
      turnsToday: 0,
    });
  });

  it('reports the active deployment surfaceMode after a redeploy changed it', async () => {
    // The embed row keeps its provisioning-time mode by design (ensure never updates a live
    // row); the view must read the mode from the active artifact like origins/capabilities,
    // or an operator sees "public" on a surface that mints as mixed.
    const embed = await provision();
    servedArtifact = artifactWithMode('mixed');
    const body = await list();
    expect(body.embeds[0]).toMatchObject({ embedId: embed.embedId, surfaceMode: 'mixed' });
  });

  it('reports today’s consumption without spending any of it', async () => {
    const embed = await provision();
    await counters.consume({ key: `turns:${embed.embedId}`, limit: 100 }, NOW);
    await counters.consume({ key: `turns:${embed.embedId}`, limit: 100 }, NOW);

    expect((await list()).embeds[0]).toMatchObject({ turnsToday: 2, mintsToday: 0 });
    // A second read must not move the counter — peek, not consume.
    expect((await list()).embeds[0]).toMatchObject({ turnsToday: 2 });
  });

  it('lowers a surface’s daily caps', async () => {
    const embed = await provision();
    const response = await patch(embed.embedId, { turnsPerDay: 50 });

    expect(response.status).toBe(200);
    expect((await response.json()) as { embed: unknown }).toMatchObject({
      embed: { turnsPerDay: 50, budgetIsDefault: false },
    });
    expect((await embeds.lookup(embed.embedId))?.turnsPerDay).toBe(50);
  });

  it('accepts zero, because zero is the kill switch', async () => {
    const embed = await provision();
    const response = await patch(embed.embedId, { turnsPerDay: 0, mintsPerDay: 0 });

    expect(response.status).toBe(200);
    expect((await response.json()) as { embed: unknown }).toMatchObject({
      embed: { turnsPerDay: 0, mintsPerDay: 0 },
    });
  });

  it('never reports a cap above the structural maximum', async () => {
    const embed = await provision();
    const body = (await (await patch(embed.embedId, { turnsPerDay: 999_999_999 })).json()) as {
      embed: { turnsPerDay: number };
    };

    // What an operator reads back is what admission will enforce, not what they asked for.
    expect(body.embed.turnsPerDay).toBeLessThan(999_999_999);
  });

  it('rejects a cap that could only be a mistake', async () => {
    const embed = await provision();

    expect((await patch(embed.embedId, { turnsPerDay: -1 })).status).toBe(400);
    expect((await patch(embed.embedId, { turnsPerDay: 1.5 })).status).toBe(400);
    expect((await patch(embed.embedId, { turnsPerDay: 'lots' })).status).toBe(400);
    // Silently succeeding on an empty change would let a typo'd flag name read as "budget applied".
    expect((await patch(embed.embedId, {})).status).toBe(400);
  });

  it('reports an unknown id as missing, to a caller entitled to know', async () => {
    expect((await patch('pub_doesnotexistdoesnotexist', { turnsPerDay: 1 })).status).toBe(404);
  });
});

/**
 * What an operator reads has to be what admission enforces.
 *
 * It was not: the view was built from the bare deployment defaults while enforcement resolved the
 * sponsored envelope, so a Noodle-funded surface reported one budget and honoured another.
 */
describe('a surface Noodle is funding', () => {
  const sponsored = (spendUsed?: number) => {
    managedModelResolver = {
      resolve: async () => ({
        source: 'noodle-managed' as const,
        baseUrl: 'https://models.example',
        model: 'managed',
        apiKey: 'sponsor',
        publicAdmission: {
          defaults: { turnsPerSession: 40, turnsPerDay: 2_000, mintsPerDay: 400 },
          ceiling: { turnsPerDay: 2_000, mintsPerDay: 400 },
          ...(spendUsed === undefined
            ? {}
            : { spend: { key: 'spend:acme/site/prod', units: 19, allowance: 1_900 } }),
        },
      }),
    } as never;
  };

  it('reports the sponsored budget it will actually be held to', async () => {
    sponsored();
    await provision();

    const [embed] = (await list()).embeds;
    expect(embed).toMatchObject({ turnsPerDay: 2_000, mintsPerDay: 400 });
    // Not the deployment defaults, which is what it used to report.
    expect(embed?.turnsPerDay).not.toBe(ADMISSION_DEFAULTS.turnsPerDay);
  });

  it('says what the platform is doing to it, so degradation is not mistaken for a bug', async () => {
    sponsored(0);
    const embed = await provision();
    await counters.consume({ key: 'spend:acme/site/prod', limit: 1_900, amount: 1_600 }, NOW);

    const [listed] = (await list()).embeds;
    expect(listed?.embedId).toBe(embed.embedId);
    expect(listed?.managedSpend).toMatchObject({ state: 'near' });
    // Remaining turns, never a percentage.
    expect((listed?.managedSpend as { turnsRemaining: number }).turnsRemaining).toBeGreaterThan(0);
  });

  it('says nothing about platform spend on a surface the customer funds', async () => {
    await provision();
    expect((await list()).embeds[0]).not.toHaveProperty('managedSpend');
  });
});
