import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createServiceHandler,
  InMemoryControlPlaneStore,
  ServerRegistry,
  type ServiceOptions,
} from '../src/index.js';

const HELLO = `
manifestVersion: "1"
server: { name: hello, version: 1.0.0, title: Hello }
tools:
  - name: greet
    description: Greet someone.
    inputSchema: { type: object }
    fulfilment:
      steps: []
      output: { message: hello }
`;

let server: Server | undefined;

afterEach(async () => {
  if (server === undefined) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server?.close((error) => (error ? reject(error) : resolve())),
  );
  server = undefined;
});

async function start(
  options: Pick<ServiceOptions, 'maxBodyBytes' | 'maxDeployBodyBytes'>,
): Promise<string> {
  const controlPlane = new InMemoryControlPlaneStore();
  await controlPlane.createOrgWithOwner({
    slug: 'acme',
    owner: { subject: 'owner-sub', email: 'owner@noodleseed.com' },
  });
  server = createServer(
    createServiceHandler(new ServerRegistry(), {
      ...options,
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
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function deployUrl(base: string): string {
  return `${base}/v1/orgs/acme/apps/hello/envs/prod/deploy`;
}

describe('service request body limits', () => {
  it('returns 413 above the configured deploy-body limit', async () => {
    const base = await start({ maxDeployBodyBytes: 10 });
    const response = await fetch(deployUrl(base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ manifest: HELLO }),
    });
    expect(response.status).toBe(413);
    await response.text();
  });

  it('keeps the ordinary body limit separate from the larger deploy allowance', async () => {
    const base = await start({ maxBodyBytes: 10, maxDeployBodyBytes: 2 * 1024 * 1024 });
    const paddedManifest = `${HELLO}\n# ${'a'.repeat(1024 * 1024)}`;
    const deployResponse = await fetch(deployUrl(base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ manifest: paddedManifest, serverVersion: '1' }),
    });
    expect(deployResponse.status).toBe(201);
    await deployResponse.text();

    const ordinaryResponse = await fetch(`${base}/v1/orgs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'oversized', displayName: 'a'.repeat(100) }),
    });
    expect(ordinaryResponse.status).toBe(413);
    await ordinaryResponse.text();
  });

  it('accepts a gzip-compressed deploy body while enforcing the expanded size after decompression', async () => {
    const base = await start({ maxDeployBodyBytes: 2 * 1024 * 1024 });
    const text = JSON.stringify({
      manifest: `${HELLO}\n# ${'repeated-widget-runtime'.repeat(20_000)}`,
      serverVersion: '1',
    });
    const compressed = gzipSync(text);
    expect(compressed.byteLength).toBeLessThan(Buffer.byteLength(text, 'utf8') / 10);
    const response = await fetch(deployUrl(base), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      body: compressed,
    });
    expect(response.status).toBe(201);
    await response.text();
  });

  it('rejects a compressed deploy whose expanded body exceeds the deploy allowance', async () => {
    const base = await start({ maxDeployBodyBytes: 1024 });
    const response = await fetch(deployUrl(base), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      body: gzipSync(JSON.stringify({ manifest: `${HELLO}\n# ${'x'.repeat(4_000)}` })),
    });
    expect(response.status).toBe(413);
    expect(await response.text()).toContain('expanded');
  });
});
