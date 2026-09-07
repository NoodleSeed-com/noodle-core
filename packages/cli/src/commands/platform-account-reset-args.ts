import {
  PlatformAccountResetExecuteRequestSchema,
  PlatformAccountResetOperationIdSchema,
} from '@noodle-borg/wire-contracts';
import { EXIT } from './output.js';
import { nonnegativeInteger } from './platform-auth-migration-args.js';
import type { CliFailure } from './shared.js';

type Action = 'preview' | 'status' | 'quarantine' | 'rollback' | 'finalize';
type PreviewOperation = 'quarantine' | 'rollback' | 'finalize';

interface CommonArgs {
  readonly action: Action;
  readonly service?: string;
  readonly authToken?: string;
  readonly json: boolean;
}

interface MutationEvidence {
  readonly operationId: string;
  readonly expectedGeneration: number;
  readonly releaseSha: string;
  readonly previewChecksum: string;
  readonly idempotencyKey: string;
  readonly reason: string;
  readonly yes: true;
}

export type PlatformAccountResetArgs =
  | (CommonArgs & {
      readonly action: 'preview';
      readonly operation: 'quarantine';
      readonly targetFile: string;
    })
  | (CommonArgs & {
      readonly action: 'preview';
      readonly operation: 'rollback' | 'finalize';
      readonly operationId: string;
    })
  | (CommonArgs & { readonly action: 'status'; readonly operationId: string })
  | (CommonArgs & MutationEvidence & { readonly action: 'quarantine' | 'rollback' | 'finalize' });

interface ParsedFlags {
  readonly values: ReadonlyMap<string, string>;
  readonly json: boolean;
  readonly yes: boolean;
}

export function parsePlatformAccountResetArgs(
  rest: readonly string[],
):
  | { readonly ok: true; readonly args: PlatformAccountResetArgs }
  | { readonly ok: false; readonly error: CliFailure } {
  if (rest[0] !== 'account-reset')
    return { ok: false, error: usage('platform-auth requires account-reset') };
  const action = rest[1];
  if (!isAction(action)) {
    return {
      ok: false,
      error: usage('account-reset requires preview, status, quarantine, rollback, or finalize'),
    };
  }
  const parsed = parseFlags(rest.slice(2), allowedFlags(action), isMutation(action));
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
  if (action === 'preview') return parsePreview(common, parsed.flags);
  const operationId = parseOperationId(parsed.flags.values.get('--operation-id'));
  if (!operationId.ok) return operationId;
  if (action === 'status')
    return { ok: true, args: { ...common, action, operationId: operationId.value } };
  return parseMutation({ ...common, action }, operationId.value, parsed.flags);
}

function parsePreview(
  common: Omit<CommonArgs, 'action'>,
  flags: ParsedFlags,
):
  | { readonly ok: true; readonly args: PlatformAccountResetArgs }
  | { readonly ok: false; readonly error: CliFailure } {
  const operation = flags.values.get('--operation');
  if (!isPreviewOperation(operation)) {
    return { ok: false, error: usage('--operation must be quarantine, rollback, or finalize') };
  }
  if (operation === 'quarantine') {
    const targetFile = flags.values.get('--target-file');
    if (flags.values.has('--operation-id')) {
      return { ok: false, error: usage('--operation-id does not apply to a quarantine preview') };
    }
    return targetFile === undefined
      ? { ok: false, error: usage('--target-file is required for a quarantine preview') }
      : { ok: true, args: { ...common, action: 'preview', operation, targetFile } };
  }
  if (flags.values.has('--target-file')) {
    return { ok: false, error: usage('--target-file applies only to a quarantine preview') };
  }
  const operationId = parseOperationId(flags.values.get('--operation-id'));
  return operationId.ok
    ? {
        ok: true,
        args: { ...common, action: 'preview', operation, operationId: operationId.value },
      }
    : operationId;
}

