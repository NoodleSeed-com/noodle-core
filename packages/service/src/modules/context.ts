import type { OrganizationProvisioningTx } from '@noodle-borg/control-plane';
import type {
  DeploymentActivationTarget,
  ModuleSqlQueryResult,
  ModuleSqlTransaction,
  NamedDeploymentActivationHook,
  OrganizationProvisioningHook,
} from '@noodle-borg/module';

export interface BorrowedSqlClient {
  query(
    sql: string,
    values?: unknown[],
  ): Promise<{
    readonly rows: readonly Record<string, unknown>[];
    readonly rowCount: number | null;
  }>;
}

interface ReleasableSqlClient extends BorrowedSqlClient {
  release(error?: Error | boolean): void;
}

export interface SqlClientProvider {
  connect(): Promise<ReleasableSqlClient>;
}

interface PreparedActivationHook {
  readonly hook: NamedDeploymentActivationHook;
  readonly state: unknown;
}

export interface PreparedDeploymentActivation {
  readonly transaction: ModuleSqlTransaction;
  readonly target: DeploymentActivationTarget;
  readonly hooks: readonly PreparedActivationHook[];
}

const TRANSACTION_CONTROL =
  /^(?:begin\b|start\s+transaction\b|commit\b|end\b|rollback\b|abort\b|savepoint\b|release\s+savepoint\b|prepare\s+transaction\b|set\s+(?:local\s+|session\s+)?transaction\b|set\s+session\s+characteristics\s+as\s+transaction\b)/i;

export function createModuleSqlTransaction(client: BorrowedSqlClient): ModuleSqlTransaction {
  return {
    async query<Row extends object>(
      sql: string,
      values?: readonly unknown[],
    ): Promise<ModuleSqlQueryResult<Row>> {
      const statement = stripLeadingSqlTrivia(sql);
      const withoutTrailingTerminator = statement.replace(/;\s*$/, '');
      if (TRANSACTION_CONTROL.test(statement) || withoutTrailingTerminator.includes(';')) {
        throw new Error('module SQL must be one statement without transaction control');
      }
      const result = await client.query(sql, values === undefined ? undefined : [...values]);
      return { rows: result.rows as readonly Row[], rowCount: result.rowCount };
    },
  };
}

/** Adapt an optional module hook to the control-plane transaction owner without exposing pg to modules. */
export function createOrganizationProvisioningTx(
  resolveHook: () => OrganizationProvisioningHook | undefined,
): OrganizationProvisioningTx {
  return async (client, input, createdAt) => {
    const hook = resolveHook();
    if (hook === undefined) return;
    await hook.provision(createModuleSqlTransaction(client), { ...input, createdAt });
  };
}

export async function prepareDeploymentActivation(
  client: BorrowedSqlClient,
  hooks: readonly NamedDeploymentActivationHook[],
  target: DeploymentActivationTarget,
): Promise<PreparedDeploymentActivation> {
  const transaction = createModuleSqlTransaction(client);
  const prepared: PreparedActivationHook[] = [];
  for (const hook of hooks) {
    prepared.push({ hook, state: await hook.prepare(transaction, target) });
  }
  return { transaction, target, hooks: prepared };
}

export async function assertPreparedDeploymentActivation(
  prepared: PreparedDeploymentActivation,
): Promise<void> {
  for (const entry of prepared.hooks) {
    await entry.hook.assert(prepared.transaction, prepared.target, entry.state);
  }
}

function stripLeadingSqlTrivia(sql: string): string {
  let remaining = sql.trimStart();
  while (true) {
    if (remaining.startsWith('--')) {
      const newline = remaining.indexOf('\n');
      remaining = newline < 0 ? '' : remaining.slice(newline + 1).trimStart();
      continue;
    }
    if (remaining.startsWith('/*')) {
      const close = remaining.indexOf('*/', 2);
      if (close < 0) return remaining;
      remaining = remaining.slice(close + 2).trimStart();
      continue;
    }
    return remaining;
  }
}
