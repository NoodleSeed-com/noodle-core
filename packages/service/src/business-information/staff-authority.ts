import type { EligibleBusinessAssignee } from '@noodle-borg/wire-contracts';
import { BusinessWorkspaceError } from '../business-workspaces/contracts.js';
import type { BusinessWorkspaceStore } from '../business-workspaces/store.js';
import type {
  BusinessGrant,
  BusinessPermission,
  BusinessStaffGrant,
  InstallationScope,
} from './contracts.js';
import { businessGrantAllows } from './model.js';
import { workspacePermissionForBusinessOperation } from './workspace-permissions.js';

/** One version selector shared by HTTP reads and transaction-bound native store effects. */
export class BusinessStaffAuthority {
  #workspaces: BusinessWorkspaceStore | undefined;
  constructor(
    private readonly getLegacyGrant: (
      scope: InstallationScope,
      subject: string,
    ) => Promise<BusinessGrant | undefined>,
  ) {}

  configure(workspaces: BusinessWorkspaceStore | undefined): void {
    this.#workspaces = workspaces;
  }

  async resolve(
    scope: InstallationScope,
    subject: string,
  ): Promise<BusinessStaffGrant | undefined> {
    try {
      const access = await this.#workspaces?.resolveAccess(scope.org, subject);
      if (access) return { ...access, scope };
      return this.getLegacyGrant(scope, subject);
    } catch (error) {
      if (error instanceof BusinessWorkspaceError && error.code === 'forbidden') return undefined;
      throw error;
    }
  }

  async allows(
    scope: InstallationScope,
    subject: string,
    permission: BusinessPermission,
  ): Promise<boolean> {
    return businessGrantAllows(await this.resolve(scope, subject), permission);
  }

  async eligibleAssignees(
    scope: InstallationScope,
    actor: string,
    legacy: () => Promise<readonly BusinessGrant[]>,
  ): Promise<readonly EligibleBusinessAssignee[]> {
    const current = await this.#workspaces?.listEligibleAssignees(scope.org, actor);
    if (current) return current;
    const result: EligibleBusinessAssignee[] = [];
    for (const grant of await legacy()) {
      if (grant.email && !grant.revokedAt && grant.role !== 'viewer')
        result.push({ subject: grant.subject, role: grant.role, email: grant.email });
    }
    return result;
  }

  /** Local effects only. The caller emits responses after this transaction has committed. */
  async run<T>(
    scope: InstallationScope,
    actor: string,
    permission: BusinessPermission,
    operation: () => Promise<T>,
    forbidden?: () => Error,
  ): Promise<T> {
    const legacy = async () => {
      if (!businessGrantAllows(await this.getLegacyGrant(scope, actor), permission))
        throw new BusinessWorkspaceError('forbidden');
      return operation();
    };
    try {
      if (!this.#workspaces) return await legacy();
      return await this.#workspaces.runAuthorized(
        scope.org,
        actor,
        workspacePermissionForBusinessOperation(permission) ?? null,
        operation,
        legacy,
      );
    } catch (error) {
      if (forbidden && error instanceof BusinessWorkspaceError && error.code === 'forbidden')
        throw forbidden();
      throw error;
    }
  }
}
