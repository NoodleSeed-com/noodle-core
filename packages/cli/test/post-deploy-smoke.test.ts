import { afterEach, describe, expect, it, vi } from 'vitest';
import { runSmoke } from '../../../scripts/post-deploy-smoke.mjs';

afterEach(() => vi.unstubAllGlobals());

describe('post-deploy release convergence smoke', () => {
  it('fails when the service reports a different system release', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith('/v1/service/info')) {
          return Response.json({
            gitSha: 'a'.repeat(40),
            systemRelease: 'r141',
            manifestChecksum: `sha256:${'b'.repeat(64)}`,
          });
        }
        if (url.endsWith('/readyz')) return Response.json({ status: 'ready' });
        if (url.endsWith('/v1/service/capabilities')) {
          return Response.json({
            capabilities: ['observability', 'secrets', 'connectors', 'apps'],
          });
        }
        return Response.json({}, { status: 401 });
      }),
    );

    const result = await runSmoke({
      service: 'https://cloud.example.test',
      expectedSha: 'a'.repeat(40),
      expectedRelease: 'r142',
      expectedManifestChecksum: `sha256:${'b'.repeat(64)}`,
    });
    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(
      expect.objectContaining({ name: 'service/info system release matches deploy', ok: false }),
    );
  });
});
