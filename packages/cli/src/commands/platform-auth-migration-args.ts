import { EXIT } from './output.js';
import {
  hasPlatformAuthFinalizationEvidenceFlags,
  type PlatformAuthFinalizationEvidence,
  parsePlatformAuthFinalizationEvidence,
} from './platform-auth-finalization-args.js';
import type { CliFailure } from './shared.js';

type Action =
  | 'inventory'
  | 'preview'
  | 'status'
  | 'start-import'
  | 'reconcile'
  | 'recover-outbox'
  | 'activate'
  | 'rollback'
  | 'finalize';
type PreviewOperation =
  | 'start_import'
  | 'reconcile'
  | 'recover_outbox'
  | 'activate'
  | 'rollback'
  | 'finalize';

interface CommonArgs {
  readonly action: Action;
  readonly service?: string;
  readonly authToken?: string;
  readonly json: boolean;
}

export type PlatformAuthMigrationArgs =
  | (CommonArgs & { readonly action: 'inventory'; readonly generation: number })
  | (CommonArgs & { readonly action: 'status' })
  | (CommonArgs & {
      readonly action: 'preview';
      readonly operation: 'start_import' | 'rollback';
    })
  | (CommonArgs &
      PlatformAuthFinalizationEvidence & {
        readonly action: 'preview';
        readonly operation: 'finalize';
      })
  | (CommonArgs & {
      readonly action: 'preview';
      readonly operation: 'reconcile' | 'recover_outbox';
      readonly batchSize: number;
    })
  | (CommonArgs & {
      readonly action: 'preview';
      readonly operation: 'activate';
      readonly percentage: number;
      readonly cohortMode: 'preserve';
      readonly accelerationApprovalFile?: string;
    })
  | (CommonArgs & {
      readonly action: 'preview';
      readonly operation: 'activate';
      readonly percentage: number;
      readonly cohortMode: 'replace';
      readonly canaryClientIds: readonly string[];
      readonly recoveryClientIds: readonly string[];
      readonly accelerationApprovalFile?: string;
    })
  | (CommonArgs & MutationEvidence & { readonly action: 'start-import' | 'rollback' })
  | (CommonArgs &
      MutationEvidence &
      PlatformAuthFinalizationEvidence & { readonly action: 'finalize' })
  | (CommonArgs &
      MutationEvidence & {
        readonly action: 'reconcile' | 'recover-outbox';
        readonly batchSize: number;
      })
  | (CommonArgs &
      MutationEvidence & {
        readonly action: 'activate';
        readonly percentage: number;
        readonly cohortMode: 'preserve';
        readonly accelerationApprovalFile?: string;
      })
  | (CommonArgs &
      MutationEvidence & {
        readonly action: 'activate';
        readonly percentage: number;
        readonly cohortMode: 'replace';
        readonly canaryClientIds: readonly string[];
        readonly recoveryClientIds: readonly string[];
        readonly accelerationApprovalFile?: string;
      });

interface MutationEvidence {
  readonly expectedGeneration: number;
  readonly releaseSha: string;
  readonly previewChecksum: string;
  readonly idempotencyKey: string;
  readonly reason: string;
  readonly yes: boolean;
}

interface ParsedFlags {
  readonly values: ReadonlyMap<string, string>;
  readonly repeated: ReadonlyMap<string, readonly string[]>;
  readonly json: boolean;
  readonly yes: boolean;
}

export function parsePlatformAuthMigrationArgs(
  rest: readonly string[],
):
  | { readonly ok: true; readonly args: PlatformAuthMigrationArgs }
  | { readonly ok: false; readonly error: CliFailure } {
  if (rest[0] !== 'migration')
    return { ok: false, error: usage('platform-auth requires migration') };
  const action = rest[1];
  if (!isAction(action)) {
    return {
      ok: false,
      error: usage(
        'migration requires inventory, preview, status, start-import, reconcile, recover-outbox, activate, rollback, or finalize',
      ),
    };
  }
  const allowed = allowedFlags(action);
  const parsed = parseFlags(rest.slice(2), allowed, isMutation(action));
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
  if (action === 'inventory') {
    const generation = nonnegativeInteger(parsed.flags.values.get('--generation') ?? '0');
    if (generation === undefined)
      return { ok: false, error: usage('--generation must be a non-negative safe integer') };
    return { ok: true, args: { ...common, action, generation } };
  }
  if (action === 'status') return { ok: true, args: { ...common, action } };
  if (action === 'preview') return parsePreview({ ...common, action }, parsed.flags);

  const evidence = parseMutationEvidence(parsed.flags);
  if (!evidence.ok) return evidence;
  if (action === 'reconcile' || action === 'recover-outbox') {
    const batchSize = positiveInteger(parsed.flags.values.get('--batch-size'), '--batch-size', 100);
    if (!batchSize.ok) return batchSize;
    return { ok: true, args: { ...common, ...evidence.value, action, batchSize: batchSize.value } };
  }
  if (action === 'activate') {
    const percentage = positiveInteger(
      parsed.flags.values.get('--percentage'),
      '--percentage',
      100,
    );
    if (!percentage.ok) return percentage;
    const cohort = parseCohortTarget(parsed.flags);
    if (!cohort.ok) return cohort;
    return {
      ok: true,
      args: {
        ...common,
        ...evidence.value,
        action,
        percentage: percentage.value,
        ...(parsed.flags.values.has('--acceleration-approval')
          ? {
              accelerationApprovalFile: parsed.flags.values.get(
                '--acceleration-approval',
              ) as string,
            }
          : {}),
        ...cohort.value,
      },
    };
  }
  if (action === 'finalize') {
    const finalizationEvidence = parsePlatformAuthFinalizationEvidence(parsed.flags.values);
    if (!finalizationEvidence.ok) return { ok: false, error: usage(finalizationEvidence.message) };
    return {
      ok: true,
      args: { ...common, ...evidence.value, ...finalizationEvidence.value, action },
    };
  }
  return { ok: true, args: { ...common, ...evidence.value, action } };
}

