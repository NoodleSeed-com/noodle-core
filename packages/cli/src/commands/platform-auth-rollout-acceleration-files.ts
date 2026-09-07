import { constants, open } from 'node:fs/promises';
import { z } from 'zod';

const MAX_APPROVAL_FILE_BYTES = 16 * 1024;
const CHECKSUM = z.string().regex(/^[0-9a-f]{64}$/);
const STAGE = z.union([z.literal(1), z.literal(10), z.literal(50), z.literal(100)]);
const APPROVAL_SCHEMA = z
  .strictObject({
    schemaVersion: z.literal(1),
    exception: z.literal('exact_three_legacy_cutover'),
    targetEnvironment: z.literal('production'),
    releaseSha: z.string().regex(/^[0-9a-f]{40}$/),
    expectedGeneration: z.number().int().nonnegative(),
    fromPercentage: STAGE,
    toPercentage: STAGE,
    approvedAt: z
      .string()
      .datetime({ offset: true })
      .transform((value) => new Date(value).toISOString()),
    evidence: z.strictObject({
      stageVolumeChecksum: CHECKSUM,
      criticalSmokesChecksum: CHECKSUM,
      rollbackSmokeChecksum: CHECKSUM,
    }),
  })
  .superRefine((approval, context) => {
    const next = new Map<number, number>([
      [1, 10],
      [10, 50],
      [50, 100],
    ]).get(approval.fromPercentage);
    if (approval.toPercentage !== next) {
      context.addIssue({
        code: 'custom',
        path: ['toPercentage'],
        message: 'acceleration approval must target the next approved rollout stage',
      });
    }
  });

export type PlatformAuthRolloutAccelerationApprovalFile = z.infer<typeof APPROVAL_SCHEMA>;

export async function readPlatformAuthRolloutAccelerationApprovalFile(
  path: string,
): Promise<PlatformAuthRolloutAccelerationApprovalFile> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw approvalFileFailure();
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o7777) !== 0o600 || stat.size > MAX_APPROVAL_FILE_BYTES) {
      throw approvalFileFailure();
    }
    const contents = await handle.readFile('utf8');
    if (Buffer.byteLength(contents, 'utf8') > MAX_APPROVAL_FILE_BYTES) {
      throw approvalFileFailure();
    }
    return APPROVAL_SCHEMA.parse(JSON.parse(contents));
  } catch {
    throw approvalFileFailure();
  } finally {
    await handle.close();
  }
}

class PlatformAuthRolloutAccelerationApprovalFileError extends Error {
  constructor() {
    super('The acceleration approval file is invalid.');
    this.name = 'PlatformAuthRolloutAccelerationApprovalFileError';
  }
}

function approvalFileFailure(): PlatformAuthRolloutAccelerationApprovalFileError {
  return new PlatformAuthRolloutAccelerationApprovalFileError();
}
