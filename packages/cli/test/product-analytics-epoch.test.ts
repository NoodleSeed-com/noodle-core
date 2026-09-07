import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'scripts',
  'product-analytics-epoch.mjs',
);

function epoch(runId: string, runAttempt: string, phase: string): string {
  return execFileSync(
    process.execPath,
    [script, '--run-id', runId, '--run-attempt', runAttempt, '--phase', phase],
    { encoding: 'utf8' },
  ).trim();
}

describe('private product analytics rollout epoch', () => {
  it('orders phases, retries, and later workflow runs monotonically with decimal digits only', () => {
    const development = epoch('9001', '2', 'development');
    const staging = epoch('9001', '2', 'staging');
    const production = epoch('9001', '2', 'production');
    const rollback = epoch('9001', '2', 'rollback');
    const retry = epoch('9001', '3', 'development');
    const laterRun = epoch('9002', '1', 'development');

    expect([development, staging, production, rollback]).toEqual([
      '9001000021',
      '9001000022',
      '9001000023',
      '9001000024',
    ]);
    expect(BigInt(staging)).toBeGreaterThan(BigInt(development));
    expect(BigInt(production)).toBeGreaterThan(BigInt(staging));
    expect(BigInt(rollback)).toBeGreaterThan(BigInt(production));
    expect(BigInt(retry)).toBeGreaterThan(BigInt(rollback));
    expect(BigInt(laterRun)).toBeGreaterThan(BigInt(retry));
    expect(laterRun).toMatch(/^[1-9][0-9]*$/);
  });

  it.each([
    ['0', '1', 'development'],
    ['01', '1', 'development'],
    ['run', '1', 'development'],
    ['1', '0', 'development'],
    ['1', '100000', 'development'],
    ['1', '1', 'preview'],
  ])('rejects an invalid run identity or phase: %s/%s/%s', (runId, runAttempt, phase) => {
    expect(() => epoch(runId, runAttempt, phase)).toThrow();
  });
});
