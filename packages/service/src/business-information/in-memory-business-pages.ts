import {
  BusinessPageError,
  type BusinessPageInput,
  type BusinessPageReadiness,
  type BusinessPageRecord,
  type BusinessPageStore,
  nextBusinessPage,
} from './business-page.js';
import type { BusinessInformationStore, InstallationScope } from './contracts.js';
import type { BusinessMemoryLocks } from './in-memory-locks.js';
import { scopeKey } from './pagination.js';
import type { BusinessPrincipalAuthority } from './principal-authority.js';
import { validateScalar, validateScope } from './validation.js';

/** Process-local test/development adapter; shares installation grant authority and its locks. */
export class InMemoryBusinessPages implements BusinessPageStore {
  readonly #records = new Map<string, BusinessPageRecord>();
  constructor(
    private readonly business: Pick<
      BusinessInformationStore,
      'getInstallation' | 'getGrant' | 'getBusinessNotice'
    >,
    private readonly locks: BusinessMemoryLocks,
    private readonly principals: BusinessPrincipalAuthority,
    private readonly now: () => Date,
  ) {}
  async get(scope: InstallationScope): Promise<BusinessPageRecord | undefined> {
    return structuredClone(this.#records.get(scopeKey(validateScope(scope))));
  }
  async update(
    input: BusinessPageInput,
    assertReady?: BusinessPageReadiness,
  ): Promise<BusinessPageRecord> {
    const scope = validateScope(input.scope);
    const actorSubject = validateScalar('page actor', input.actorSubject, 500);
    const key = scopeKey(scope);
    return this.locks.run(`grants:${key}`, () =>
      this.locks.run(`intake:${key}`, async () => {
        const grant = await this.business.getGrant(scope, actorSubject);
        if (
          !(await this.business.getInstallation(scope)) ||
          grant?.role !== 'administrator' ||
          grant.revokedAt ||
          !(await this.principals.allows(actorSubject))
        )
          throw new BusinessPageError('business_page_forbidden');
        const next = await nextBusinessPage(
          this.#records.get(key),
          { ...input, scope, actorSubject },
          this.now().toISOString(),
          await this.business.getBusinessNotice(scope),
          assertReady,
        );
        this.#records.set(key, structuredClone(next));
        return next;
      }),
    );
  }
}
