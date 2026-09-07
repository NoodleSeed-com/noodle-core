import { readFile } from 'node:fs/promises';
import {
  LegacyBillingMigrationClientPreviewSchema,
  type LegacyBillingMigrationPreview,
  type LegacyBillingMigrationRequest,
  type LegacyBillingPlanEvidence,
  parseLegacyBillingMigrationPlanEvidence,
  parseLegacyBillingMigrationRequest,
} from '@noodle-borg/wire-contracts';
import { errorMessage } from '../diagnostics.js';
import { legacyBillingMigrationPreviewChecksum } from './billing-contract-checksums.js';
import { EXIT } from './output.js';
import type { CliFailure } from './shared.js';

export interface ApprovedLegacyBillingMigrationPreview {
  readonly service: string;
  readonly preview: LegacyBillingMigrationPreview;
}

export async function readMappingRequest(
  file: string | undefined,
): Promise<LegacyBillingMigrationRequest> {
  if (file === undefined) {
    return parseLegacyBillingMigrationRequest({ schemaVersion: 1, mappings: [] });
  }
  return parseLegacyBillingMigrationRequest(await readJsonFile(file, 'mapping'));
}

export async function readApprovedPreview(
  file: string,
): Promise<ApprovedLegacyBillingMigrationPreview> {
  const value = await readJsonFile(file, 'approved preview');
  if (!isRecord(value) || value.ok !== true || !isRecord(value.data)) {
    throw new Error('expected the JSON envelope written by billing migration preview --json');
  }
  const { service, preview } = value.data;
  const parsed = LegacyBillingMigrationClientPreviewSchema.safeParse(preview);
  if (typeof service !== 'string' || !parsed.success) {
    throw new Error('approved preview file does not match the billing migration preview schema');
  }
  const approvedPreview = parsed.data as LegacyBillingMigrationPreview;
  if (legacyBillingMigrationPreviewChecksum(approvedPreview) !== approvedPreview.previewChecksum) {
    throw new Error('approved preview checksum does not match its contents');
  }
  return { service, preview: approvedPreview };
}

export async function readPlanEvidence(file: string): Promise<LegacyBillingPlanEvidence> {
  return parseLegacyBillingMigrationPlanEvidence(await readJsonFile(file, 'plan evidence'));
}

export function mappingFileFailure(file: string | undefined, error: unknown): CliFailure {
  const path = file ?? '<mapping.json>';
  return {
    code: 'invalid_mapping_file',
    message: `Cannot use billing migration mapping file ${path}.`,
    cause: errorMessage(error),
    fix: 'Ensure the file exists, is readable JSON, and matches the billing migration schema.',
    next: `noodle billing migration preview --file ${path}`,
    exitCode: EXIT.FAILURE,
  };
}

export function approvedPreviewFileFailure(file: string, error: unknown): CliFailure {
  return {
    code: 'invalid_preview_file',
    message: `Cannot use approved billing migration preview file ${file}.`,
    cause: errorMessage(error),
    fix: 'Save a READY JSON preview from the same service and do not edit it.',
    next: `noodle billing migration preview --file <mapping.json> --json > ${file}`,
    exitCode: EXIT.FAILURE,
  };
}

export function planEvidenceFileFailure(file: string, error: unknown): CliFailure {
  return {
    code: 'invalid_plan_evidence_file',
    message: `Cannot use legacy billing plan evidence file ${file}.`,
    cause: errorMessage(error),
    fix: 'Ensure the file is readable JSON and contains a complete default-Free reconciliation.',
    next: 'Re-capture and review the authoritative legacy plan projections.',
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
