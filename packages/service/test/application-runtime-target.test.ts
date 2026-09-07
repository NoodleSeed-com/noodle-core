import {
  effectiveAssistantBrowserConfiguration,
  InMemoryAssistantStore,
  resolveAssistantSessionTarget,
} from '@noodle-borg/assistant-gateway/portable';
import { compile } from '@noodle-borg/compiler';
import { InMemoryConnectorRegistry, StaticServiceBroker } from '@noodle-borg/runtime';
import type { ServedTarget } from '@noodle-borg/transport-http';
import { describe, expect, it, vi } from 'vitest';
import {
  resolveApplicationRuntimeTarget,
  resolveTargetOrigins,
} from '../src/application-runtime-target.js';
import { InMemoryBusinessInformationStore } from '../src/business-information/portable.js';
import { sessionScopedTarget } from '../src/routes/assistant-session-target.js';

const scope = { org: 'acme', app: 'site', env: 'production', installationId: 'site' };
const origin = 'https://site.example';
const manifest = `
manifestVersion: '2'
server:
  name: app
  title: App
  version: '1'
  variables:
    - name: WEBSITE
      schemaVersion: 1
      valueSchema: {type: string, maxLength: 256}
      portal: {label: Website origin}
      requiredFor: []
  assistant:
    model: {kind: noodle-managed}
    allowedOrigins: ['\${env.WEBSITE}']
    surfaces:
      - mode: public
        origins: ['\${env.WEBSITE}']
        capabilities: [{kind: tool, name: browse}]
tools:
  - name: browse
    description: Browse products.
    inputSchema: {type: object}
    fulfilment: {steps: [], output: {ok: true}}
  - name: private_tool
    description: Operator only.
    inputSchema: {type: object}
    fulfilment: {steps: [], output: {ok: true}}
`;

function fixture() {
  const compiled = compile(manifest);
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
  let configured: string | undefined = origin;
  const env = vi.fn(async () =>
    configured === undefined ? {} : { WEBSITE: JSON.stringify(configured) },
  );
  const target: ServedTarget = {
    org: scope.org,
    app: scope.app,
    environment: scope.env,
    deploymentId: 'pinned-deployment',
    served: {
      artifact: compiled.artifact,
      deps: {
        connectors: new InMemoryConnectorRegistry([]),
        broker: new StaticServiceBroker({ token: 'fixture-token' }),
        env,
      },
    },
  };
  return {
    target,
    env,
    configure: (value: string | undefined) => {
      configured = value;
    },
  };
}

async function session() {
  return (
    await new InMemoryAssistantStore().createSession({
      clientId: 'public-embed',
      tenant: scope,
      deploymentId: 'pinned-deployment',
      origin,
      caller: { subject: 'anonymous', identityKind: 'anonymous' },
      boundSurface: 'public',
      publicEmbedId: 'public-embed',
      createdAt: '2030-01-01T00:00:00Z',
      expiresAt: '2030-01-01T01:00:00Z',
      absoluteExpiresAt: '2030-01-01T02:00:00Z',
    })
  ).session;
}

