import type { IncomingMessage } from 'node:http';
import {
  admitPublicRecord,
  clientAddressBucket,
  type DailyCounterStore,
  PUBLIC_ADMISSION_ASSERTION_HEADER,
  type PublicAdmissionRequestBinding,
  type PublicAdmissionSigningKeys,
  type PublicRecordAdmissionLimits,
  verifyPublicAdmissionAssertion,
} from '@noodle-borg/admission-limits/portable';

interface PublicIntakeAdmissionDeps {
  readonly publicCounters: DailyCounterStore;
  readonly now?: () => Date;
  readonly publicAdmissionKeys?: PublicAdmissionSigningKeys;
  readonly publicAdmissionLimits?: Partial<PublicRecordAdmissionLimits>;
}

/** Atomically apply every unavoidable public-intake ceiling to one new logical record. */
export async function consumePublicIntakeQuota(
  req: IncomingMessage,
  publicId: string,
  attempt: { readonly key: string; readonly fingerprint: string },
  deps: PublicIntakeAdmissionDeps,
  binding?: PublicAdmissionRequestBinding,
) {
  const timestamp = deps.now?.() ?? new Date();
  // TLS proxy trust does not authenticate browser attribution. Until the Portal/service hop has its
  // own verified assertion, use only the immediate peer and keep the installation ceiling as the
  // unavoidable abuse bound. This deliberately collapses a Portal BFF to one fairness bucket instead
  // of letting callers forge X-Forwarded-For into unlimited buckets.
  const assertion = req.headers[PUBLIC_ADMISSION_ASSERTION_HEADER];
  const attributed =
    typeof assertion === 'string' && binding && deps.publicAdmissionKeys
      ? verifyPublicAdmissionAssertion(assertion, binding, deps.publicAdmissionKeys, timestamp)
      : undefined;
  if (assertion !== undefined && attributed === undefined)
    return { allowed: false as const, reason: 'invalid_attribution' as const };
  const peer = clientAddressBucket(req.socket.remoteAddress);
  const buckets = attributed ?? (peer ? { network: peer } : {});
  return admitPublicRecord({
    counters: deps.publicCounters,
    surfaceId: publicId,
    attempt,
    buckets,
    now: timestamp,
    ...(deps.publicAdmissionLimits ? { limits: deps.publicAdmissionLimits } : {}),
  });
}