function parseMutation(
  common: Omit<CommonArgs, 'action'> & { readonly action: 'quarantine' | 'rollback' | 'finalize' },
  operationId: string,
  flags: ParsedFlags,
):
  | { readonly ok: true; readonly args: PlatformAccountResetArgs }
  | { readonly ok: false; readonly error: CliFailure } {
  if (!flags.yes) return { ok: false, error: usage('--yes is required for a mutation') };
  const expectedGeneration = nonnegativeInteger(flags.values.get('--expected-generation'));
  if (expectedGeneration === undefined) {
    return { ok: false, error: usage('--expected-generation must be a non-negative integer') };
  }
  const releaseSha = flags.values.get('--release-sha');
  const previewChecksum = flags.values.get('--preview-checksum');
  const idempotencyKey = flags.values.get('--idempotency-key');
  const reason = flags.values.get('--reason');
  const validated = PlatformAccountResetExecuteRequestSchema.safeParse({
    schemaVersion: 1,
    action: common.action,
    operationId,
    expectedGeneration,
    releaseSha,
    previewChecksum,
    idempotencyKey,
    reason,
    confirmed: true,
  });
  if (!validated.success) return { ok: false, error: usage('mutation evidence is invalid') };
  return {
    ok: true,
    args: {
      ...common,
      operationId,
      expectedGeneration,
      releaseSha: validated.data.releaseSha,
      previewChecksum: validated.data.previewChecksum,
      idempotencyKey: validated.data.idempotencyKey,
      reason: validated.data.reason,
      yes: true,
    },
  };
}

function parseFlags(
  rest: readonly string[],
  allowed: ReadonlySet<string>,
  allowYes: boolean,
):
  | { readonly ok: true; readonly flags: ParsedFlags }
  | { readonly ok: false; readonly error: CliFailure } {
  const values = new Map<string, string>();
  let json = false;
  let yes = false;
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    if (flag === '--json') {
      if (json) return { ok: false, error: usage('--json may be supplied once') };
      json = true;
      continue;
    }
    if (flag === '--yes' && allowYes) {
      if (yes) return { ok: false, error: usage('--yes may be supplied once') };
      yes = true;
      continue;
    }
    if (flag === undefined || !allowed.has(flag)) {
      return { ok: false, error: usage('unknown or inapplicable argument') };
    }
    const value = rest[index + 1];
    if (value === undefined || value.length === 0 || value.startsWith('--')) {
      return { ok: false, error: usage(`a value for ${flag} is required`) };
    }
    if (values.has(flag)) return { ok: false, error: usage(`${flag} may be supplied once`) };
    values.set(flag, value);
    index++;
  }
  return { ok: true, flags: { values, json, yes } };
}

function allowedFlags(action: Action): ReadonlySet<string> {
  const allowed = new Set(['--service', '--auth-token']);
  if (action === 'preview') {
    allowed.add('--operation');
    allowed.add('--target-file');
    allowed.add('--operation-id');
  } else {
    allowed.add('--operation-id');
  }
  if (isMutation(action)) {
    for (const flag of [
      '--expected-generation',
      '--release-sha',
      '--preview-checksum',
      '--idempotency-key',
      '--reason',
    ])
      allowed.add(flag);
  }
  return allowed;
}

function parseOperationId(
  value: string | undefined,
):
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly error: CliFailure } {
  return PlatformAccountResetOperationIdSchema.safeParse(value).success
    ? { ok: true, value: value as string }
    : { ok: false, error: usage('--operation-id must be a bounded reset operation ID') };
}

function isAction(value: string | undefined): value is Action {
  return value === 'preview' || value === 'status' || isMutation(value);
}

function isMutation(value: string | undefined): value is 'quarantine' | 'rollback' | 'finalize' {
  return value === 'quarantine' || value === 'rollback' || value === 'finalize';
}

function isPreviewOperation(value: string | undefined): value is PreviewOperation {
  return value === 'quarantine' || value === 'rollback' || value === 'finalize';
}

function usage(message: string): CliFailure {
  return {
    code: 'usage',
    message,
    cause: 'The platform-auth account-reset command or one of its arguments is invalid.',
    fix: 'Use the exact account-reset command surface and a fresh preview before retrying.',
    next: 'noodle platform-auth account-reset status --operation-id <reset-operation-id>',
    exitCode: EXIT.USAGE,
  };
}
