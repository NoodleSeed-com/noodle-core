import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createServiceHandler,
  InMemoryConfigStore,
  InMemoryControlPlaneStore,
  InMemoryPublicEmbedStore,
  ServerRegistry,
} from '@noodle-borg/service';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAssistant } from '../src/commands/assistant-ops.js';

/**
 * The CLI against the real route, not a stubbed URL.
 *
 * Everything else about these commands is covered on one side or the other — flag parsing and output
 * formatting in the CLI, admission and validation in the service. What only a test spanning both can
 * prove is that the path the CLI builds is the path the service dispatch actually matches. A stubbed
 * fetch asserting the URL would agree with itself while the regex disagreed with both.
 */

const TENANT = { org: 'acme', app: 'site', env: 'prod' };

/**
 * A local stand-in rather than `@noodle-borg/admission-limits`, whose in-memory store would be perfect
 * here — but that package depends on `pg`, and the published CLI must not acquire a Postgres driver for
 * a test fixture. What this test proves is the CLI↔route path, not counting.
 */
const countingStub = () => {
  const used = new Map<string, number>();
  return {
    durable: true,
    consume: async ({ key, limit }: { key: string; limit: number }) => {
      const next = (used.get(key) ?? 0) + 1;
      if (next > limit) return { allowed: false, used: used.get(key) ?? 0, limit };
      used.set(key, next);
      return { allowed: true, used: next, limit };
    },
    peek: async (key: string) => used.get(key) ?? 0,
  };
};
const NOW = new Date('2030-01-01T00:00:00.000Z');

let http: Server;
let serviceUrl: string;
let embeds: InMemoryPublicEmbedStore;
let home: string;
let logs: string[];

beforeEach(async () => {
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((value) => logs.push(String(value)));
  home = mkdtempSync(join(tmpdir(), 'noodle-assistant-surface-'));
  embeds = new InMemoryPublicEmbedStore();

  const configStore = new InMemoryConfigStore();
  const controlPlane = new InMemoryControlPlaneStore();
  await controlPlane.createOrgWithOwner({
    slug: TENANT.org,
    owner: { subject: 'owner-sub', email: 'owner@noodleseed.com' },
  });
  http = createServer(
    createServiceHandler(new ServerRegistry(undefined, undefined, configStore), {
      configStore,
      controlPlaneStore: controlPlane,
      publicEmbeds: embeds,
      admissionCounters: countingStub(),
      verifyOwnerToken: () => Promise.resolve({ caller: { subject: 'owner-sub' } }),
    } as unknown as Parameters<typeof createServiceHandler>[1]),
  );
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  serviceUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((resolve, reject) => http.close((e) => (e ? reject(e) : resolve())));
});

const tenantFlags = () => [
  '--org',
  TENANT.org,
  '--app',
  TENANT.app,
  '--env',
  TENANT.env,
  '--service',
  serviceUrl,
  '--auth-token',
  'OWNER',
];

const run = (argv: readonly string[]) => runAssistant([...argv, ...tenantFlags()], {}, home);

describe('noodle assistant surface commands against a live service', () => {
  it('lists nothing before a deploy has provisioned a surface', async () => {
    expect(await run(['embeds', 'list'])).toBe(0);
    expect(logs.join('\n')).toContain('No public assistant surfaces');
  });

  it('reads a provisioned surface back through the route the service actually serves', async () => {
    const embed = await embeds.ensure({ ...TENANT, surfaceMode: 'public', now: NOW });

    expect(await run(['embeds', 'list'])).toBe(0);
    expect(logs.join('\n')).toContain(embed.embedId);
  });

  /**
   * The kill switch, end to end: flag parsing, the PATCH path, service validation, storage, and the
   * line an operator reads back. Zero has to survive every one of those layers.
   */
  it('switches a surface off and says so', async () => {
    const embed = await embeds.ensure({ ...TENANT, surfaceMode: 'public', now: NOW });

    // Both doors: turns alone stops conversations while minting keeps writing session rows, so only
    // both caps at zero is genuinely off, and only that may report OFF.
    expect(await run(['budget', 'set', '--turns-per-day', '0', '--mints-per-day', '0'])).toBe(0);
    expect(logs.join('\n')).toContain('OFF');
    const off = await embeds.lookup(embed.embedId);
    expect(off?.turnsPerDay).toBe(0);
    expect(off?.mintsPerDay).toBe(0);
  });

  it('does not report OFF while the surface still admits visitors', async () => {
    await embeds.ensure({ ...TENANT, surfaceMode: 'public', now: NOW });

    expect(await run(['budget', 'set', '--turns-per-day', '0'])).toBe(0);
    const text = logs.join('\n');
    expect(text).not.toContain('OFF');
    expect(text).toContain('still minting');
  });

  it('targets a named surface when asked', async () => {
    const embed = await embeds.ensure({ ...TENANT, surfaceMode: 'public', now: NOW });

    expect(await run(['budget', 'set', '--surface', embed.embedId, '--mints-per-day', '25'])).toBe(
      0,
    );
    expect((await embeds.lookup(embed.embedId))?.mintsPerDay).toBe(25);
  });

  it('refuses a budget change when there is no surface to change', async () => {
    expect(await run(['budget', 'set', '--turns-per-day', '10'])).not.toBe(0);
  });

  it('carries a service rejection back as a non-zero exit', async () => {
    await embeds.ensure({ ...TENANT, surfaceMode: 'public', now: NOW });
    // Rejected by the route, not by flag parsing: the CLI accepts the shape and the service does not.
    expect(
      await run([
        'budget',
        'set',
        '--surface',
        'pub_doesnotexistdoesnotexist',
        '--turns-per-day',
        '5',
      ]),
    ).not.toBe(0);
  });
});
