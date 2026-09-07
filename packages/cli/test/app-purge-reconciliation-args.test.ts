import { describe, expect, it } from 'vitest';
import { parseAppPurgeReconciliationArgs } from '../src/commands/app-purge-reconciliation-args.js';

const SHA = 'a'.repeat(40);
const OUTPUT = '/tmp/noodle-app-purge-preview.json';
const APPROVED_PREVIEW = '/tmp/noodle-app-purge-approved.json';

describe('app purge reconciliation arguments', () => {
  it('parses the exact preview grammar', () => {
    expect(
      parseAppPurgeReconciliationArgs([
        'preview',
        '--output',
        OUTPUT,
        '--service',
        'https://svc.example',
        '--auth-token',
        'private-token',
        '--json',
      ]),
    ).toEqual({
      ok: true,
      args: {
        action: 'preview',
        output: OUTPUT,
        service: 'https://svc.example',
        authToken: 'private-token',
        json: true,
      },
    });
  });

  it('parses the exact confirmed apply grammar after wire validation', () => {
    expect(parseAppPurgeReconciliationArgs(validApplyArgs())).toEqual({
      ok: true,
      args: {
        action: 'apply',
        approvedPreview: APPROVED_PREVIEW,
        releaseSha: SHA,
        approvalReference: 'change-123',
        recoveryCheckpoint: 'pitr-456',
        reason: 'Remove reviewed stranded anchors',
        idempotencyKey: 'private-operation-key',
        yes: true,
        json: false,
      },
    });
  });

  it.each([
    [[]],
    [['preview']],
    [['preview', '--output', 'relative.json']],
    [['preview', '--output', OUTPUT, '--output', OUTPUT]],
    [['preview', '--output', OUTPUT, '--yes']],
    [['preview', '--output']],
    [['preview', '--output', OUTPUT, '--json', '--json']],
    [['unknown', '--output', OUTPUT]],
  ])('rejects an invalid preview invocation without exposing values: %j', (args) => {
    const parsed = parseAppPurgeReconciliationArgs(args);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('expected a usage failure');
    expect(parsed.error).toMatchObject({ code: 'usage', exitCode: 2 });
    expect(JSON.stringify(parsed.error)).not.toContain(OUTPUT);
  });

  it.each([
    '--approved-preview',
    '--release-sha',
    '--approval-reference',
    '--recovery-checkpoint',
    '--reason',
    '--idempotency-key',
    '--yes',
  ])('requires apply evidence flag %s', (missing) => {
    const args = validApplyArgs().filter((value, index, values) =>
      missing === '--yes' ? value !== '--yes' : value !== missing && values[index - 1] !== missing,
    );
    expect(parseAppPurgeReconciliationArgs(args)).toMatchObject({
      ok: false,
      error: { code: 'usage', exitCode: 2 },
    });
  });

  it.each([
    ['relative preview path', replaceValue(validApplyArgs(), '--approved-preview', 'preview.json')],
    ['invalid release SHA', replaceValue(validApplyArgs(), '--release-sha', 'not-a-sha')],
    ['short idempotency key', replaceValue(validApplyArgs(), '--idempotency-key', 'short')],
    [
      'oversized approval reference',
      replaceValue(validApplyArgs(), '--approval-reference', 'x'.repeat(257)),
    ],
    [
      'oversized recovery checkpoint',
      replaceValue(validApplyArgs(), '--recovery-checkpoint', 'x'.repeat(257)),
    ],
    ['oversized reason', replaceValue(validApplyArgs(), '--reason', 'x'.repeat(501))],
    ['duplicate value flag', [...validApplyArgs(), '--reason', 'another']],
    ['duplicate confirmation', [...validApplyArgs(), '--yes']],
    ['unknown flag', [...validApplyArgs(), '--unknown']],
  ])('rejects %s without echoing private evidence', (_name, args) => {
    const parsed = parseAppPurgeReconciliationArgs(args);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('expected a usage failure');
    const serialized = JSON.stringify(parsed.error);
    for (const privateValue of [
      'change-123',
      'pitr-456',
      'Remove reviewed stranded anchors',
      'private-operation-key',
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });
});

function validApplyArgs(): string[] {
  return [
    'apply',
    '--approved-preview',
    APPROVED_PREVIEW,
    '--release-sha',
    SHA,
    '--approval-reference',
    'change-123',
    '--recovery-checkpoint',
    'pitr-456',
    '--reason',
    'Remove reviewed stranded anchors',
    '--idempotency-key',
    'private-operation-key',
    '--yes',
  ];
}

function replaceValue(args: string[], flag: string, value: string): string[] {
  const result = [...args];
  const index = result.indexOf(flag);
  result[index + 1] = value;
  return result;
}
