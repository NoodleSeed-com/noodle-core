import { EXIT } from './output.js';
import type { CliFailure } from './shared.js';

interface CommonArgs {
  readonly service?: string;
  readonly authToken?: string;
  readonly json: boolean;
}

export interface StatusArgs extends CommonArgs {
  readonly action: 'status';
}

export interface PreviewArgs extends CommonArgs {
  readonly action: 'preview';
  readonly file: string;
}

export interface ActivateArgs extends CommonArgs {
  readonly action: 'activate';
  readonly file: string;
  readonly previewFile: string;
  readonly reason: string;
  readonly idempotencyKey: string;
  readonly yes: boolean;
}

export interface RollbackArgs extends CommonArgs {
  readonly action: 'rollback';
  readonly epochId: string;
  readonly generation: number;
  readonly reason: string;
  readonly idempotencyKey: string;
  readonly yes: boolean;
}

export type ActivationArgs = StatusArgs | PreviewArgs | ActivateArgs | RollbackArgs;

export function parseActivationArgs(
  rest: readonly string[],
):
  | { readonly ok: true; readonly args: ActivationArgs }
  | { readonly ok: false; readonly error: CliFailure } {
  const action = rest[0];
  if (
    action !== 'status' &&
    action !== 'preview' &&
    action !== 'activate' &&
    action !== 'rollback'
  ) {
    return {
      ok: false,
      error: activationUsage('activation requires status, preview, activate, or rollback'),
    };
  }
  const allowed = new Set(['--service', '--auth-token']);
  if (action === 'preview' || action === 'activate') allowed.add('--file');
  if (action === 'activate') allowed.add('--preview-file');
  if (action === 'activate' || action === 'rollback') {
    allowed.add('--reason');
    allowed.add('--idempotency-key');
  }
  if (action === 'rollback') {
    allowed.add('--epoch');
    allowed.add('--generation');
  }
  const parsed = parseFlags(rest.slice(1), allowed, action === 'activate' || action === 'rollback');
  if (!parsed.ok) return parsed;
  const common = {
    ...(parsed.values.has('--service')
      ? { service: parsed.values.get('--service') as string }
      : {}),
    ...(parsed.values.has('--auth-token')
      ? { authToken: parsed.values.get('--auth-token') as string }
      : {}),
    json: parsed.json,
  };
  if (action === 'status') return { ok: true, args: { action, ...common } };
  if (action === 'preview') {
    const file = parsed.values.get('--file');
    if (file === undefined) return { ok: false, error: activationUsage('--file is required') };
    return { ok: true, args: { action, file, ...common } };
  }
  const reason = parsed.values.get('--reason');
  const idempotencyKey = parsed.values.get('--idempotency-key');
  if (reason === undefined) return { ok: false, error: activationUsage('--reason is required') };
  if (idempotencyKey === undefined) {
    return { ok: false, error: activationUsage('--idempotency-key is required') };
  }
  if (action === 'activate') {
    const file = parsed.values.get('--file');
    const previewFile = parsed.values.get('--preview-file');
    if (file === undefined) return { ok: false, error: activationUsage('--file is required') };
    if (previewFile === undefined) {
      return { ok: false, error: activationUsage('--preview-file is required') };
    }
    return {
      ok: true,
      args: { action, file, previewFile, reason, idempotencyKey, yes: parsed.yes, ...common },
    };
  }
  const epochId = parsed.values.get('--epoch');
  const generationText = parsed.values.get('--generation');
  if (epochId === undefined) return { ok: false, error: activationUsage('--epoch is required') };
  if (generationText === undefined || !/^[1-9][0-9]*$/.test(generationText)) {
    return { ok: false, error: activationUsage('--generation must be a positive integer') };
  }
  const generation = Number(generationText);
  if (!Number.isSafeInteger(generation)) {
    return { ok: false, error: activationUsage('--generation must be a safe positive integer') };
  }
  return {
    ok: true,
    args: { action, epochId, generation, reason, idempotencyKey, yes: parsed.yes, ...common },
  };
}

function parseFlags(
  rest: readonly string[],
  allowed: ReadonlySet<string>,
  allowYes: boolean,
):
  | {
      readonly ok: true;
      readonly values: ReadonlyMap<string, string>;
      readonly json: boolean;
      readonly yes: boolean;
    }
  | { readonly ok: false; readonly error: CliFailure } {
  const values = new Map<string, string>();
  let json = false;
  let yes = false;
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === '--json') {
      if (json) return { ok: false, error: activationUsage('--json may be supplied once') };
      json = true;
    } else if (arg === '--yes' && allowYes) {
      if (yes) return { ok: false, error: activationUsage('--yes may be supplied once') };
      yes = true;
    } else if (arg !== undefined && allowed.has(arg)) {
      const value = rest[index + 1];
      if (value === undefined || value.length === 0 || value.startsWith('--')) {
        return { ok: false, error: activationUsage(`a value for ${arg} is required`) };
      }
      if (values.has(arg)) {
        return { ok: false, error: activationUsage(`${arg} may be supplied once`) };
      }
      values.set(arg, value);
      index++;
    } else {
      return { ok: false, error: activationUsage(`unknown argument: ${arg ?? ''}`) };
    }
  }
  return { ok: true, values, json, yes };
}

export function activationUsage(message: string): CliFailure {
  return {
    code: 'usage',
    message,
    cause: 'The billing enforcement activation command or one of its arguments is invalid.',
    fix: 'Inspect status, save and review a fresh preview, then explicitly confirm a mutation.',
    next: 'noodle billing enforcement activation status',
    exitCode: EXIT.USAGE,
  };
}
