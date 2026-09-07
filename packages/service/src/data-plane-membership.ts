import type {
  AuditSink,
  DataPlaneIdentityAuthorizer,
  OrgMembershipSource,
  PlatformPrincipalResolver,
  VerifiedEmailLookup,
} from '@noodle-borg/module';
import type { Logger } from '@noodle-borg/transport-http';
import type { ControlPlaneStore } from './store.js';

/** Denials worth reporting: both mean the evidence was missing, not that the caller was offboarded. */
type ReportableDenial = 'principal_unknown' | 'lookup_unavailable';

/**
 * Build the data-plane membership authorizer — the single join point between Noodle-owned membership state
 * and the transport front door's identity gate.
 *
 * Explicit membership is checked first and never depends on the verified-email resolver, so a legacy
 * principal, a customer-kind identity, or a store outage can never lock out an explicit member. The domain
 * path resolves the principal's *current* verified address instead of trusting the token's `email` claim,
 * which is copied forward through every refresh rotation and would otherwise keep asserting a former
 * employer's domain indefinitely. Once a resolver is wired we never fall back to the claim: that fallback
 * would be triggerable by exactly the party being defended against.
 */
export function createDataPlaneMembershipAuthorizer(deps: {
  readonly controlPlane: ControlPlaneStore;
  readonly verifiedEmails?: Pick<PlatformPrincipalResolver, 'lookupActiveVerifiedEmails'>;
  readonly audit?: AuditSink;
  readonly logger?: Pick<Logger, 'warn'>;
}): DataPlaneIdentityAuthorizer {
  const { controlPlane, verifiedEmails, audit, logger } = deps;

  async function domainEmails(
    subject: string,
    claimEmail: string | undefined,
  ): Promise<{ readonly emails: readonly string[]; readonly denial?: ReportableDenial }> {
    if (verifiedEmails === undefined) {
      return { emails: claimEmail === undefined ? [] : [claimEmail] };
    }
    const lookup = await verifiedEmails
      .lookupActiveVerifiedEmails(subject)
      .catch((): VerifiedEmailLookup => ({ kind: 'unavailable' }));
    if (lookup.kind === 'known') return { emails: lookup.emails };
    return {
      emails: [],
      denial: lookup.kind === 'unknown' ? 'principal_unknown' : 'lookup_unavailable',
    };
  }

  async function report(org: string, denial: ReportableDenial): Promise<void> {
    logger?.warn('data_plane.domain_membership_denied', { org, reason: denial });
    await audit?.emit({
      eventType: 'mcp.request.denied',
      org,
      decision: 'deny',
      status: 403,
      reasonCode: `domain_membership_${denial}`,
      details: { source: 'domain' },
    });
  }

  return async (input) => {
    if (input.accessMode !== 'org-members') return { allowed: false };
    // Absent means every source. An explicit list is honoured symmetrically, so narrowing to one source
    // excludes the others, and an empty or unrecognised list admits nobody rather than everybody.
    const enabled = input.membershipSources;
    const allows = (source: OrgMembershipSource): boolean =>
      enabled === undefined || enabled.includes(source);

    if (
      allows('explicit') &&
      (await controlPlane.isOrgMember({ org: input.org, subject: input.subject }))
    ) {
      return { allowed: true, via: 'explicit' };
    }
    if (!allows('domain')) return { allowed: false };

    const { emails, denial } = await domainEmails(input.subject, input.email);
    if (denial !== undefined) {
      await report(input.org, denial);
      return { allowed: false };
    }
    for (const email of emails) {
      const member = await controlPlane.isDataPlaneOrgMember({
        org: input.org,
        subject: input.subject,
        email,
      });
      if (member) return { allowed: true, via: 'domain' };
    }
    return { allowed: false };
  };
}