function parsePreview(
  common: CommonArgs & { readonly action: 'preview' },
  flags: ParsedFlags,
):
  | { readonly ok: true; readonly args: PlatformAuthMigrationArgs }
  | { readonly ok: false; readonly error: CliFailure } {
  const operation = flags.values.get('--operation');
  if (!isPreviewOperation(operation)) {
    return { ok: false, error: usage('--operation must select a supported migration operation') };
  }
  if (operation !== 'finalize' && hasPlatformAuthFinalizationEvidenceFlags(flags.values)) {
    return { ok: false, error: usage('finalization evidence applies only to finalize') };
  }
  if (operation !== 'activate' && flags.values.has('--acceleration-approval')) {
    return { ok: false, error: usage('acceleration approval applies only to activate') };
  }
  if (operation === 'reconcile' || operation === 'recover_outbox') {
    const batchSize = positiveInteger(
      flags.values.get('--batch-size') ?? '100',
      '--batch-size',
      100,
    );
    if (!batchSize.ok) return batchSize;
    return {
      ok: true,
      args: { ...common, operation, batchSize: batchSize.value },
    };
  }
  if (operation === 'activate') {
    const percentage = positiveInteger(flags.values.get('--percentage'), '--percentage', 100);
    if (!percentage.ok) return percentage;
    const cohort = parseCohortTarget(flags);
    if (!cohort.ok) return cohort;
    return {
      ok: true,
      args: {
        ...common,
        operation,
        percentage: percentage.value,
        ...(flags.values.has('--acceleration-approval')
          ? { accelerationApprovalFile: flags.values.get('--acceleration-approval') as string }
          : {}),
        ...cohort.value,
      },
    };
  }
  if (operation === 'finalize') {
    if (hasPreviewTargetFlags(flags)) {
      return { ok: false, error: usage('target flags do not apply to this preview operation') };
    }
    const finalizationEvidence = parsePlatformAuthFinalizationEvidence(flags.values);
    return finalizationEvidence.ok
      ? {
          ok: true,
          args: { ...common, operation, ...finalizationEvidence.value },
        }
      : { ok: false, error: usage(finalizationEvidence.message) };
  }
  if (hasPreviewTargetFlags(flags)) {
    return { ok: false, error: usage('target flags do not apply to this preview operation') };
  }
  return { ok: true, args: { ...common, operation } };
}
function hasPreviewTargetFlags(flags: ParsedFlags): boolean {
  return (
    ['--batch-size', '--percentage', '--cohort-mode'].some((flag) => flags.values.has(flag)) ||
    flags.repeated.has('--canary-client-id') ||
    flags.repeated.has('--recovery-client-id')
  );
}

function parseCohortTarget(flags: ParsedFlags):
  | { readonly ok: true; readonly value: { readonly cohortMode: 'preserve' } }
  | {
      readonly ok: true;
      readonly value: {
        readonly cohortMode: 'replace';
        readonly canaryClientIds: readonly string[];
        readonly recoveryClientIds: readonly string[];
      };
    }
  | { readonly ok: false; readonly error: CliFailure } {
  const mode = flags.values.get('--cohort-mode');
  if (mode !== 'preserve' && mode !== 'replace') {
    return { ok: false, error: usage('--cohort-mode must be preserve or replace') };
  }
  const hasClientIds =
    flags.repeated.has('--canary-client-id') || flags.repeated.has('--recovery-client-id');
  if (mode === 'preserve') {
    return hasClientIds
      ? {
          ok: false,
          error: usage('client ID flags are not allowed with --cohort-mode preserve'),
        }
      : { ok: true, value: { cohortMode: mode } };
  }
  return {
    ok: true,
    value: {
      cohortMode: mode,
      canaryClientIds: unique(flags.repeated.get('--canary-client-id')),
      recoveryClientIds: unique(flags.repeated.get('--recovery-client-id')),
    },
  };
}

