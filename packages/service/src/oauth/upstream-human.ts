import { createHash } from 'node:crypto';
import type { UpstreamHumanRollout } from '@noodle-borg/module';

export type {
  UpstreamAuthorizationOptions,
  UpstreamHumanAuthentication,
  UpstreamHumanOAuthAuthenticator,
  UpstreamHumanRollout,
} from '@noodle-borg/module';

export type UpstreamHumanProvider = 'google' | 'workos';

export const GOOGLE_ONLY_UPSTREAM_ROLLOUT: UpstreamHumanRollout = {
  workosPercentage: 0,
  workosCanaryClientIds: [],
  workosRecoveryClientIds: [],
  allowUserSelectedWorkosRecovery: false,
};

/** Select once at authorization creation; callbacks must use the stored result, never recalculate rollout. */
export function selectUpstreamHumanProvider(
  input: { readonly clientId: string; readonly transactionNonce: string },
  rollout: UpstreamHumanRollout = GOOGLE_ONLY_UPSTREAM_ROLLOUT,
): UpstreamHumanProvider {
  if (rollout.workosRecoveryClientIds?.includes(input.clientId) === true) return 'workos';
  if (rollout.workosPercentage <= 0) return 'google';
  if (rollout.workosCanaryClientIds.includes(input.clientId)) return 'workos';
  if (rollout.workosPercentage >= 100) return 'workos';
  const digest = createHash('sha256')
    .update(`${input.clientId}:${input.transactionNonce}`)
    .digest();
  // Map a full uint32 into the exact [0, 2^32) range rather than reducing one byte modulo 100, whose
  // uneven buckets bias an intermediate rollout. The threshold form needs no rejection sampling.
  const bucket = digest.readUInt32BE(0);
  const threshold = (rollout.workosPercentage / 100) * 0x1_0000_0000;
  return bucket < threshold ? 'workos' : 'google';
}
