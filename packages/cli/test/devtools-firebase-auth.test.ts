import { describe, expect, it, vi } from 'vitest';
import { FirebaseDevtoolsAuthDriver } from '../src/devtools-firebase-auth.js';

const resource = 'http://127.0.0.1:4311/o/local/firebase/dev/mcp';
const redirectUri = 'http://127.0.0.1:4312/auth/callback/random-callback';

describe('Firebase Devtools auth driver', () => {
  it('builds the configured Firebase UI request with an exact dynamic loopback callback', () => {
    const driver = createDriver();

    const pending = driver.beginAuthorization();
    const authorize = new URL(pending.authorizationUrl);

    expect(authorize.origin + authorize.pathname).toBe('https://auth.example.test/firebase');
    expect(authorize.searchParams.get('state')).toBe('firebase-state-123');
    expect(authorize.searchParams.get('redirect_uri')).toBe(redirectUri);
    expect(authorize.searchParams.get('resource')).toBe(resource);
    expect(authorize.searchParams.get('provider')).toBe('firebase');
    expect(authorize.searchParams.get('project_id')).toBe('firebase-project');
    expect(authorize.searchParams.get('tenant_id')).toBe('tenant-one');
    expect(pending).toMatchObject({ state: 'firebase-state-123', expiresAt: 1_600_000 });
  });

  it('accepts a bounded form-post token once and refreshes it through Firebase securetoken', async () => {
    const fetchFn = vi.fn(async () =>
      Response.json({
        id_token: 'refreshed-firebase-id-token',
        refresh_token: 'rotated-firebase-refresh-token',
        expires_in: '3600',
      }),
    );
    const driver = createDriver({ fetchFn });
    const pending = driver.beginAuthorization();

    const tokens = await driver.completeAuthorization(pending, {
      state: pending.state,
      idToken: 'firebase-id-token',
      refreshToken: 'firebase-refresh-token',
      expiresIn: 120,
    });
    expect(tokens).toEqual({
      accessToken: 'firebase-id-token',
      refreshToken: 'firebase-refresh-token',
      tokenType: 'Bearer',
      expiresAt: 1_120_000,
      scope: [],
    });

    await expect(driver.refresh(tokens)).resolves.toEqual({
      accessToken: 'refreshed-firebase-id-token',
      refreshToken: 'rotated-firebase-refresh-token',
      tokenType: 'Bearer',
      expiresAt: 4_600_000,
      scope: [],
    });
    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe('https://securetoken.googleapis.com/v1/token?key=public-web-key');
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: expect.objectContaining({
        'content-type': 'application/x-www-form-urlencoded',
      }),
      body: 'grant_type=refresh_token&refresh_token=firebase-refresh-token',
    });
  });

  it('rejects expired state, oversized tokens, and non-loopback insecure custom UIs', async () => {
    const driver = createDriver({ now: () => 2_000_000 });
    const pending = driver.beginAuthorization();

    await expect(
      driver.completeAuthorization(
        { ...pending, expiresAt: 1_999_999 },
        {
          state: pending.state,
          idToken: 'firebase-id-token',
        },
      ),
    ).rejects.toThrow(/expired/i);
    await expect(
      driver.completeAuthorization(pending, {
        state: pending.state,
        idToken: 'x'.repeat(65_537),
      }),
    ).rejects.toThrow(/too large/i);

    const insecure = new FirebaseDevtoolsAuthDriver({
      resource,
      redirectUri,
      auth: {
        kind: 'firebase',
        projectId: 'firebase-project',
        apiKey: 'public-web-key',
        authorizeUrl: 'http://auth.example.test/firebase',
      },
      stateFactory: () => 'firebase-state-123',
    });
    expect(() => insecure.beginAuthorization()).toThrow(/HTTPS/i);
  });

  it('bounds Firebase refresh responses before parsing them', async () => {
    const driver = createDriver({
      fetchFn: vi.fn(async () => new Response('x'.repeat(65_537), { status: 200 })),
    });

    await expect(
      driver.refresh({
        accessToken: 'firebase-id-token',
        refreshToken: 'firebase-refresh-token',
        tokenType: 'Bearer',
        scope: [],
      }),
    ).rejects.toThrow(/response is too large/i);
  });

  it('renders the local Firebase page with public web config but no callback credential', () => {
    const driver = new FirebaseDevtoolsAuthDriver({
      resource,
      redirectUri,
      auth: {
        kind: 'firebase',
        projectId: 'firebase-project',
        apiKey: 'public-web-key',
        authDomain: 'firebase-project.firebaseapp.com',
        appId: 'app-id',
      },
      stateFactory: () => 'firebase-state-123',
      now: () => 1_000_000,
    });
    const pending = driver.beginAuthorization();
    const page = driver.renderAuthorizationPage(new URL(pending.authorizationUrl), pending);

    expect(page?.status).toBe(200);
    expect(page?.html).toContain('Continue with Google');
    expect(page?.html).toContain('public-web-key');
    expect(page?.html).toContain('firebase-project.firebaseapp.com');
    expect(page?.html).toContain(redirectUri);
    expect(page?.html).toContain('http-equiv="Content-Security-Policy"');
    expect(page?.html).toContain('https://www.gstatic.com');
    expect(page?.html).toContain('https://apis.google.com');
    expect(page?.html).toContain('https://identitytoolkit.googleapis.com');
    expect(page?.html).toContain('https://securetoken.googleapis.com');
    expect(page?.html).toContain('frame-src https://firebase-project.firebaseapp.com');
    expect(page?.html).toContain('form-action http://127.0.0.1:4312');
    expect(page?.html).toMatch(/script-src &#39;nonce-[^']+&#39;/u);
    expect(page?.html).not.toContain('unsafe-inline');
    expect(page?.html).not.toMatch(/id_token[^>]+value=["'][^"']+/u);
  });
});

function createDriver(
  options: { readonly fetchFn?: typeof fetch; readonly now?: () => number } = {},
): FirebaseDevtoolsAuthDriver {
  return new FirebaseDevtoolsAuthDriver({
    resource,
    redirectUri,
    auth: {
      kind: 'firebase',
      projectId: 'firebase-project',
      apiKey: 'public-web-key',
      authDomain: 'firebase-project.firebaseapp.com',
      appId: 'app-id',
      tenantId: 'tenant-one',
      authorizeUrl: 'https://auth.example.test/firebase',
    },
    stateFactory: () => 'firebase-state-123',
    now: options.now ?? (() => 1_000_000),
    ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
  });
}
