import { isAbsolute } from 'node:path';
import { AppPurgeReconciliationApplyRequestSchema } from '@noodle-borg/wire-contracts';
import { EXIT } from './output.js';
import type { CliFailure } from './shared.js';

export type AppPurgeReconciliationArgs =
  | {
      readonly action: 'preview';
      readonly output: string;
      readonly service?: string;
      readonly authToken?: string;
      readonly json: boolean;
    }
  | {
      readonly action: 'apply';
      readonly approvedPreview: string;
      readonly releaseSha: string;
      readonly approvalReference: string;
      readonly recoveryCheckpoint: string;
      readonly reason: string;
      readonly idempotencyKey: string;
      readonly yes: true;
      readonly service?: string;
      readonly authToken?: string;
      readonly json: boolean;
    };

interface ParsedFlags {
  readonly values: ReadonlyMap<string, string>;
  readonly json: boolean;
  readonly yes: boolean;
}

const APPLY_EVIDENCE_SCHEMA = AppPurgeReconciliationApplyRequestSchema.pick({
  releaseSha: true,
  approvalReference: true,
  recoveryCheckpoint: true,
  reason: true,
  idempotencyKey: true,
  confirmed: true,
});

export function parseAppPurgeReconciliationArgs(
  rest: readonly string[],
):
  | { readonly ok: true; readonly args: AppPurgeReconciliationArgs }
  | { readonly ok: false; readonly error: CliFailure } {
  const action = rest[0];
  if (action !== 'preview' && action !== 'apply') {
    return failure('app-purge requires preview or apply');
  }
  const parsed = parseFlags(rest.slice(1), action);
  if (!parsed.ok) return parsed;
  const common = {
    ...(parsed.flags.values.has('--service')
      ? { service: parsed.flags.values.get('--service') as string }
      : {}),
    ...(parsed.flags.values.has('--auth-token')
      ? { authToken: parsed.flags.values.get('--auth-token') as string }
      : {}),
    json: parsed.flags.json,
  };
  if (action === 'preview') {
    const output = parsed.flags.values.get('--output');
    if (output === undefined || !isAbsolute(output)) {
      return failure('--output must be an absolute path');
    }
    return { ok: true, args: { action, output, ...common } };
  }
  if (!parsed.flags.yes) return failure('--yes is required for apply');
  const approvedPreview = parsed.flags.values.get('--approved-preview');
  if (approvedPreview === undefined || !isAbsolute(approvedPreview)) {
    return failure('--approved-preview must be an absolute path');
  }
  const evidence = APPLY_EVIDENCE_SCHEMA.safeParse({
    releaseSha: parsed.flags.values.get('--release-sha'),
    approvalReference: parsed.flags.values.get('--approval-reference'),
    recoveryCheckpoint: parsed.flags.values.get('--recovery-checkpoint'),
    reason: parsed.flags.values.get('--reason'),
    idempotencyKey: parsed.flags.values.get('--idempotency-key'),
    confirmed: true,
  });
  if (!evidence.success) return failure('apply evidence is missing or invalid');
  return {
    ok: true,
    args: {
      action,
      approvedPreview,
      releaseSha: evidence.data.releaseSha,
      approvalReference: evidence.data.approvalReference,
      recoveryCheckpoint: evidence.data.recoveryCheckpoint,
      reason: evidence.data.reason,
      idempotencyKey: evidence.data.idempotencyKey,
      yes: true,
      ...common,
    },
  };
}

function parseFlags(
  rest: readonly string[],
  action: 'preview' | 'apply',
):
  | { readonly ok: true; readonly flags: ParsedFlags }
  | { readonly ok: false; readonly error: CliFailure } {
  const allowed =
    action === 'preview'
      ? new Set(['--output', '--service', '--auth-token'])
      : new Set([
          '--approved-preview',
          '--release-sha',
          '--approval-reference',
          '--recovery-checkpoint',
          '--reason',
          '--idempotency-key',
          '--service',
          '--auth-token',
        ]);
  const values = new Map<string, string>();
  let json = false;
  let yes = false;
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    if (flag === '--json') {
      if (json) return failure('--json may be supplied once');
      json = true;
      continue;
    }
    if (flag === '--yes' && action === 'apply') {
      if (yes) return failure('--yes may be supplied once');
      yes = true;
      continue;
    }
    if (flag === undefined || !allowed.has(flag)) {
      return failure('unknown or inapplicable argument');
    }
    const value = rest[index + 1];
    if (value === undefined || value.length === 0 || value.startsWith('--')) {
      return failure(`a value for ${flag} is required`);
    }
    if (values.has(flag)) return failure(`${flag} may be supplied once`);
    values.set(flag, value);
    index++;
  }
  return { ok: true, flags: { values, json, yes } };
}

function failure(message: string): { readonly ok: false; readonly error: CliFailure } {
  return {
    ok: false,
    error: {
      code: 'usage',
      message,
      cause: 'The service app-purge command or one of its arguments is invalid.',
      fix: 'Use a fresh preview artifact and provide every required apply evidence flag.',
      next: 'noodle service app-purge preview --output <absolute-path>',
      exitCode: EXIT.USAGE,
    },
  };
}
