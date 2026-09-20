import { afterAll, describe, expect, it } from 'vitest';
import { DraftArtifactChecker } from '../dist/application-drafts/artifact-checker.js';

const checker = new DraftArtifactChecker();
afterAll(() => checker.close());
const manifest = {
  manifestVersion: '2',
  server: { name: 'welcome', version: '1.0.0', title: 'Welcome' },
  tools: [
    {
      name: 'hello',
      description: 'Say hello',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      fulfilment: { steps: [], output: { message: 'hello' } },
    },
  ],
};

describe('trusted draft artifact worker', () => {
  it('validates plain compiler input without a host-file root or an execution port', async () => {
    await expect(
      checker.check({ manifest: JSON.stringify(manifest) }, 10_000),
    ).resolves.toMatchObject({ ok: true });
  });

  it('rejects hostile setting patterns without blocking the host event loop', async () => {
    const hostile = {
      ...manifest,
      server: {
        ...manifest.server,
        variables: [
          {
            name: 'PATTERN',
            schemaVersion: 1,
            valueSchema: { type: 'string', pattern: '^(a+)+$' },
            default: `${'a'.repeat(40)}!`,
            requiredFor: [],
          },
        ],
      },
    };
    let ticked = false;
    const pending = checker.check({ manifest: JSON.stringify(hostile) }, 10_000);
    const tick = new Promise<void>((resolve) =>
      setTimeout(() => {
        ticked = true;
        resolve();
      }, 10),
    );
    await expect(pending).resolves.toMatchObject({
      ok: false,
      issues: [{ code: 'invalid_variable_declaration' }, { code: 'invalid_variable_declaration' }],
    });
    expect(ticked).toBe(true);
    await tick;
    await expect(
      checker.check({ manifest: JSON.stringify(manifest) }, 10_000),
    ).resolves.toMatchObject({ ok: true });
  });

  it('enforces the worker deadline and recovers admission', async () => {
    await expect(checker.check({ manifest: JSON.stringify(manifest) }, 1)).resolves.toMatchObject({
      ok: false,
      issues: [{ code: 'timeout' }],
    });
    await expect(
      checker.check({ manifest: JSON.stringify(manifest) }, 10_000),
    ).resolves.toMatchObject({ ok: true });
  });

  it('closes pending work and rejects admission after shutdown', async () => {
    const closing = new DraftArtifactChecker();
    const pending = expect(
      closing.check({ manifest: JSON.stringify(manifest) }, 10_000),
    ).rejects.toMatchObject({ code: 'unavailable' });
    await closing.close();
    await pending;
    await expect(
      closing.check({ manifest: JSON.stringify(manifest) }, 10_000),
    ).rejects.toMatchObject({ code: 'unavailable' });
  });
});
