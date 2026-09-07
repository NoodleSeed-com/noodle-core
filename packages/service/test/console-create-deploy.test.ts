import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// Test-only cross-package source import (allowlisted in quality-gates.config.json): this is the
// drift gate for the console's cloud-side create (ADR 0114). The console's inline hello manifest
// must deploy through the REAL deploy route — a shape-only mock let the 2026-07-04 `invalid_name`
// regression ship: dashed app slugs were passed straight into `server.name`, which requires
// lowercase letters, numbers, and underscores.
import { helloManifest } from '../../../apps/console/app/lib/create-project';
import {
  createServiceHandler,
  InMemoryConfigStore,
  InMemoryControlPlaneStore,
  ServerRegistry,
} from '../src/index.js';

let http: Server;
let base: string;
let registry: ServerRegistry;

beforeEach(async () => {
  const configStore = new InMemoryConfigStore();
  const controlPlane = new InMemoryControlPlaneStore();
  await controlPlane.createOrg({ slug: 'acme' });
  registry = new ServerRegistry(undefined, undefined, configStore);
  http = createServer(
    createServiceHandler(registry, {
      configStore,
      controlPlaneStore: controlPlane,
      deployGate: {
        authorize: () =>
          Promise.resolve({
            ok: true,
            identity: { subject: 'owner-sub', email: 'owner@noodleseed.com', superAdmin: true },
          }),
      },
    }),
  );
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => http.close((e) => (e ? reject(e) : resolve())));
});

describe('console cloud-side create deploy contract', () => {
  // Dashed slugs are the console's normal case: its consent catalog validates the app as a dashed
  // APP_SLUG, so every created project arrives here with a dash unless it is a single word.
  for (const app of ['hello-world', 'docs-bot-2']) {
    it(`deploys the console's exact create body for dashed app slug "${app}"`, async () => {
      const response = await fetch(
        `${base}/v1/orgs/acme/apps/${encodeURIComponent(app)}/envs/prod/deploy`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // The EXACT body createProjectFromTemplate sends — change that function and this
          // test together, or the console breaks while every mock-based test stays green.
          body: JSON.stringify({
            manifest: helloManifest(app),
            accessMode: 'owner-only',
            deploymentSource: 'console-example',
          }),
        },
      );
      const body = (await response.json()) as {
        ok?: boolean;
        deploymentId?: string;
        url?: string;
        errors?: unknown;
      };
      expect(response.status, JSON.stringify(body)).toBe(201);
      expect(body.ok).toBe(true);
      // The console renders body.url as the project's live endpoint after create.
      expect(typeof body.url).toBe('string');
      expect(
        body.deploymentId
          ? (await registry.getDeployment('acme', body.deploymentId))?.deploymentSource
          : undefined,
      ).toBe('console-example');
    });
  }

  it('deploys a single-word slug unchanged', async () => {
    const response = await fetch(`${base}/v1/orgs/acme/apps/hello/envs/prod/deploy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        manifest: helloManifest('hello'),
        accessMode: 'owner-only',
        deploymentSource: 'console-example',
      }),
    });
    const body = (await response.json()) as { ok?: boolean };
    expect(response.status, JSON.stringify(body)).toBe(201);
    expect(body.ok).toBe(true);
  });
});
