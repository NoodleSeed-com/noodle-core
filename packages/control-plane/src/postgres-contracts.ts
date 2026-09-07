import type { PoolClient } from 'pg';

export type OrganizationProvisioningTx = (
  client: PoolClient,
  input: {
    readonly org: string;
    readonly owner: {
      readonly identityIssuer?: string;
      readonly subject: string;
      readonly email: string;
    };
    readonly reason: 'organization-created' | 'personal-workspace-created';
  },
  createdAt: Date,
) => Promise<void>;