function parseMutationEvidence(
  flags: ParsedFlags,
):
  | { readonly ok: true; readonly value: MutationEvidence }
  | { readonly ok: false; readonly error: CliFailure } {
  const generation = nonnegativeInteger(flags.values.get('--expected-generation'));
  if (generation === undefined) {
    return { ok: false, error: usage('--expected-generation must be a non-negative integer') };
  }
  const releaseSha = flags.values.get('--release-sha');
  if (releaseSha === undefined || !/^[0-9a-f]{40}$/.test(releaseSha)) {
    return { ok: false, error: usage('--release-sha must be an exact lowercase 40-character SHA') };
  }
  const previewChecksum = flags.values.get('--preview-checksum');
  if (previewChecksum === undefined || !/^[0-9a-f]{64}$/.test(previewChecksum)) {
    return {
      ok: false,
      error: usage('--preview-checksum must be 64 lowercase hexadecimal characters'),
    };
  }
  const idempotencyKey = flags.values.get('--idempotency-key');
  if (idempotencyKey === undefined || idempotencyKey.length < 8 || idempotencyKey.length > 256) {
    return { ok: false, error: usage('--idempotency-key must contain 8-256 characters') };
  }
  const reason = flags.values.get('--reason');
  if (reason === undefined || reason.trim().length === 0 || reason.length > 256) {
    return { ok: false, error: usage('--reason must contain 1-256 characters') };
  }
  return {
    ok: true,
    value: {
      expectedGeneration: generation,
      releaseSha,
      previewChecksum,
      idempotencyKey,
      reason: reason.trim(),
      yes: flags.yes,
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
  const repeated = new Map<string, string[]>();
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
      return { ok: false, error: usage(`unknown or inapplicable argument: ${flag ?? ''}`) };
    }
    const value = rest[index + 1];
    if (value === undefined || value.length === 0 || value.startsWith('--')) {
      return { ok: false, error: usage(`a value for ${flag} is required`) };
    }
    if (flag === '--canary-client-id' || flag === '--recovery-client-id') {
      repeated.set(flag, [...(repeated.get(flag) ?? []), value]);
    } else {
      if (values.has(flag)) return { ok: false, error: usage(`${flag} may be supplied once`) };
      values.set(flag, value);
    }
    index++;
  }
  return { ok: true, flags: { values, repeated, json, yes } };
}

function allowedFlags(action: Action): ReadonlySet<string> {
  const allowed = new Set(['--service', '--auth-token']);
  if (action === 'inventory') allowed.add('--generation');
  if (action === 'preview') {
    for (const flag of [
      '--operation',
      '--batch-size',
      '--percentage',
      '--cohort-mode',
      '--canary-client-id',
      '--recovery-client-id',
      '--rollback-rehearsal-checksum',
      '--staging-workos-only-smoke-checksum',
      '--acceleration-approval',
    ])
      allowed.add(flag);
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
  if (action === 'reconcile' || action === 'recover-outbox') allowed.add('--batch-size');
  if (action === 'activate') {
    allowed.add('--percentage');
    allowed.add('--cohort-mode');
    allowed.add('--canary-client-id');
    allowed.add('--recovery-client-id');
    allowed.add('--acceleration-approval');
  }
  if (action === 'finalize') {
    allowed.add('--rollback-rehearsal-checksum');
    allowed.add('--staging-workos-only-smoke-checksum');
  }
  return allowed;
}

function positiveInteger(
  value: string | undefined,
  name: string,
  max: number,
):
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly error: CliFailure } {
  const parsed = nonnegativeInteger(value);
  return parsed !== undefined && parsed >= 1 && parsed <= max
    ? { ok: true, value: parsed }
    : { ok: false, error: usage(`${name} must be an integer from 1 to ${max}`) };
}

/** Shared by the platform-auth migration and account-reset arg parsers. */
export function nonnegativeInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^(0|[1-9][0-9]*)$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function unique(values: readonly string[] | undefined): readonly string[] {
  return [...new Set(values ?? [])].sort();
}

function isAction(value: string | undefined): value is Action {
  return (
    value === 'inventory' ||
    value === 'preview' ||
    value === 'status' ||
    value === 'start-import' ||
    value === 'reconcile' ||
    value === 'recover-outbox' ||
    value === 'activate' ||
    value === 'rollback' ||
    value === 'finalize'
  );
}

function isMutation(action: Action): boolean {
  return (
    action === 'start-import' ||
    action === 'reconcile' ||
    action === 'recover-outbox' ||
    action === 'activate' ||
    action === 'rollback' ||
    action === 'finalize'
  );
}

function isPreviewOperation(value: string | undefined): value is PreviewOperation {
  return (
    value === 'start_import' ||
    value === 'reconcile' ||
    value === 'recover_outbox' ||
    value === 'activate' ||
    value === 'rollback' ||
    value === 'finalize'
  );
}

function usage(message: string): CliFailure {
  return {
    code: 'usage',
    message,
    cause: 'The platform-auth migration command or one of its arguments is invalid.',
    fix: 'Inspect a fresh status and preview before retrying.',
    next: 'noodle platform-auth migration status',
    exitCode: EXIT.USAGE,
  };
}
