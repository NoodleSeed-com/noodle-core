import { describe, expect, it, vi } from 'vitest';
import { probeLocalCustomerAuthBoundary } from '../src/commands/customer-auth-smoke.js';

const ENDPOINT = 'http://127.0.0.1:7311/o/local/private/dev/mcp';
const METADATA =
  'http://127.0.0.1:7311/.well-known/oauth-protected-resource/o/local/private/dev/mcp';

describe('local customer-auth smoke', () => {
  it('proves the protected boundary and exact OAuth metadata without a customer token', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('', {
          status: 401,
          headers: {
            'www-authenticate': `Bearer realm="noodle", resource_metadata="${METADATA}"`,
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          resource: ENDPOINT,
          authorization_servers: ['https://login.example.test'],
          scopes_supported: ['orders:read'],
        }),
      );

    await expect(
      probeLocalCustomerAuthBoundary(ENDPOINT, {
        fetchFn,
        expectedAuthorizationServers: ['https://login.example.test'],
      }),
    ).resolves.toEqual({
      ok: true,
      resource: ENDPOINT,
      resourceMetadataUrl: METADATA,
      authorizationServers: ['https://login.example.test'],
      scopesSupported: ['orders:read'],
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[0]?.[0]).toBe(ENDPOINT);
    expect(fetchFn.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' });
    expect(fetchFn.mock.calls[1]?.[0]).toBe(METADATA);
    expect(fetchFn.mock.calls[1]?.[1]).toMatchObject({ method: 'GET' });
  });

  it('does not follow a challenge-supplied metadata URL that differs from the local resource', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response('', {
        status: 401,
        headers: {
          'www-authenticate':
            'Bearer resource_metadata="https://attacker.example.test/oauth-resource"',
        },
      }),
    );

    await expect(probeLocalCustomerAuthBoundary(ENDPOINT, { fetchFn })).resolves.toMatchObject({
      ok: false,
      reason: 'resource_metadata_mismatch',
      status: 401,
    });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('fails when protected-resource metadata does not bind the exact MCP resource', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('', {
          status: 401,
          headers: { 'www-authenticate': `Bearer resource_metadata="${METADATA}"` },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          resource: 'http://127.0.0.1:7311/o/local/other/dev/mcp',
          authorization_servers: ['https://login.example.test'],
        }),
      );

    await expect(probeLocalCustomerAuthBoundary(ENDPOINT, { fetchFn })).resolves.toMatchObject({
      ok: false,
      reason: 'resource_mismatch',
      status: 200,
    });
  });

  it('accepts exact bridge metadata without inventing an upstream authorization server', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('', {
          status: 401,
          headers: { 'www-authenticate': `Bearer resource_metadata="${METADATA}"` },
        }),
      )
      .mockResolvedValueOnce(Response.json({ resource: ENDPOINT }));

    await expect(probeLocalCustomerAuthBoundary(ENDPOINT, { fetchFn })).resolves.toMatchObject({
      ok: true,
      resource: ENDPOINT,
      authorizationServers: [],
    });
  });

  it('fails direct OIDC metadata that advertises a different issuer', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('', {
          status: 401,
          headers: { 'www-authenticate': `Bearer resource_metadata="${METADATA}"` },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          resource: ENDPOINT,
          authorization_servers: ['https://other.example.test'],
        }),
      );

    await expect(
      probeLocalCustomerAuthBoundary(ENDPOINT, {
        fetchFn,
        expectedAuthorizationServers: ['https://login.example.test'],
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'authorization_server_mismatch',
      status: 200,
    });
  });

  it('rejects an expected issuer accompanied by an invalid authorization-server entry', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('', {
          status: 401,
          headers: { 'www-authenticate': `Bearer resource_metadata="${METADATA}"` },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          resource: ENDPOINT,
          authorization_servers: ['https://login.example.test', 'not-a-url'],
        }),
      );

    await expect(
      probeLocalCustomerAuthBoundary(ENDPOINT, {
        fetchFn,
        expectedAuthorizationServers: ['https://login.example.test'],
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'metadata_invalid',
      status: 200,
    });
  });

  it('cancels an oversized metadata stream as soon as it crosses the byte limit', async () => {
    let cancelled = false;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(100 * 1024));
        if (pulls === 4) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('', {
          status: 401,
          headers: { 'www-authenticate': `Bearer resource_metadata="${METADATA}"` },
        }),
      )
      .mockResolvedValueOnce(new Response(body, { status: 200 }));

    await expect(probeLocalCustomerAuthBoundary(ENDPOINT, { fetchFn })).resolves.toMatchObject({
      ok: false,
      reason: 'metadata_invalid',
      status: 200,
    });
    expect(cancelled).toBe(true);
  });
});
