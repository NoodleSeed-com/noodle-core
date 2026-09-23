import { afterAll, describe, expect, it } from 'vitest';
import { SANDBOX_AUTHORING_LIMITS, SandboxedAuthoringLoader } from '../dist/sandbox-authoring.js';

const loader = new SandboxedAuthoringLoader();
afterAll(() => loader.close());

const source = `import { server, tool, z } from '@noodleseed/one';
export default server('welcome', { version: '1.0.0', title: 'Welcome' }, [
  tool('greet', { description: 'Greet a visitor', input: z.object({ name: z.string() }),
    fulfil: async (ctx) => ({ message: ctx.input.name }) })
]);`;

describe('isolated canonical TypeScript authoring', () => {
  it('snapshots input and isolates globals across builds', async () => {
    const files = { 'server.ts': `globalThis.customerMarker = 'private'; ${source}` };
    const pending = loader.load({ entrypoint: 'server.ts', files });
    files['server.ts'] = 'throw new Error("mutated")';
    await expect(pending).resolves.toHaveProperty('manifest');
    await expect(
      loader.load({
        entrypoint: 'server.ts',
        files: {
          'server.ts': `if ('customerMarker' in globalThis) throw new Error('leak'); ${source}`,
        },
      }),
    ).resolves.toHaveProperty('manifest');
  });

  it('admits at most two builds without an unbounded queue', async () => {
    const input = { entrypoint: 'server.ts', files: { 'server.ts': source } };
    const first = loader.load(input),
      second = loader.load(input);
    await expect(loader.load(input)).rejects.toMatchObject({ code: 'busy' });
    await Promise.all([first, second]);
  });

  it('bounds nonterminating source without blocking the host event loop', async () => {
    const bounded = new SandboxedAuthoringLoader({ timeoutMs: 8000 });
    try {
      const pending = bounded.load({
        entrypoint: 'server.ts',
        files: { 'server.ts': `while (true) {} ${source}` },
      });
      let ticked = false;
      const tick = new Promise<void>((resolve) =>
        setTimeout(() => {
          ticked = true;
          resolve();
        }, 10),
      );
      await expect(pending).rejects.toMatchObject({ code: 'timeout' });
      expect(ticked).toBe(true);
      await tick;
      await expect(
        bounded.load({ entrypoint: 'server.ts', files: { 'server.ts': source } }),
      ).resolves.toHaveProperty('manifest');
    } finally {
      await bounded.close();
    }
  }, 30_000);

  it.each([
    { limits: { memoryBytes: 4 * 1024 * 1024 }, code: 'memory' },
    { limits: { maxOutputBytes: 32 }, code: 'output_limit' },
  ])('enforces $code', async ({ limits, code }) => {
    const bounded = new SandboxedAuthoringLoader(limits);
    try {
      await expect(
        bounded.load({ entrypoint: 'server.ts', files: { 'server.ts': source } }),
      ).rejects.toMatchObject({ code });
    } finally {
      await bounded.close();
    }
  });

  it('redacts arbitrary thrown text and disallows host operations', async () => {
    const privateText = 'customer-private-value';
    await expect(
      loader.load({
        entrypoint: 'server.ts',
        files: { 'server.ts': `throw new Error(${JSON.stringify(privateText)}); ${source}` },
      }),
    ).rejects.toMatchObject({ code: 'invalid_source', message: 'invalid_source' });
    await expect(
      loader.load({
        entrypoint: 'server.ts',
        files: { 'server.ts': `callOperation('records.submitRecord', {}); ${source}` },
      }),
    ).rejects.toThrow();
  });

  it('closes admission even during preparation and permits only lowered limits', async () => {
    for (const key of ['timeoutMs', 'memoryBytes', 'maxOutputBytes'] as const) {
      expect(
        () => new SandboxedAuthoringLoader({ [key]: SANDBOX_AUTHORING_LIMITS[key] + 1 }),
      ).toThrow();
      expect(() => new SandboxedAuthoringLoader({ [key]: 0 })).toThrow();
    }
    const closed = new SandboxedAuthoringLoader();
    const pending = expect(
      closed.load({ entrypoint: 'server.ts', files: { 'server.ts': source } }),
    ).rejects.toThrow();
    await closed.close();
    await pending;
    await expect(
      closed.load({ entrypoint: 'server.ts', files: { 'server.ts': source } }),
    ).rejects.toMatchObject({ code: 'closed' });
    await closed.close();
  });
});
