import type { ModuleSqlTransaction } from './sql-transaction.js';

export type OrganizationProvisioningReason = 'organization-created' | 'personal-workspace-created';

export interface OrganizationProvisioningInput {
  readonly org: string;
  readonly owner: {
    readonly identityIssuer?: string;
    readonly subject: string;
    readonly email: string;
  };
  readonly reason: OrganizationProvisioningReason;
  readonly createdAt: Date;
}

/** Optional hosted side effect that joins the core organization-creation transaction. */
export interface OrganizationProvisioningHook {
  readonly id: string;
  provision(
    transaction: ModuleSqlTransaction | undefined,
    input: OrganizationProvisioningInput,
  ): void | Promise<void>;
}
