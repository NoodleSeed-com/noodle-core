import type { DnsLookup } from '@noodle-borg/connector-http';
import { jwtVerify } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import {
  boundArtifact,
  config,
  DEPLOYMENT,
  harness,
  ISSUER,
  request,
  response,
  TENANT,
} from './external-credential-exchange.fixtures.js';

describe('deployment-owned external credential exchange', () => {
  it('uses an allowed HTTPS provider and signs the exact binding workload claims', async () => {
    const artifact = boundArtifact('personal', 'personal_mail');
    const descriptor = request(artifact);
    const guardedFetch = vi.fn(async () => response('personal-token')) as unknown as typeof fetch;
    const { broker, signer } = await harness({
      artifacts: [artifact],
      configs: [config('personal_mail', descriptor.connectionConfigRevision as string)],
      guardedFetch,
    });

    await expect(broker.getCredential(descriptor)).resolves.toEqual({ token: 'personal-token' });
    expect(guardedFetch).toHaveBeenCalledTimes(1);
    const [url, init] = guardedFetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.href).toBe('https://provider.example.test/v1/exchange?private=config');
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual' });
    const body = new URLSearchParams(String(init.body));
    const assertion = body.get('subject_token');
    expect(assertion).toBeTruthy();
    const { payload, protectedHeader } = await jwtVerify(
      assertion as string,
      await signer.verifierKey(),
      { issuer: ISSUER, audience: 'urn:provider:mail', algorithms: ['RS256'] },
    );
    expect(protectedHeader).toMatchObject({ alg: 'RS256', typ: 'JWT' });
    expect(payload).toMatchObject({
      tenant: TENANT,
      deployment: DEPLOYMENT,
      connector_id: 'gmail',
      connector_version: '1.0.0',
      operation: 'search',
      binding_id: 'personal',
      connection_id: 'personal_mail',
      connection_revision: descriptor.connectionConfigRevision,
      profile: 'oauth',
      presentation: { kind: 'bearer' },
      scopes: ['gmail.readonly'],
      requested_audience: 'https://gmail.googleapis.com/',
    });
    expect(body.get('scope')).toBe('gmail.readonly');
    expect(body.get('audience')).toBe('https://gmail.googleapis.com/');
  });

  it('fails before provider lookup or network when the artifact descriptor drifts', async () => {
    const artifact = boundArtifact('personal', 'personal_mail');
    const descriptor = request(artifact);
    const guardedFetch = vi.fn() as unknown as typeof fetch;
    const { broker, providers } = await harness({
      artifacts: [artifact],
      configs: [config('personal_mail', descriptor.connectionConfigRevision as string)],
      guardedFetch,
    });
    const get = vi.spyOn(providers, 'getProviderConfig');
    for (const drift of [
      { requiredScopes: ['gmail.modify'] },
      { requiredAudience: 'https://other.example/' },
      { bindingId: 'work' },
      { connectionConfigRevision: 'sha256:drifted' },
    ]) {
      await expect(broker.getCredential({ ...descriptor, ...drift })).rejects.toMatchObject({
        reason: 'credential_not_configured',
      });
    }
    expect(get).not.toHaveBeenCalled();
    expect(guardedFetch).not.toHaveBeenCalled();
  });

  it('fails closed before network when deployment-owned provider config is absent or mismatched', async () => {
    const artifact = boundArtifact('personal', 'personal_mail');
    const descriptor = request(artifact);
    const guardedFetch = vi.fn() as unknown as typeof fetch;
    const { broker, signer } = await harness({ artifacts: [artifact], guardedFetch });
    const signingKey = vi.spyOn(signer, 'signingKey');
    await expect(broker.getCredential(descriptor)).rejects.toMatchObject({
      reason: 'credential_not_configured',
    });
    expect(guardedFetch).not.toHaveBeenCalled();
    expect(signingKey).not.toHaveBeenCalled();

    const mismatched = await harness({
      artifacts: [artifact],
      configs: [config('personal_mail', 'sha256:other')],
      guardedFetch,
    });
    const mismatchedSigningKey = vi.spyOn(mismatched.signer, 'signingKey');
    await expect(mismatched.broker.getCredential(descriptor)).rejects.toMatchObject({
      reason: 'credential_not_configured',
    });
    expect(guardedFetch).not.toHaveBeenCalled();
    expect(mismatchedSigningKey).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    null,
    {},
    { pinOrVerify: true },
  ])('rejects an unchecked malformed subject-pin port before provider lookup %#', async (subjectPins) => {
    const artifact = boundArtifact('personal', 'personal_mail');
    const descriptor = request(artifact);
    const guardedFetch = vi.fn() as unknown as typeof fetch;
    const instance = await harness({
      artifacts: [artifact],
      configs: [config('personal_mail', descriptor.connectionConfigRevision as string)],
      guardedFetch,
      subjectPins,
    });
    const providerLookup = vi.spyOn(instance.providers, 'getProviderConfig');
    const signingKey = vi.spyOn(instance.signer, 'signingKey');

    await expect(instance.broker.getCredential(descriptor)).rejects.toMatchObject({
      reason: 'credential_not_configured',
    });
    expect(providerLookup).not.toHaveBeenCalled();
    expect(signingKey).not.toHaveBeenCalled();
    expect(guardedFetch).not.toHaveBeenCalled();
  });

  it('reads and binds the subject-pin callable once before provider exchange', async () => {
    let propertyReads = 0;
    let pinCalls = 0;
    const subjectPins = {
      receiver: 'expected-receiver',
      get pinOrVerify() {
        propertyReads += 1;
        if (propertyReads > 1) throw new Error('subject-pin callable read twice');
        return async function (this: { readonly receiver: string }) {
          pinCalls += 1;
          return this.receiver === 'expected-receiver';
        };
      },
    };
    const artifact = boundArtifact('personal', 'personal_mail');
    const descriptor = request(artifact);
    const guardedFetch = vi.fn(async () => response('snapshot-token')) as unknown as typeof fetch;
    const instance = await harness({
      artifacts: [artifact],
      configs: [config('personal_mail', descriptor.connectionConfigRevision as string)],
      guardedFetch,
      subjectPins,
    });

    await expect(instance.broker.getCredential(descriptor)).resolves.toEqual({
      token: 'snapshot-token',
    });
    expect(propertyReads).toBe(1);
    expect(pinCalls).toBe(1);
    expect(guardedFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'HTTP',
      {
        endpoint: 'http://provider.example.test/exchange',
        allowedOrigin: 'http://provider.example.test',
      },
    ],
    ['disallowed origin', { endpoint: 'https://evil.example.test/exchange' }],
    [
      'private IPv4',
      { endpoint: 'https://127.0.0.1/exchange', allowedOrigin: 'https://127.0.0.1' },
    ],
    ['private IPv6', { endpoint: 'https://[::1]/exchange', allowedOrigin: 'https://[::1]' }],
  ])('rejects %s provider configuration before sending an assertion', async (_name, mutation) => {
    const artifact = boundArtifact('personal', 'personal_mail');
    const descriptor = request(artifact);
    const guardedFetch = vi.fn() as unknown as typeof fetch;
    const { broker } = await harness({
      artifacts: [artifact],
      configs: [config('personal_mail', descriptor.connectionConfigRevision as string, mutation)],
      guardedFetch,
    });
    await expect(broker.getCredential(descriptor)).rejects.toMatchObject({
      reason: 'credential_not_configured',
    });
    expect(guardedFetch).not.toHaveBeenCalled();
  });

  it('rejects DNS rebinding to a private address through the shared pinned egress guard', async () => {
    const artifact = boundArtifact('personal', 'personal_mail');
    const descriptor = request(artifact);
    const dnsLookup: DnsLookup = (_hostname, _options, callback) => {
      callback(null, [{ address: '127.0.0.1', family: 4 }]);
    };
    const { broker } = await harness({
      artifacts: [artifact],
      configs: [config('personal_mail', descriptor.connectionConfigRevision as string)],
      dnsLookup,
    });
    await expect(broker.getCredential(descriptor)).rejects.toMatchObject({
      reason: 'credential_exchange_failed',
    });
  });

  it('does not follow redirects and normalizes endpoint failures without leaking private values', async () => {
    const artifact = boundArtifact('personal', 'personal_mail');
    const descriptor = request(artifact);
    const guardedFetch = vi.fn(async () =>
      Response.redirect('https://attacker.example.test/steal', 307),
    ) as unknown as typeof fetch;
    const providerConfig = config('personal_mail', descriptor.connectionConfigRevision as string);
    const { broker } = await harness({
      artifacts: [artifact],
      configs: [providerConfig],
      guardedFetch,
    });
    const error = await broker.getCredential(descriptor).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ reason: 'credential_exchange_failed' });
    expect(guardedFetch).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(error);
    for (const privateValue of [
      'private=config',
      'attacker.example.test',
      'opaque-account-subject',
      'provider-rev-1',
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it.each([
    [{ nope: true }],
    [
      {
        access_token: 'too-long-token',
        token_type: 'Bearer',
        expires_in: 86_400,
        connection_subject: 'opaque-account-subject',
        connection_revision: 'provider-rev-1',
      },
    ],
  ])('rejects malformed or long-lived provider response %#', async (body) => {
    const artifact = boundArtifact('personal', 'personal_mail');
    const descriptor = request(artifact);
    const guardedFetch = vi.fn(async () => Response.json(body)) as unknown as typeof fetch;
    const { broker } = await harness({
      artifacts: [artifact],
      configs: [config('personal_mail', descriptor.connectionConfigRevision as string)],
      guardedFetch,
    });
    const error = await broker.getCredential(descriptor).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ reason: 'credential_exchange_failed' });
    expect(JSON.stringify(error)).not.toContain('too-long-token');
  });

  it('rejects an oversized provider response without parsing or exposing it', async () => {
    const artifact = boundArtifact('personal', 'personal_mail');
    const descriptor = request(artifact);
    const guardedFetch = vi.fn(
      async () => new Response(JSON.stringify({ access_token: 'x'.repeat(70_000) })),
    ) as unknown as typeof fetch;
    const { broker } = await harness({
      artifacts: [artifact],
      configs: [config('personal_mail', descriptor.connectionConfigRevision as string)],
      guardedFetch,
    });
    await expect(broker.getCredential(descriptor)).rejects.toMatchObject({
      reason: 'credential_exchange_failed',
    });
  });

  it('canonicalizes descriptor scopes once before signing and form encoding', async () => {
    const artifact = boundArtifact('personal', 'personal_mail', 'search', [
      'gmail.send',
      'gmail.readonly',
    ]);
    const descriptor = request(artifact);
    const guardedFetch = vi.fn(async () => response('canonical-token')) as unknown as typeof fetch;
    const { broker, signer } = await harness({
      artifacts: [artifact],
      configs: [config('personal_mail', descriptor.connectionConfigRevision as string)],
      guardedFetch,
    });

    await expect(broker.getCredential(descriptor)).resolves.toEqual({ token: 'canonical-token' });
    const [, init] = guardedFetch.mock.calls[0] as unknown as [URL, RequestInit];
    const body = new URLSearchParams(String(init.body));
    expect(body.get('scope')).toBe('gmail.readonly gmail.send');
    const assertion = body.get('subject_token');
    const verified = await jwtVerify(assertion as string, await signer.verifierKey(), {
      issuer: ISSUER,
      audience: 'urn:provider:mail',
      algorithms: ['RS256'],
    });
    expect(verified.payload.scopes).toEqual(['gmail.readonly', 'gmail.send']);
  });

  it('rejects invalid descriptor claims before signing or network access', async () => {
    const aggregateOversizedScopes = Array.from(
      { length: 17 },
      (_, index) => `${String(index).padStart(2, '0')}-${'x'.repeat(509)}`,
    );
    const artifacts = [
      boundArtifact('personal', 'personal_mail', 'search', ['gmail.readonly', 'gmail.readonly']),
      boundArtifact('personal', 'personal_mail', 'search', ['gmail read']),
      boundArtifact('personal', 'personal_mail', 'search', [], 'x'.repeat(513)),
      boundArtifact('personal', 'personal_mail', 'search', [], 'https://gmail.googleapis.com/', {
        kind: 'apiKey',
        header: 'Invalid Header',
      }),
      boundArtifact('personal', 'personal_mail', 'search', aggregateOversizedScopes),
    ];
    for (const artifact of artifacts) {
      const descriptor = request(artifact);
      const guardedFetch = vi.fn() as unknown as typeof fetch;
      const instance = await harness({
        artifacts: [artifact],
        configs: [config('personal_mail', descriptor.connectionConfigRevision as string)],
        guardedFetch,
      });
      const signingKey = vi.spyOn(instance.signer, 'signingKey');
      await expect(instance.broker.getCredential(descriptor)).rejects.toMatchObject({
        reason: 'credential_exchange_failed',
      });
      expect(signingKey).not.toHaveBeenCalled();
      expect(guardedFetch).not.toHaveBeenCalled();
    }
  });

  it('rejects bounded provider assertion config before signing or network access', async () => {
    const artifact = boundArtifact('personal', 'personal_mail');
    const descriptor = request(artifact);
    for (const mutation of [
      { assertionAudience: 'x'.repeat(513) },
      { assertionAudience: ' urn:provider:mail' },
      { configRevision: 'x'.repeat(513) },
      { endpoint: ' https://provider.example.test/v1/exchange' },
      { allowedOrigin: 'https://provider.example.test ' },
    ]) {
      const guardedFetch = vi.fn() as unknown as typeof fetch;
      const instance = await harness({
        artifacts: [artifact],
        configs: [config('personal_mail', descriptor.connectionConfigRevision as string, mutation)],
        guardedFetch,
      });
      const signingKey = vi.spyOn(instance.signer, 'signingKey');
      await expect(instance.broker.getCredential(descriptor)).rejects.toMatchObject({
        reason: 'credential_not_configured',
      });
      expect(signingKey).not.toHaveBeenCalled();
      expect(guardedFetch).not.toHaveBeenCalled();
    }
  });

  it('aborts a provider exchange at the production five-second timeout boundary', async () => {
    const artifact = boundArtifact('personal', 'personal_mail');
    const descriptor = request(artifact);
    const controller = new AbortController();
    const timeoutSignal = vi.fn((_timeoutMs: number) => {
      queueMicrotask(() => controller.abort(new Error('test timeout')));
      return controller.signal;
    });
    const guardedFetch = vi.fn(
      async (_url: URL, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init.signal as AbortSignal;
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    ) as unknown as typeof fetch;
    const { broker } = await harness({
      artifacts: [artifact],
      configs: [config('personal_mail', descriptor.connectionConfigRevision as string)],
      guardedFetch,
      timeoutSignal,
    });

    await expect(broker.getCredential(descriptor)).rejects.toMatchObject({
      reason: 'credential_exchange_failed',
    });
    expect(timeoutSignal).toHaveBeenCalledWith(5_000);
    expect(controller.signal.aborted).toBe(true);
  });
});
