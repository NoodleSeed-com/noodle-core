import {
  type ModuleSqlTransaction,
  type PlatformHumanIdentityContribution,
  PlatformIdentityError,
} from '@noodle-borg/module';
import type { BusinessGrant } from './contracts.js';

export type BusinessPrincipalProvider = Pick<
  PlatformHumanIdentityContribution,
  'principalResolver' | 'assertActivePrincipal'
>;

/** Uses the host's canonical authority; it never creates a second principal status store. */
export class BusinessPrincipalAuthority {
  #provider: BusinessPrincipalProvider | undefined;

  configure(provider: BusinessPrincipalProvider | undefined): void {
    this.#provider = provider;
  }

  async allows(subject: string, transaction?: ModuleSqlTransaction): Promise<boolean> {
    const provider = this.#provider;
    if (provider === undefined) return true;
    try {
      if (transaction === undefined) await provider.principalResolver.assertActive(subject);
      else {
        if (provider.assertActivePrincipal === undefined) {
          throw new Error('Business assignment requires transactional principal authority');
        }
        await provider.assertActivePrincipal(transaction, subject);
      }
      return true;
    } catch (error) {
      if (error instanceof PlatformIdentityError && error.code === 'principal_suspended') {
        return false;
      }
      throw error;
    }
  }

  async eligible(grants: readonly BusinessGrant[]): Promise<readonly BusinessGrant[]> {
    const result: BusinessGrant[] = [];
    for (const grant of grants) {
      if (
        grant.revokedAt === undefined &&
        grant.role !== 'viewer' &&
        grant.email !== undefined &&
        (await this.allows(grant.subject))
      )
        result.push(grant);
    }
    return result;
  }
}
