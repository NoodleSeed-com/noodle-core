import { resolveTxt } from 'node:dns/promises';
import type { ControlPlaneStore, OrgDomainRecord } from './store.js';

export const ORG_DOMAIN_TXT_LABEL = '_noodle-seed';

export type TxtResolver = (hostname: string) => Promise<readonly (readonly string[])[]>;

export type OrgDomainVerificationResult =
  | { readonly ok: true; readonly record: OrgDomainRecord }
  | {
      readonly ok: false;
      readonly code: 'not_found' | 'challenge_missing' | 'dns_error';
      readonly record?: OrgDomainRecord;
    };

export async function verifyOrgDomainDns(
  store: ControlPlaneStore,
  input: { readonly org: string; readonly domain: string },
  options: { readonly resolveTxt?: TxtResolver } = {},
): Promise<OrgDomainVerificationResult> {
  const record = (await store.listOrgDomains(input.org)).find(
    (candidate) => candidate.domain === input.domain,
  );
  if (record === undefined) return { ok: false, code: 'not_found' };

  const resolver = options.resolveTxt ?? resolveTxt;
  const hostname = `${ORG_DOMAIN_TXT_LABEL}.${record.domain}`;
  let txtRecords: readonly (readonly string[])[];
  try {
    txtRecords = await resolver(hostname);
  } catch {
    const updated = await store.markOrgDomainVerification({
      org: record.orgSlug,
      domain: record.domain,
      verified: false,
    });
    return { ok: false, code: 'dns_error', ...(updated !== undefined ? { record: updated } : {}) };
  }

  const verified = txtRecords.some((parts) => parts.join('') === record.challenge);
  const updated = await store.markOrgDomainVerification({
    org: record.orgSlug,
    domain: record.domain,
    verified,
  });
  if (updated === undefined) return { ok: false, code: 'not_found' };
  return verified
    ? { ok: true, record: updated }
    : { ok: false, code: 'challenge_missing', record: updated };
}
