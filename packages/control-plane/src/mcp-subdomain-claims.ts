import { createHash } from 'node:crypto';
import type {
  ActiveMcpSubdomainClaim,
  ChangeMcpSubdomainInput,
  McpSubdomainMutationResult,
  McpSubdomainSetting,
  OrganizationStore,
} from './contracts.js';
import { isSystemOwnedOrgSlug, validateMcpSubdomain, validateSlug } from './validation.js';

const MCP_SUBDOMAIN_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

export class McpSubdomainOwnerRequiredError extends Error {
  constructor() {
    super('organization owner required');
    this.name = 'McpSubdomainOwnerRequiredError';
  }
}

export class McpSubdomainUnavailableError extends Error {
  constructor() {
    super('MCP subdomain is unavailable');
    this.name = 'McpSubdomainUnavailableError';
  }
}

export class McpSubdomainIdempotencyConflictError extends Error {
  constructor() {
    super('idempotency key was already used for another MCP subdomain request');
    this.name = 'McpSubdomainIdempotencyConflictError';
  }
}

export class McpSubdomainCooldownError extends Error {
  readonly changeAllowedAt: string;

  constructor(changeAllowedAt: string) {
    super('MCP subdomain change is in cooldown');
    this.name = 'McpSubdomainCooldownError';
    this.changeAllowedAt = changeAllowedAt;
  }
}

interface InMemoryMutationRecord {
  readonly fingerprint: string;
  readonly result: McpSubdomainMutationResult;
}

/** In-memory parity for active claim reads and organization-creation defaults. */
export class InMemoryMcpSubdomainClaimStore {
  readonly #activeByOrg = new Map<string, ActiveMcpSubdomainClaim>();
  readonly #activeBySubdomain = new Map<string, ActiveMcpSubdomainClaim>();
  readonly #claimedSubdomains = new Set<string>();
  readonly #lastChangedAtByOrg = new Map<string, string>();
  readonly #mutations = new Map<string, InMemoryMutationRecord>();
  readonly #now: () => Date;
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  ensureDefaultMcpSubdomain(org: string): ActiveMcpSubdomainClaim | undefined {
    const orgSlug = validateSlug('org', org);
    if (isSystemOwnedOrgSlug(orgSlug)) return undefined;
    const existing = this.#activeByOrg.get(orgSlug);
    if (existing !== undefined) return existing;
    const mcpSubdomain = validateMcpSubdomain(orgSlug);
    if (this.#claimedSubdomains.has(mcpSubdomain)) {
      throw new McpSubdomainUnavailableError();
    }
    const record: ActiveMcpSubdomainClaim = {
      mcpSubdomain,
      orgSlug,
      claimedAt: this.#now().toISOString(),
    };
    this.#activeByOrg.set(orgSlug, record);
    this.#activeBySubdomain.set(mcpSubdomain, record);
    this.#claimedSubdomains.add(mcpSubdomain);
    return record;
  }