describe('live application runtime authority', () => {
  it('requires a new session when the receiving notice changes, including a previously notice-free session', async () => {
    const f = fixture();
    const store = new InMemoryBusinessInformationStore();
    await store.createInstallation({
      scope,
      profileKey: 'travel',
      managedCollections: ['travel_requests'],
      actorSubject: 'owner',
    });
    const notice = {
      displayName: 'Receiving business',
      privacyUrl: 'https://recipient.example/privacy',
      supportUrl: 'mailto:help@recipient.example',
    };
    await store.setBusinessNotice({ scope, notice, expectedRevision: 0, actorSubject: 'owner' });
    const resolve = (target: ServedTarget) => resolveApplicationRuntimeTarget(target, store);
    const existing = await session();
    const registry = { get: async () => f.target };
    expect(await sessionScopedTarget(registry, existing, resolve)).toBeUndefined();
    const configuration = (
      await effectiveAssistantBrowserConfiguration(
        f.target.served.artifact.server,
        scope,
        undefined,
        'public',
        notice,
      )
    ).effective;
    if (!configuration) throw new Error('Expected notice configuration');
    const notified = { ...existing, configuration };
    expect(await sessionScopedTarget(registry, notified, resolve)).toBeDefined();
    await store.setBusinessNotice({
      scope,
      notice: { ...notice, supportUrl: 'mailto:new@recipient.example' },
      expectedRevision: 1,
      actorSubject: 'owner',
    });
    expect(await sessionScopedTarget(registry, notified, resolve)).toBeUndefined();
  });
  it('threads the verified assistant session and current peer into the same private admission path as MCP', async () => {
    const f = fixture();
    const existing = await session();
    const registry = { get: async () => f.target };
    const req = new IncomingMessage(new Socket());
    Object.defineProperty(req.socket, 'remoteAddress', { value: '203.0.113.8' });
    req.headers['x-forwarded-for'] = '198.51.100.9';
    const target = await sessionScopedTarget(registry, existing, resolveTargetOrigins, req);
    expect(target?.served.deps.publicAdmission).toEqual(
      trustedPublicAdmission({
        scope: 'acme/site/production',
        sourceAddress: '203.0.113.8',
        subject: existing.caller.subject,
      }),
    );
    expect(
      (await sessionScopedTarget(registry, existing))?.served.deps.publicAdmission,
    ).toBeUndefined();
    expect(target?.served.deps.env).not.toHaveProperty('publicAdmission');
  });
  it('pins one current configuration snapshot per request and re-reads on the next request', async () => {
    const f = fixture();
    const first = await resolveTargetOrigins(f.target);
    expect(f.env).toHaveBeenCalledTimes(1);
    expect(first?.served.artifact.server.assistant?.allowedOrigins).toEqual([origin]);
    f.configure('https://replacement.example');
    const second = await resolveTargetOrigins(f.target);
    expect(second?.served.artifact.server.assistant?.allowedOrigins).toEqual([
      'https://replacement.example',
    ]);
    expect(first?.served.deps.env).toEqual({ WEBSITE: JSON.stringify(origin) });
    expect(first?.served.deps.executionBinding?.revision).not.toBe(
      second?.served.deps.executionBinding?.revision,
    );
    expect(f.target.served.artifact.server.assistant?.allowedOrigins).toEqual(['${env.WEBSITE}']);
  });

  it('fences a changed connected account without putting account identifiers into configuration', async () => {
    const f = fixture();
    const first = await resolveApplicationRuntimeTarget(f.target, undefined, async () => ({
      external: 'generation-one',
    }));
    const second = await resolveApplicationRuntimeTarget(f.target, undefined, async () => ({
      external: 'generation-two',
    }));
    expect(first?.served.deps.executionBinding?.connections).toEqual({
      external: 'generation-one',
    });
    expect(first?.served.deps.executionBinding?.revision).not.toBe(
      second?.served.deps.executionBinding?.revision,
    );
    expect(first?.served.deps.env).toEqual({ WEBSITE: JSON.stringify(origin) });
  });

  it('keeps partial setup closed, and refuses invalid configured values', async () => {
    const f = fixture();
    f.configure(undefined);
    expect(
      (await resolveTargetOrigins(f.target))?.served.artifact.server.assistant?.allowedOrigins,
    ).toEqual([]);
    f.configure('https://bad.example/path');
    expect(await resolveTargetOrigins(f.target)).toBeUndefined();
  });

  it('pauses existing sessions without changing their embed or deployment; resume reuses them', async () => {
    const f = fixture();
    const store = new InMemoryBusinessInformationStore();
    await store.createInstallation({
      scope,
      profileKey: 'travel',
      managedCollections: ['travel_requests'],
      actorSubject: 'admin',
    });
    const existing = await session();
    const load = async () => resolveApplicationRuntimeTarget(f.target, store);
    const installed = await store.getInstallation(scope);
    if (!installed) throw new Error('missing fixture installation');
    const before = await resolveAssistantSessionTarget(load, existing);
    expect(before?.served.artifact.tools.map((tool) => tool.name)).toEqual(['browse']);
    await store.setIntakeState({
      scope,
      expectedRevision: installed.revision,
      active: false,
      actorSubject: 'admin',
    });
    expect(await resolveAssistantSessionTarget(load, existing)).toBeUndefined();
    expect(
      await resolveApplicationRuntimeTarget({ ...f.target, app: 'unrelated' }, store),
    ).toBeDefined();
    const paused = await store.getInstallation(scope);
    if (!paused) throw new Error('missing paused fixture');
    await store.setIntakeState({
      scope,
      expectedRevision: paused.revision,
      active: true,
      actorSubject: 'admin',
    });
    expect((await resolveAssistantSessionTarget(load, existing))?.deploymentId).toBe(
      'pinned-deployment',
    );
    expect(existing.publicEmbedId).toBe('public-embed');
  });

  it('revokes a bound session when its origin is removed without widening to other tools', async () => {
    const f = fixture();
    const existing = await session();
    const load = async () => resolveTargetOrigins(f.target);
    expect(
      (await resolveAssistantSessionTarget(load, existing))?.served.artifact.tools.map(
        (tool) => tool.name,
      ),
    ).toEqual(['browse']);
    f.configure('https://replacement.example');
    expect(await resolveAssistantSessionTarget(load, existing)).toBeUndefined();
    f.configure(undefined);
    expect(await resolveAssistantSessionTarget(load, existing)).toBeUndefined();
  });
});

import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { trustedPublicAdmission } from '@noodle-borg/admission-limits/portable';
