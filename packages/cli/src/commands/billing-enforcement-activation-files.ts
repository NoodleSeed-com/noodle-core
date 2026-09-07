import { readFile } from 'node:fs/promises';
import {
  type BillingEnforcementActivationApproval,
  BillingEnforcementActivationApprovalSchema,
  type BillingEnforcementActivationPreview,
  BillingEnforcementActivationPreviewClientSchema as BillingEnforcementActivationPreviewSchema,
} from '@noodle-borg/wire-contracts';
import { errorMessage } from '../diagnostics.js';
import { EXIT } from './output.js';
import type { CliFailure } from './shared.js';

export interface ApprovedBillingEnforcementActivationPreview {
  readonly service: string;
  readonly activationPreview: BillingEnforcementActivationPreview;
}

export async function readActivationApproval(
  file: string,
): Promise<BillingEnforcementActivationApproval> {
  return BillingEnforcementActivationApprovalSchema.parse(
    await readJsonFile(file, 'activation approval'),
  );
}

export async function readApprovedActivationPreview(
  file: string,
): Promise<ApprovedBillingEnforcementActivationPreview> {
  const value = await readJsonFile(file, 'activation preview');
  if (!isRecord(value) || value.ok !== true || !isRecord(value.data)) {
    throw new Error(
      'expected the JSON envelope written by billing enforcement activation preview --json',
    );
  }
  const service = value.data.service;
  if (typeof service !== 'string') throw new Error('activation preview service is missing');
  const activationPreview = BillingEnforcementActivationPreviewSchema.parse(
    value.data.activationPreview,
  );
  if (!activationPreview.ready) {
    throw new Error(
      `activation preview is blocked: ${activationPreview.blockers.map(({ code }) => code).join(', ')}`,
    );
  }
  return { service, activationPreview };
}

export function activationApprovalFileFailure(file: string, error: unknown): CliFailure {
  return {
    code: 'invalid_activation_approval_file',
    message: `Cannot use billing enforcement activation approval file ${file}.`,
    cause: errorMessage(error),
    fix: 'Ensure the file is readable JSON and matches the strict production approval schema.',
    next: `noodle billing enforcement activation preview --file ${file}`,
    exitCode: EXIT.FAILURE,
  };
}

export function activationPreviewFileFailure(file: string, error: unknown): CliFailure {
  return {
    code: 'invalid_activation_preview_file',
    message: `Cannot use approved billing enforcement activation preview file ${file}.`,
    cause: errorMessage(error),
    fix: 'Save a READY JSON preview from the same service and do not edit it.',
    next: `noodle billing enforcement activation preview --file <approval.json> --json > ${file}`,
    exitCode: EXIT.FAILURE,
  };
}

async function readJsonFile(file: string, label: string): Promise<unknown> {
  const text = await readFile(file, 'utf8');
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${label} file is not valid JSON: ${errorMessage(error)}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
