import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  InMemoryAssistantAppearanceSettingsStore,
  InMemoryAssistantStore,
} from '@noodle-borg/assistant-gateway';
import type { RuntimeArtifact } from '@noodle-borg/compiler';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantRouteDeps } from '../src/routes/assistant.js';
import { handleAssistantSession } from '../src/routes/assistant.js';
import { handleAssistantAppearance } from '../src/routes/assistant-appearance.js';

const NOW = new Date('2030-08-01T10:00:00.000Z');
const TENANT = { org: 'acme', app: 'site', env: 'prod' };

const ARTIFACT = {
  server: {
    branding: {
      name: 'Acme Support',
      accent: '#2563EB',
      theme: { light: { text: '#101828', border: '#D0D5DD' } },
    },
    assistant: {
      model: { kind: 'openai-compatible', baseUrl: 'https://model.test', model: 'm', apiKey: 'K' },
      allowedOrigins: ['https://www.acme.test'],
      sessionClaims: { plan: { exposeToModel: true } },
      surfaces: [
        {
          mode: 'authenticated',
          origins: ['https://www.acme.test'],
        },
      ],
      theme: 'auto',
      layout: { position: 'bottom-left', panelWidth: 640 },
      presentation: { launcher: { style: 'pill', icon: 'brand-mark' } },
    },
  },
} as unknown as RuntimeArtifact;

let http: Server;
let base: string;
let appearance: InMemoryAssistantAppearanceSettingsStore;
let sessions: InMemoryAssistantStore;
let artifact: RuntimeArtifact;
let audit: ReturnType<typeof vi.fn>;
let businessNotice: { displayName: string; privacyUrl: string; supportUrl: string } | undefined;

