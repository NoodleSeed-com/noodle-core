import {
  DEPLOYMENT_ACTIVATION_PHASE,
  type ModuleSqlTransaction,
  type NamedDeploymentActivationHook,
} from '@noodle-borg/module';
import { describe, expect, it } from 'vitest';
import {
  assertPreparedDeploymentActivation,
  createModuleSqlTransaction,
  createOrganizationProvisioningTx,
  prepareDeploymentActivation,
} from '../src/modules/context.js';
import { activateDeploymentRows } from '../src/store/postgres-activation.js';

const target = {
  operation: 'activate' as const,
  org: 'acme',
  app: 'tasks',
  environment: 'prod',
  deploymentId: 'dep_1',
};

describe('module transaction context', () => {
  it('uses one borrowed transaction facade for prepare and assert in contract order', async () => {
    const calls: string[] = [];
    const transactions: ModuleSqlTransaction[] = [];
    const client = {
      query: async (sql: string) => {
        calls.push(sql);
        return { rows: [], rowCount: 0 };
      },
    };
    const hooks: NamedDeploymentActivationHook[] = [
      hook('commercial', DEPLOYMENT_ACTIVATION_PHASE.COMMERCIAL_AUTHORITY, calls, transactions),
      hook('automation', DEPLOYMENT_ACTIVATION_PHASE.AUTOMATION_FRESHNESS, calls, transactions),
    ];

    const prepared = await prepareDeploymentActivation(client, hooks, target);
    await assertPreparedDeploymentActivation(prepared);

    expect(calls).toEqual([
      'prepare:commercial',
      'prepare:automation',
      'assert:commercial:commercial-state',
      'assert:automation:automation-state',
    ]);
    expect(new Set(transactions).size).toBe(1);
  });

  it('rejects explicit transaction control before the borrowed client sees it', async () => {
    const calls: string[] = [];
    const transaction = createModuleSqlTransaction({
      query: async (sql: string) => {
        calls.push(sql);
        return { rows: [], rowCount: 0 };
      },
    });

    for (const sql of [
      'BEGIN',
      ' commit ',
      'ROLLBACK',
      'SAVEPOINT module_hook',
      'SELECT 1; COMMIT',
    ]) {
      await expect(transaction.query(sql)).rejects.toThrow(/transaction control/i);
    }
    expect(calls).toEqual([]);
    await expect(transaction.query('SELECT 1')).resolves.toEqual({ rows: [], rowCount: 0 });
    expect(calls).toEqual(['SELECT 1']);
  });

  it('does not assert later hooks after an earlier hook fails', async () => {
    const calls: string[] = [];
    const client = { query: async () => ({ rows: [], rowCount: 0 }) };
    const hooks: NamedDeploymentActivationHook[] = [
      {
        id: 'commercial',
        phase: DEPLOYMENT_ACTIVATION_PHASE.COMMERCIAL_AUTHORITY,
        prepare: async () => 'locked',
        assert: async () => {
          calls.push('commercial');
          throw new Error('capacity exceeded');
        },
      },
      {
        id: 'automation',
        phase: DEPLOYMENT_ACTIVATION_PHASE.AUTOMATION_FRESHNESS,
        prepare: async () => 'fresh',
        assert: async () => {
          calls.push('automation');
        },
      },
    ];

    const prepared = await prepareDeploymentActivation(client, hooks, target);

    await expect(assertPreparedDeploymentActivation(prepared)).rejects.toThrow('capacity exceeded');
    expect(calls).toEqual(['commercial']);
  });

  it('threads an automation id into the hook inside the core activation transaction', async () => {
    const calls: string[] = [];
    const client = {
      query: async (sql: string) => {
        calls.push(sql);
        return { rows: [], rowCount: 0 };
      },
      release: () => calls.push('release'),
    };
    const hook: NamedDeploymentActivationHook = {
      id: 'automation',
      phase: DEPLOYMENT_ACTIVATION_PHASE.AUTOMATION_FRESHNESS,
      prepare: async (_transaction, activationTarget) => {
        expect(activationTarget.automationId).toBe('run-1');
        throw new Error('stop after automation target proof');
      },
      assert: async () => undefined,
    };

    await expect(
      activateDeploymentRows(
        { connect: async () => client },
        { org: 'acme', app: 'tasks', env: 'prod' },
        'automated-12345678',
        undefined,
        [hook],
        { automationId: 'run-1' },
      ),
    ).rejects.toThrow('stop after automation target proof');
    expect(calls).toEqual([
      'BEGIN',
      expect.stringMatching(/^SAVEPOINT activation_[0-9a-f]{32}$/),
      'ROLLBACK',
      'release',
    ]);
  });

  it('adapts organization provisioning to the borrowed core transaction', async () => {
    const calls: string[] = [];
    const client = {
      query: async (sql: string) => {
        calls.push(sql);
        return { rows: [], rowCount: 0 };
      },
    };
    const transaction = createOrganizationProvisioningTx(() => ({
      id: 'billing',
      provision: async (borrowed, input) => {
        expect(input).toEqual({
          org: 'acme',
          owner: { subject: 'owner-1', email: 'owner@example.com' },
          reason: 'organization-created',
          createdAt: new Date('2026-08-23T00:00:00.000Z'),
        });
        await borrowed?.query('SELECT $1::text', [input.org]);
      },
    }));

    await transaction?.(
      client,
      {
        org: 'acme',
        owner: { subject: 'owner-1', email: 'owner@example.com' },
        reason: 'organization-created',
      },
      new Date('2026-08-23T00:00:00.000Z'),
    );

    expect(calls).toEqual(['SELECT $1::text']);
    await expect(
      createOrganizationProvisioningTx(() => undefined)(
        client,
        {
          org: 'portable',
          owner: { subject: 'owner-2', email: 'owner2@example.com' },
          reason: 'organization-created',
        },
        new Date(),
      ),
    ).resolves.toBeUndefined();
    expect(calls).toEqual(['SELECT $1::text']);
  });
});

function hook(
  id: string,
  phase: NamedDeploymentActivationHook['phase'],
  calls: string[],
  transactions: ModuleSqlTransaction[],
): NamedDeploymentActivationHook {
  return {
    id,
    phase,
    prepare: async (transaction) => {
      transactions.push(transaction);
      calls.push(`prepare:${id}`);
      return `${id}-state`;
    },
    assert: async (transaction, _target, prepared) => {
      transactions.push(transaction);
      calls.push(`assert:${id}:${String(prepared)}`);
    },
  };
}
