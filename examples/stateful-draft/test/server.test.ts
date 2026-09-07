import { fileURLToPath } from 'node:url';
import { validate } from '@noodleseed/one';
import { describe, expect, it } from 'vitest';
import app from '../src/server.js';

describe('stateful draft onboarding reference', () => {
  it('reads and saves authoritative state instead of a widget-only copy', async () => {
    const manifest = await app.toManifest();
    expect(manifest.tools.find((entry) => entry.name === 'open_draft')?.fulfilment.steps).toEqual([
      expect.objectContaining({ use: 'state.read_state', args: { handle: 'draft' } }),
    ]);
    expect(manifest.tools.find((entry) => entry.name === 'save_draft')).toMatchObject({
      annotations: { readOnlyHint: false, confirm: true },
      fulfilment: {
        steps: [
          expect.objectContaining({
            use: 'state.patch_state',
            args: {
              handle: 'draft',
              expectedRevision: '${input.expectedRevision}',
              value: {
                title: '${input.title}',
                audience: '${input.audience}',
                goal: '${input.goal}',
              },
            },
          }),
        ],
      },
    });
  });

  it('limits anonymous access and transfers only an expiring draft after verified login', async () => {
    const manifest = await app.toManifest();
    expect(manifest.state?.handles.draft).toMatchObject({
      scope: 'caller',
      ttlSeconds: 86400,
      claimOnAuthentication: true,
    });
    expect(manifest.server.assistant?.surfaces?.map((surface) => surface.mode)).toEqual([
      'mixed',
      'authenticated',
    ]);
    const continued = manifest.tools.find((entry) => entry.name === 'continue_draft');
    expect(continued?.annotations?.readOnlyHint).toBe(true);
    expect(continued?.fulfilment.output).toMatchObject({ accountId: '${user.id}' });
    expect(continued?.fulfilment.steps).toEqual([
      expect.objectContaining({ use: 'state.read_state', args: { handle: 'draft' } }),
    ]);
  });

  it('compiles through the public validator, including anonymous action confirmation', async () => {
    const result = await validate({
      manifestPath: fileURLToPath(new URL('../src/server.ts', import.meta.url)),
    });
    expect(result.ok, JSON.stringify(result.ok ? [] : result.errors)).toBe(true);
  });
});
