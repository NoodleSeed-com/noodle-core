import { describe, expect, it } from 'vitest';
import { deployPayloadLimitMessage, MAX_DEPLOY_BODY_BYTES } from '../src/deploy-payload-size.js';

describe('deploy payload sizing', () => {
  it('reports the limit and largest compiled widget contributors', () => {
    const manifest = JSON.stringify({
      widgets: [
        { name: 'small', html: 'x'.repeat(100) },
        { name: 'largest', view: { compiledHtml: 'x'.repeat(1000) } },
      ],
    });
    const body = `${manifest}${'x'.repeat(MAX_DEPLOY_BODY_BYTES)}`;
    expect(deployPayloadLimitMessage(body, manifest)).toMatch(
      /exceeds the service limit 32\.00 MiB; largest widget bundles: largest 0\.00 MiB, small 0\.00 MiB/,
    );
  });

  it('returns no failure below the service limit', () => {
    expect(deployPayloadLimitMessage('{}', '{}')).toBeUndefined();
  });
});