  getActiveMcpSubdomain(org: string): Promise<ActiveMcpSubdomainClaim | undefined> {
    return Promise.resolve(this.#activeByOrg.get(validateSlug('org', org)));
  }

  resolveActiveMcpSubdomain(mcpSubdomain: string): Promise<ActiveMcpSubdomainClaim | undefined> {
    return Promise.resolve(this.#activeBySubdomain.get(validateMcpSubdomain(mcpSubdomain)));
  }

  async getMcpSubdomainSetting(org: string): Promise<McpSubdomainSetting | undefined> {
    const claim = this.#activeByOrg.get(validateSlug('org', org));
    if (claim === undefined) return undefined;
    const changeAllowedAt = this.#changeAllowedAt(claim.orgSlug);
    return { ...claim, ...(changeAllowedAt === undefined ? {} : { changeAllowedAt }) };
  }

  changeMcpSubdomain(
    input: ChangeMcpSubdomainInput,
    isExactOwner: () => boolean | Promise<boolean>,
  ): Promise<McpSubdomainMutationResult> {
    return this.#serialize(async () => {
      const org = validateSlug('org', input.org);
      if (!(await isExactOwner())) throw new McpSubdomainOwnerRequiredError();
      if (input.idempotencyKey.length === 0) {
        throw new Error('idempotency key must not be empty');
      }
      const keyHash = digest(input.idempotencyKey);
      const fingerprint = `v1:${digest(input.mcpSubdomain)}`;
      const recordKey = `${org}\u0000${keyHash}`;
      const replay = this.#mutations.get(recordKey);
      if (replay !== undefined) {
        if (replay.fingerprint !== fingerprint) {
          throw new McpSubdomainIdempotencyConflictError();
        }
        return { ...replay.result, replayed: true };
      }

      const mcpSubdomain = validateMcpSubdomain(input.mcpSubdomain);
      const current = this.#activeByOrg.get(org);
      if (current === undefined) {
        throw new Error(`active MCP subdomain claim missing for organization "${org}"`);
      }
      const changeAllowedAt = this.#changeAllowedAt(org);
      if (mcpSubdomain === current.mcpSubdomain) {
        const result: McpSubdomainMutationResult = {
          orgSlug: org,
          previousMcpSubdomain: current.mcpSubdomain,
          mcpSubdomain,
          changed: false,
          replayed: false,
          ...(changeAllowedAt === undefined ? {} : { changeAllowedAt }),
          auditCommitted: false,
        };
        this.#mutations.set(recordKey, { fingerprint, result });
        return result;
      }
      const now = this.#now();
      if (changeAllowedAt !== undefined && now.getTime() < Date.parse(changeAllowedAt)) {
        throw new McpSubdomainCooldownError(changeAllowedAt);
      }
      if (this.#claimedSubdomains.has(mcpSubdomain)) {
        throw new McpSubdomainUnavailableError();
      }

      const changedAt = now.toISOString();
      const nextChangeAllowedAt = new Date(now.getTime() + MCP_SUBDOMAIN_COOLDOWN_MS).toISOString();
      const next: ActiveMcpSubdomainClaim = {
        orgSlug: org,
        mcpSubdomain,
        claimedAt: changedAt,
      };
      this.#activeBySubdomain.delete(current.mcpSubdomain);
      this.#activeByOrg.set(org, next);
      this.#activeBySubdomain.set(mcpSubdomain, next);
      this.#claimedSubdomains.add(mcpSubdomain);
      this.#lastChangedAtByOrg.set(org, changedAt);
      const result: McpSubdomainMutationResult = {
        orgSlug: org,
        previousMcpSubdomain: current.mcpSubdomain,
        mcpSubdomain,
        changed: true,
        replayed: false,
        changedAt,
        changeAllowedAt: nextChangeAllowedAt,
        auditCommitted: false,
      };
      this.#mutations.set(recordKey, { fingerprint, result });
      return result;
    });
  }

  #changeAllowedAt(org: string): string | undefined {
    const changedAt = this.#lastChangedAtByOrg.get(org);
    return changedAt === undefined
      ? undefined
      : new Date(Date.parse(changedAt) + MCP_SUBDOMAIN_COOLDOWN_MS).toISOString();
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutationTail.then(operation, operation);
    this.#mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface McpSubdomainRouteRef {
  readonly mcpSubdomain: string;
  readonly app: string;
  readonly env: string;
  readonly serverVersion?: string;
}

export interface ResolvedMcpTenantRef {
  readonly org: string;
  readonly app: string;
  readonly env: string;
  readonly serverVersion?: string;
}

export async function resolveMcpSubdomainTenant(
  store: Pick<OrganizationStore, 'resolveActiveMcpSubdomain'>,
  ref: McpSubdomainRouteRef,
): Promise<ResolvedMcpTenantRef | undefined> {
  const claim = await store.resolveActiveMcpSubdomain(ref.mcpSubdomain);
  if (claim === undefined) return undefined;
  return {
    org: claim.orgSlug,
    app: ref.app,
    env: ref.env,
    ...(ref.serverVersion === undefined ? {} : { serverVersion: ref.serverVersion }),
  };
}

export async function mcpSubdomainEndpointOptions(
  store: Pick<OrganizationStore, 'getActiveMcpSubdomain'>,
  org: string,
  publicBaseDomain: string | undefined,
): Promise<{ readonly publicBaseDomain?: string; readonly mcpSubdomain?: string }> {
  if (publicBaseDomain === undefined) return {};
  const claim = await store.getActiveMcpSubdomain(org);
  if (claim === undefined) {
    throw new Error(`active MCP subdomain claim missing for organization "${org}"`);
  }
  return { publicBaseDomain, mcpSubdomain: claim.mcpSubdomain };
}
