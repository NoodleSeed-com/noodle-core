import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the local compiler so we can drive `runValidate --json` with an exact error shape without a real
// project on disk. The behavior under test is purely the failure-envelope branch that maps a missing
// build-dependency `read_error` (e.g. Vite for React widget bundling) to the exact dependency-add command.
// Keep the real `isMissingDependencyError` (author-loop imports it from here) — only `validate` is stubbed.
vi.mock('../src/validate.js', async (importActual) => ({
  ...(await importActual<typeof import('../src/validate.js')>()),
  validate: vi.fn(),
}));

import { runValidate } from '../src/commands/author-loop.js';
import { validate } from '../src/validate.js';

function lastEnvelope(logSpy: ReturnType<typeof vi.spyOn>): {
  ok: boolean;
  error: { code: string; message: string; fix?: string; next?: string };
} {
  return JSON.parse(logSpy.mock.calls.at(-1)?.[0] as string);
}

describe('validate --json — missing build dependency', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps a missing-Vite read_error to the exact Vite install step', async () => {
    vi.mocked(validate).mockResolvedValue({
      ok: false,
      stage: 'read',
      errors: [
        {
          code: 'read_error',
          path: '',
          // The exact message thrown from react-widget-build.ts when Vite is not installed.
          message:
            'React widget bundling requires Vite in your project. Install it with `npm install --save-dev vite`, then retry the deploy.',
        },
      ],
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runValidate(['/tmp/widget-project/src/server.ts', '--json']);
    expect(code).toBe(1);
    const envelope = lastEnvelope(logSpy);
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('validation_failed');
    expect(envelope.error.next).toBe('npm install --save-dev vite');
    expect(envelope.error.fix).toContain('npm install --save-dev vite');
  });

  it('does not map an unrelated missing dependency to Vite', async () => {
    vi.mocked(validate).mockResolvedValue({
      ok: false,
      stage: 'read',
      errors: [
        {
          code: 'read_error',
          path: '',
          message: 'Connector package is missing. Run `npm install @example/connector`.',
        },
      ],
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runValidate(['/tmp/widget-project/src/server.ts', '--json']);
    expect(code).toBe(1);
    const envelope = lastEnvelope(logSpy);
    expect(envelope.error.next).toBe('noodle validate --fix-prompt');
    expect(envelope.error.fix).not.toContain('vite');
  });

  it('keeps the generic `--fix-prompt` next step for ordinary validation errors', async () => {
    vi.mocked(validate).mockResolvedValue({
      ok: false,
      stage: 'manifest',
      errors: [{ code: 'invalid_type', path: 'tools.0.name', message: 'expected string' }],
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runValidate(['/tmp/widget-project/src/server.ts', '--json']);
    expect(code).toBe(1);
    const envelope = lastEnvelope(logSpy);
    expect(envelope.error.next).toBe('noodle validate --fix-prompt');
    expect(envelope.error.fix).toContain('Fix each error at its `path`');
  });
});
