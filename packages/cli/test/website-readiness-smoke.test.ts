import { describe, expect, it, vi } from 'vitest';
import { checkWebsiteReadiness } from '../../../scripts/website-readiness-smoke.mjs';

describe('website readiness smoke', () => {
  it('accepts configured analytics without reading the public key', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      Response.json(
        {
          status: 'ready',
          analytics: 'configured',
          acquisition: 'configured',
          marketingPhase: 'hosting',
          leadCapture: 'unconfigured',
        },
        { status: 200 },
      ),
    );

    await expect(
      checkWebsiteReadiness(
        'https://website.test',
        { expectedMarketingPhase: 'hosting' },
        fetchImpl,
      ),
    ).resolves.toEqual({
      status: 'ready',
      analytics: 'configured',
      acquisition: 'configured',
      marketingPhase: 'hosting',
      leadCapture: 'unconfigured',
    });
    expect(fetchImpl).toHaveBeenCalledWith('https://website.test/readyz', {
      headers: { accept: 'application/json' },
      signal: expect.any(AbortSignal),
    });
  });

  it('fails generically when a successful response is not JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('<html>proxy error</html>'));

    await expect(
      checkWebsiteReadiness(
        'https://website.test',
        { expectedMarketingPhase: 'hosting' },
        fetchImpl,
        { sleep: async () => undefined },
      ),
    ).rejects.toThrow('website readiness check failed');
  });

  it('fails generically without printing response content or a client key', async () => {
    const key = 'client-never-print-this';
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(`analytics disabled: ${key}`, { status: 503 }));

    await expect(
      checkWebsiteReadiness(
        'https://website.test/',
        { expectedMarketingPhase: 'hosting' },
        fetchImpl,
        { sleep: async () => undefined },
      ),
    ).rejects.toThrow('website readiness check failed');
    try {
      await checkWebsiteReadiness(
        'https://website.test/',
        { expectedMarketingPhase: 'hosting' },
        fetchImpl,
        { sleep: async () => undefined },
      );
    } catch (error) {
      expect(String(error)).not.toContain(key);
    }
  });

  it('retries a not-yet-serving revision, and gives up bounded rather than hanging', async () => {
    // The smoke runs immediately after the deploy returns, against a service that scales to zero.
    // A single attempt turns an ordinary cold start into a red dev gate, and a red dev gate
    // auto-reverts the merge — so a transient must be retried and only a persistent one reported.
    const sleep = vi.fn(async () => undefined);
    const ready = Response.json({
      status: 'ready',
      analytics: 'configured',
      acquisition: 'configured',
      marketingPhase: 'hosting',
      leadCapture: 'unconfigured',
    });
    const coldStart = vi
      .fn()
      .mockRejectedValueOnce(new Error('timed out'))
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(Response.json({ status: 'starting' }))
      .mockResolvedValueOnce(ready);

    await expect(
      checkWebsiteReadiness(
        'https://website.test',
        { expectedMarketingPhase: 'hosting' },
        coldStart,
        { sleep },
      ),
    ).resolves.toMatchObject({ status: 'ready' });
    expect(coldStart).toHaveBeenCalledTimes(4);

    const neverReady = vi.fn().mockRejectedValue(new Error('timed out'));
    await expect(
      checkWebsiteReadiness(
        'https://website.test',
        { expectedMarketingPhase: 'hosting' },
        neverReady,
        { sleep },
      ),
    ).rejects.toThrow('website readiness check failed');
    expect(neverReady.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it('does not retry a served revision whose configuration is wrong', async () => {
    // A ready revision reporting the wrong marketing phase is a misconfiguration. Retrying cannot
    // change it, and spending the whole window before failing only delays the real answer.
    const sleep = vi.fn(async () => undefined);
    const misconfigured = vi.fn().mockResolvedValue(
      Response.json({
        status: 'ready',
        analytics: 'configured',
        acquisition: 'configured',
        marketingPhase: 'hosting',
        leadCapture: 'configured',
      }),
    );

    await expect(
      checkWebsiteReadiness(
        'https://website.test',
        { expectedMarketingPhase: 'consolidated' },
        misconfigured,
        { sleep },
      ),
    ).rejects.toThrow('website readiness check failed');
    expect(misconfigured).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('rejects a stale phase and requires lead capture for consolidated rollout', async () => {
    const stale = vi.fn().mockResolvedValue(
      Response.json({
        status: 'ready',
        analytics: 'configured',
        acquisition: 'configured',
        marketingPhase: 'hosting',
        leadCapture: 'configured',
      }),
    );
    await expect(
      checkWebsiteReadiness(
        'https://website.test',
        { expectedMarketingPhase: 'consolidated' },
        stale,
      ),
    ).rejects.toThrow('website readiness check failed');

    const missingLeadCapture = vi.fn().mockResolvedValue(
      Response.json({
        status: 'ready',
        analytics: 'configured',
        acquisition: 'configured',
        marketingPhase: 'consolidated',
        leadCapture: 'unconfigured',
      }),
    );
    await expect(
      checkWebsiteReadiness(
        'https://website.test',
        { expectedMarketingPhase: 'consolidated' },
        missingLeadCapture,
      ),
    ).rejects.toThrow('website readiness check failed');
  });
});