beforeEach(async () => {
  businessNotice = undefined;
  appearance = new InMemoryAssistantAppearanceSettingsStore();
  sessions = new InMemoryAssistantStore();
  artifact = ARTIFACT;
  audit = vi.fn().mockResolvedValue(undefined);
  const deps = {
    appearance,
    store: sessions,
    registry: {
      getActiveByTenant: () =>
        Promise.resolve({ deploymentId: 'dep_1', served: { artifact, deps: {} } }),
    },
    gate: { authorize: () => Promise.resolve({ ok: true }) },
    controlPlane: { isOrgMember: () => Promise.resolve(true) },
    audit: { emit: audit },
    clock: () => NOW,
    maxBody: 64 * 1024,
    serviceBase: () => base,
    resolveRuntimeTarget: async (target: import('@noodle-borg/transport-http').ServedTarget) => ({
      ...target,
      ...(businessNotice ? { businessNotice } : {}),
    }),
  } as unknown as AssistantRouteDeps;

  http = createServer((req, res) => {
    const handler =
      req.url === '/session'
        ? handleAssistantSession(req, res, deps)
        : handleAssistantAppearance(req, res, TENANT, deps);
    void handler.catch((error: unknown) => {
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

const read = () => fetch(base);
const replace = (revision: number, body: unknown) =>
  fetch(base, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'if-match': `"${revision}"` },
    body: JSON.stringify(body),
  });
const reset = (revision: number) =>
  fetch(base, { method: 'DELETE', headers: { 'if-match': `"${revision}"` } });

describe('assistant appearance operator route', () => {
  it('pins the receiving notice after appearance overrides in the actual authenticated session response', async () => {
    businessNotice = {
      displayName: 'Receiving company',
      privacyUrl: 'https://recipient.example/privacy',
      supportUrl: 'mailto:help@recipient.example',
    };
    await replace(0, {
      branding: { name: 'Appearance only' },
      assistant: {
        privacyUrl: 'https://other.example/privacy',
        labels: { welcomeMessage: 'Welcome to our service.' },
      },
    });
    const created = await sessions.createClient({
      name: 'web',
      tenant: TENANT,
      deploymentId: 'dep_1',
      allowedOrigins: ['https://www.acme.test'],
      now: NOW,
    });
    const basic = Buffer.from(`${created.client.id}:${created.secret}`).toString('base64');
    const response = await fetch(`${base}/session`, {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/json' },
      body: JSON.stringify({ origin: 'https://www.acme.test', user: { id: 'customer-1' } }),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.configuration.branding.name).toBe(businessNotice.displayName);
    expect(body.configuration.assistant.privacyUrl).toBe(businessNotice.privacyUrl);
    expect(body.configuration.assistant.labels.welcomeMessage).toContain(businessNotice.supportUrl);
    expect(body.configuration.assistant.labels.welcomeMessage).toContain('Welcome to our service.');
    expect((await sessions.getSession(body.token, NOW))?.configuration).toEqual(body.configuration);
  });
  it('shows developer intent, Halo fallback, and revision zero before an override exists', async () => {
    const response = await read();
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe('"0"');
    expect(await response.json()).toEqual({
      ok: true,
      assistantEnabled: true,
      revision: 0,
      fallback: 'halo',
      developer: {
        branding: {
          name: 'Acme Support',
          accent: '#2563EB',
          theme: { light: { text: '#101828', border: '#D0D5DD' } },
        },
        assistant: {
          theme: 'auto',
          layout: { position: 'bottom-left', panelWidth: 640 },
          presentation: { launcher: { style: 'pill', icon: 'brand-mark' } },
        },
      },
      override: null,
      effective: {
        branding: {
          name: 'Acme Support',
          accent: '#2563EB',
          theme: { light: { text: '#101828', border: '#D0D5DD' } },
        },
        assistant: {
          theme: 'auto',
          layout: { position: 'bottom-left', panelWidth: 640 },
          presentation: { launcher: { style: 'pill', icon: 'brand-mark' } },
        },
      },
      provenance: {
        'assistant.layout.panelWidth': 'developer',
        'assistant.layout.position': 'developer',
        'assistant.presentation.launcher.icon': 'developer',
        'assistant.presentation.launcher.style': 'developer',
        'assistant.theme': 'developer',
        'branding.accent': 'developer',
        'branding.name': 'developer',
        'branding.theme.light.border': 'developer',
        'branding.theme.light.text': 'developer',
      },
    });
  });

  it('saves a full override and reports effective field provenance', async () => {
    const response = await replace(0, {
      branding: { accent: '#EA580C', surface: '#F8F8F8', surfaceDark: '#0C0A09' },
      assistant: {
        theme: 'dark',
        layout: { position: 'bottom-right' },
        presentation: { launcher: { style: 'bubble' } },
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe('"1"');
    const body = await response.json();
    expect(body).toMatchObject({
      revision: 1,
      override: {
        branding: { accent: '#EA580C', surface: '#F8F8F8', surfaceDark: '#0C0A09' },
        assistant: {
          theme: 'dark',
          layout: { position: 'bottom-right' },
          presentation: { launcher: { style: 'bubble' } },
        },
      },
      effective: {
        branding: { name: 'Acme Support', accent: '#EA580C' },
        assistant: {
          theme: 'dark',
          layout: { position: 'bottom-right', panelWidth: 640 },
          presentation: { launcher: { style: 'bubble', icon: 'brand-mark' } },
        },
      },
      provenance: {
        'branding.name': 'developer',
        'branding.accent': 'operator',
        'assistant.layout.panelWidth': 'developer',
        'assistant.layout.position': 'operator',
      },
      updatedAt: NOW.toISOString(),
      updatedBy: 'local-operator',
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'assistant.appearance.updated',
        details: { revision: 1, hasOverride: true },
      }),
    );
    expect(JSON.stringify(audit.mock.calls)).not.toContain('#EA580C');
  });

  it('rejects stale, missing, malformed, and unsafe replacements', async () => {
    expect((await replace(0, { assistant: { theme: 'dark' } })).status).toBe(200);
    expect((await replace(0, { assistant: { theme: 'light' } })).status).toBe(409);
    expect(
      (
        await fetch(base, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ assistant: { theme: 'light' } }),
        })
      ).status,
    ).toBe(428);
    expect((await replace(1, { assistant: { model: { apiKey: 'secret' } } })).status).toBe(400);
    expect((await replace(1, {})).status).toBe(400);
    expect((await read()).headers.get('etag')).toBe('"1"');
  });

  it('resets to developer intent while advancing the revision', async () => {
    expect((await replace(0, { assistant: { theme: 'dark' } })).status).toBe(200);
    const response = await reset(1);
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe('"2"');
    expect(await response.json()).toMatchObject({
      revision: 2,
      override: null,
      effective: { assistant: { theme: 'auto' } },
      updatedBy: 'local-operator',
    });
    expect((await replace(1, { assistant: { theme: 'light' } })).status).toBe(409);
    expect(audit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        eventType: 'assistant.appearance.reset',
        details: { revision: 2, hasOverride: false },
      }),
    );
  });

  it('reports a disabled active deployment without losing stored operator state', async () => {
    expect((await replace(0, { assistant: { theme: 'dark' } })).status).toBe(200);
    artifact = { server: {} } as unknown as RuntimeArtifact;
    expect(await (await read()).json()).toMatchObject({
      assistantEnabled: false,
      revision: 1,
      developer: null,
      override: { assistant: { theme: 'dark' } },
      effective: { assistant: { theme: 'dark' } },
    });
  });

  it('applies overrides to new authenticated sessions while existing sessions stay pinned', async () => {
    const created = await sessions.createClient({
      name: 'web',
      tenant: TENANT,
      deploymentId: 'dep_1',
      allowedOrigins: ['https://www.acme.test'],
      now: NOW,
    });
    const basic = Buffer.from(`${created.client.id}:${created.secret}`).toString('base64');
    const mint = () =>
      fetch(`${base}/session`, {
        method: 'POST',
        headers: { authorization: `Basic ${basic}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          origin: 'https://www.acme.test',
          user: { id: 'customer-1' },
        }),
      });

    expect((await replace(0, { assistant: { theme: 'dark' } })).status).toBe(200);
    const first = await (await mint()).json();
    expect(first.configuration).toMatchObject({
      branding: { name: 'Acme Support' },
      assistant: { theme: 'dark', layout: { position: 'bottom-left' } },
    });

    expect((await replace(1, { assistant: { theme: 'light' } })).status).toBe(200);
    const second = await (await mint()).json();
    expect(second.configuration.assistant.theme).toBe('light');
    expect((await sessions.getSession(first.token, NOW))?.configuration?.assistant?.theme).toBe(
      'dark',
    );
  });
});
