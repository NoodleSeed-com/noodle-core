import { describe, expect, it, vi } from 'vitest';
import {
  assertBootstrapLaunchAllowed,
  bootstrapLaunchCommand,
  launchBootstrapAgent,
} from '../src/project-bootstrap-launch.js';

describe('explicit fresh coding-agent launch', () => {
  it.each([
    'codex',
    'claude-code',
  ] as const)('starts %s fresh with project-reading instructions, never a resume or permission override', (target) => {
    const command = bootstrapLaunchCommand(target);
    expect(command.command).toBe(target === 'codex' ? 'codex' : 'claude');
    expect(command.args).toHaveLength(1);
    expect(command.args[0]).toContain('AGENTS.md');
    expect(command.args[0]).toContain('Do not read secrets');
    expect(command.args.join(' ')).not.toMatch(/--resume|--continue|--dangerously|--model/);
  });
  it('requires an interactive human terminal and selected generated context', () => {
    expect(() => assertBootstrapLaunchAllowed('codex', ['codex'], false, {}, true)).toThrow(
      /interactive/,
    );
    expect(() => assertBootstrapLaunchAllowed('codex', [], true, {}, true)).toThrow(/context/);
    expect(() => assertBootstrapLaunchAllowed('codex', ['codex'], true, {}, false)).toThrow(
      /verification/,
    );
    expect(() => assertBootstrapLaunchAllowed('none', [], false, {}, false)).not.toThrow();
  });
  it.each([
    { NOODLE_PLUGIN_HOST: 'codex' },
    { CODEX_THREAD_ID: 'active' },
    { CLAUDECODE: '1' },
  ])('does not recursively launch from agent/plugin environments', (env) => {
    expect(() => assertBootstrapLaunchAllowed('codex', ['codex'], true, env, true)).toThrow(
      /running agent/,
    );
  });
  it('propagates a missing executable without installing or exposing process errors', async () => {
    const child = { once: vi.fn() };
    child.once.mockImplementation((event: string, callback: (error: Error) => void) => {
      if (event === 'error') callback(new Error('private-path'));
      return child;
    });
    const spawn = vi.fn(() => child);
    const result = await launchBootstrapAgent('codex', '/project', {}, spawn);
    expect(result).toEqual({ ok: false, code: 'missing_executable' });
    expect(spawn).toHaveBeenCalledWith('codex', expect.any(Array), {
      cwd: '/project',
      env: {},
      stdio: 'inherit',
    });
  });
});
