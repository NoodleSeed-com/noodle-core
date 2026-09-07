import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { InMemoryDailyCounterStore } from '@noodle-borg/admission-limits';
import {
  InMemoryAssistantAppearanceSettingsStore,
  InMemoryPublicEmbedStore,
} from '@noodle-borg/assistant-gateway';
import type { RuntimeArtifact } from '@noodle-borg/compiler';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantRouteDeps } from '../src/routes/assistant.js';
import { handlePublicAssistantConfiguration } from '../src/routes/assistant-public-configuration.js';

const NOW = new Date('2030-08-01T10:00:00.000Z');
const TENANT = { org: 'acme', app: 'site', env: 'prod' };
const ORIGIN = 'https://www.acme.test';
const ARTIFACT = {
  server: {
    branding: { name: 'Acme', accent: '#2563EB' },
    assistant: {
      model: {
        kind: 'openai-compatible',
        baseUrl: 'https://model.test',
        model: 'm',
        apiKey: 'SECRET',
      },
      allowedOrigins: [ORIGIN],
      sessionClaims: { plan: { exposeToModel: true } },
      theme: 'auto',
      behavior: { showConfirmationDetails: false },
      surfaces: [
        { mode: 'public', origins: [ORIGIN], capabilities: [{ kind: 'tool', name: 'internal' }] },
      ],
    },
  },
} as unknown as RuntimeArtifact;

let http: Server;
let base: string;
let embedId: string;
let counters: { consume: ReturnType<typeof vi.fn>; peek: ReturnType<typeof vi.fn>; durable: true };
let businessNotice: { displayName: string; privacyUrl: string; supportUrl: string } | undefined;

beforeEach(async () => {
  businessNotice = undefined;
  const embeds = new InMemoryPublicEmbedStore();
  embedId = (await embeds.ensure({ ...TENANT, surfaceMode: 'public', now: NOW })).embedId;
  const appearance = new InMemoryAssistantAppearanceSettingsStore();
  await appearance.replace({
    tenant: TENANT,
    expectedRevision: 0,
    override: {
      branding: { accent: '#EA580C', surface: '#F8F8F8', surfaceDark: '#0C0A09' },
      assistant: { presentation: { launcher: { style: 'bubble' } } },
    },
    updatedAt: NOW,
    updatedBy: 'operator-1',
  });
  counters = {
    durable: true,
    consume: vi.fn(),
    peek: vi.fn(),
  };
  const deps = {
    publicEmbeds: embeds,
    admissionCounters: counters as unknown as InMemoryDailyCounterStore,
    appearance,
    registry: {
      getActiveByTenant: () =>
        Promise.resolve({ deploymentId: 'dep_1', served: { artifact: ARTIFACT, deps: {} } }),
    },
    clock: () => NOW,
    resolveRuntimeTarget: async (target: import('@noodle-borg/transport-http').ServedTarget) => ({
      ...target,
      ...(businessNotice ? { businessNotice } : {}),
    }),
  } as unknown as AssistantRouteDeps;
  http = createServer((req, res) => {
    void handlePublicAssistantConfiguration(req, res, embedId, deps).catch((error: unknown) => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(error instanceof Error ? error.message : 'unknown');
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    http.close((error) => (error ? reject(error) : resolve())),
  );
});

describe('public assistant configuration route', () => {
  it('projects installation identity, linked privacy and complete support text before the first session is minted', async () => {
    businessNotice = {
      displayName: 'Receiving company',
      privacyUrl: 'https://recipient.example/privacy',
      supportUrl: 'mailto:help@recipient.example',
    };
    const response = await fetch(base, { headers: { origin: ORIGIN } });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.configuration.branding.name).toBe(businessNotice.displayName);
    expect(result.configuration.assistant.privacyUrl).toBe(businessNotice.privacyUrl);
    expect(result.configuration.assistant.labels.welcomeMessage).toContain(
      businessNotice.supportUrl,
    );
    expect(result.configuration).not.toHaveProperty('businessNotice');
    expect(counters.consume).not.toHaveBeenCalled();
  });
  it('returns only effective browser appearance to an allowed origin without spending admission', async () => {
    const response = await fetch(base, { headers: { origin: ORIGIN } });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(await response.json()).toEqual({
      configuration: {
        branding: {
          name: 'Acme',
          accent: '#EA580C',
          surface: '#F8F8F8',
          surfaceDark: '#0C0A09',
        },
        assistant: {
          theme: 'auto',
          behavior: { showConfirmationDetails: false },
          presentation: { launcher: { style: 'bubble' } },
        },
      },
      fallback: 'halo',
      revision: 1,
    });
    expect(counters.consume).not.toHaveBeenCalled();
    expect(counters.peek).not.toHaveBeenCalled();
    const serialized = JSON.stringify(
      await (await fetch(base, { headers: { origin: ORIGIN } })).json(),
    );
    for (const unsafe of [
      'SECRET',
      'apiKey',
      'allowedOrigins',
      'sessionClaims',
      'plan',
      'capabilities',
      'internal',
    ]) {
      expect(serialized).not.toContain(unsafe);
    }
  });

  it.each([
    undefined,
    'https://evil.test',
  ])('refuses origin %s without a readable CORS response', async (origin) => {
    const response = await fetch(base, { headers: origin ? { origin } : {} });
    expect(response.status).toBe(403);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});
