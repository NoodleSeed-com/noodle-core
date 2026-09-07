import { describe, expect, it, vi } from 'vitest';
import { deviceOAuthLogin, discoverDeviceAuthorization } from '../src/device-login.js';

const metadata = {
  registrationEndpoint: 'https://svc.example/register',
  tokenEndpoint: 'https://svc.example/token',
  deviceAuthorizationEndpoint: 'https://svc.example/device_authorization',
};

describe('RFC 8628 CLI login', () => {
  it('handles pending and slow-down responses while keeping the printed URL usable', async () => {
    const waits: number[] = [];
    const printed: string[] = [];
    const opened: string[] = [];
    let polls = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const path = new URL(input.toString()).pathname;
      if (path === '/register') return Response.json({ client_id: 'client-1' }, { status: 201 });
      if (path === '/device_authorization') {
        return Response.json({
          device_code: 'device-secret',
          user_code: 'WDJB-MJHT',
          verification_uri: 'https://svc.example/device',
          verification_uri_complete: 'https://svc.example/device?user_code=WDJB-MJHT',
          expires_in: 600,
          interval: 0,
        });
      }
      polls += 1;
      if (polls === 1) throw new Error('temporary network timeout');
      if (polls === 2) return Response.json({ error: 'authorization_pending' }, { status: 400 });
      if (polls === 3) return Response.json({ error: 'slow_down' }, { status: 400 });
      return Response.json({
        access_token: 'access',
        refresh_token: 'refresh',
        expires_in: 3600,
      });
    });

    await expect(
      deviceOAuthLogin({
        issuer: 'https://svc.example',
        resource: 'https://svc.example',
        metadata,
        fetchImpl,
        openBrowser: (url) => opened.push(url),
        print: (line) => printed.push(line),
        wait: (milliseconds) => {
          waits.push(milliseconds);
          return Promise.resolve();
        },
      }),
    ).resolves.toMatchObject({
      clientId: 'client-1',
      accessToken: 'access',
      refreshToken: 'refresh',
    });
    expect(printed.slice(0, 3)).toEqual([
      'Sign in to Noodle Seed',
      'Code WDJB-MJHT',
      'https://svc.example/device?user_code=WDJB-MJHT',
    ]);
    expect(opened).toEqual(['https://svc.example/device?user_code=WDJB-MJHT']);
    expect(waits).toEqual([0, 10_000, 10_000, 15_000]);
  });

  it('falls back only for an omitted endpoint and rejects discovery or issuer failures', async () => {
    await expect(
      discoverDeviceAuthorization({
        issuer: 'https://svc.example',
        fetchImpl: async () => Response.json({ issuer: 'https://svc.example' }),
      }),
    ).resolves.toBeUndefined();
    await expect(
      discoverDeviceAuthorization({
        issuer: 'https://svc.example',
        fetchImpl: async () => Response.json({ error: 'unavailable' }, { status: 503 }),
      }),
    ).rejects.toThrow('metadata discovery failed (503)');
    await expect(
      discoverDeviceAuthorization({
        issuer: 'https://svc.example',
        fetchImpl: async () =>
          Response.json({
            issuer: 'https://attacker.example',
            registration_endpoint: 'https://svc.example/register',
            token_endpoint: 'https://svc.example/token',
            device_authorization_endpoint: 'https://svc.example/device_authorization',
            grant_types_supported: ['urn:ietf:params:oauth:grant-type:device_code'],
          }),
      }),
    ).rejects.toThrow('does not match');
  });
});
