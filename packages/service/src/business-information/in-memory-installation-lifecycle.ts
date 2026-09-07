import {
  BusinessNoticeError,
  type BusinessNoticeInput,
  type BusinessNoticeRecord,
  validatedNotice,
} from './business-notice.js';
import type {
  BusinessGrant,
  BusinessInformationStore,
  InstallationMutationResult,
  InstallationScope,
  SolutionInstallation,
} from './contracts.js';
import type { ManagedDefinitionResolver } from './managed-releases.js';
import { effectiveInstallation, validateExpectedRevision } from './model.js';
import { scopeKey } from './pagination.js';
import { validateScalar, validateScope } from './validation.js';

export type InstallationApplicationResolver = (scope: InstallationScope) => Promise<
  | {
      readonly generation: string;
      readonly active: boolean;
    }
  | undefined
>;

/** Process-local lifecycle serialization shares the native intake lock. */
export class InMemoryInstallationLifecycle {
  readonly #installations: Map<string, SolutionInstallation>;
  readonly #withLock: <T>(key: string, operation: () => Promise<T>) => Promise<T>;
  readonly #now: () => Date;
  readonly #managedDefinition: ManagedDefinitionResolver | undefined;
  #application: InstallationApplicationResolver | undefined;
  readonly #notices = new Map<string, BusinessNoticeRecord>();
  readonly #getGrant: (scope: InstallationScope, subject: string) => BusinessGrant | undefined;
  constructor(input: {
    installations: Map<string, SolutionInstallation>;
    getGrant: (scope: InstallationScope, subject: string) => BusinessGrant | undefined;
    withLock: <T>(key: string, operation: () => Promise<T>) => Promise<T>;
    now: () => Date;
    managedDefinition: ManagedDefinitionResolver | undefined;
  }) {
    this.#installations = input.installations;
    this.#getGrant = input.getGrant;
    this.#withLock = input.withLock;
    this.#now = input.now;
    this.#managedDefinition = input.managedDefinition;
  }
  getInstallation(scope: InstallationScope): Promise<SolutionInstallation | undefined> {
    const found = this.#installations.get(scopeKey(validateScope(scope)));
    return Promise.resolve(
      found === undefined ? undefined : effectiveInstallation(found, this.#managedDefinition),
    );
  }

  listInstallations(org: string): Promise<readonly SolutionInstallation[]> {
    const normalized = validateScalar('organization', org, 63);
    return Promise.resolve(
      [...this.#installations.values()]
        .filter((installation) => installation.scope.org === normalized)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .map((installation) => effectiveInstallation(installation, this.#managedDefinition)),
    );
  }

  getBusinessNotice(scope: InstallationScope): Promise<BusinessNoticeRecord | undefined> {
    return Promise.resolve(structuredClone(this.#notices.get(scopeKey(validateScope(scope)))));
  }

  async setBusinessNotice(input: BusinessNoticeInput): Promise<BusinessNoticeRecord> {
    const scope = validateScope(input.scope);
    const notice = validatedNotice(input);
    return this.#withLock(`grants:${scopeKey(scope)}`, async () => {
      const grant = this.#getGrant(scope, input.actorSubject);
      if (grant?.role !== 'administrator' || grant.revokedAt)
        throw new BusinessNoticeError('business_notice_forbidden');
      const key = scopeKey(scope);
      const current = this.#notices.get(key);
      if ((current?.revision ?? 0) !== input.expectedRevision)
        throw new BusinessNoticeError('business_notice_conflict');
      const record = {
        notice,
        revision: input.expectedRevision + 1,
        updatedAt: this.#now().toISOString(),
        updatedBySubject: input.actorSubject,
      };
      this.#notices.set(key, record);
      return structuredClone(record);
    });
  }

  configureApplicationLifecycle(resolve: InstallationApplicationResolver) {
    this.#application = resolve;
  }
  async applicationAllows(installation: SolutionInstallation): Promise<boolean> {
    if (!this.#application) return true;
    const app = await this.#application(installation.scope);
    return app?.active === true && app.generation === installation.applicationGeneration;
  }
  async bindApplication(scope: InstallationScope, generation: string): Promise<boolean> {
    if (!Number.isFinite(Date.parse(generation))) return false;
    return this.#withLock(`intake:${scopeKey(scope)}`, async () => {
      const current = this.#installations.get(scopeKey(scope));
      if (!current) return false;
      const app = await this.#application?.(scope);
      if (this.#application && (!app?.active || app.generation !== generation)) return false;
      if (current.applicationGeneration === generation) return true;
      if (
        current.applicationGeneration !== 'pending' &&
        (current.applicationGeneration !== undefined ||
          Date.parse(generation) > Date.parse(current.createdAt))
      )
        return false;
      this.#installations.set(scopeKey(scope), { ...current, applicationGeneration: generation });
      return true;
    });
  }
  async pauseApplication(org: string, app: string, at: string, retired = false): Promise<void> {
    for (const installation of this.#installations.values()) {
      if (installation.scope.org !== org || installation.scope.app !== app) continue;
      await this.#withLock(`intake:${scopeKey(installation.scope)}`, async () => {
        const current = this.#installations.get(scopeKey(installation.scope));
        if (
          current &&
          (current.intakeActive || (retired && current.applicationGeneration !== 'retired'))
        )
          this.#installations.set(scopeKey(current.scope), {
            ...current,
            intakeActive: false,
            revision: current.revision + 1,
            updatedAt: at,
            updatedBySubject: retired ? 'noodle:application-purge' : 'noodle:application-archive',
            ...(retired ? { applicationGeneration: 'retired' } : {}),
          });
      });
    }
  }
  async setIntakeState(
    input: Parameters<BusinessInformationStore['setIntakeState']>[0],
  ): Promise<InstallationMutationResult> {
    const scope = validateScope(input.scope);
    validateExpectedRevision(input.expectedRevision);
    const actor = validateScalar('actor subject', input.actorSubject, 256);
    return this.#withLock(`intake:${scopeKey(scope)}`, async () => {
      const key = scopeKey(scope);
      const current = this.#installations.get(key);
      if (current === undefined) return { ok: false, reason: 'not_found', currentRevision: 0 };
      if (current.revision !== input.expectedRevision) {
        return { ok: false, reason: 'conflict', currentRevision: current.revision };
      }
      if (input.active && !(await this.applicationAllows(current)))
        return { ok: false, reason: 'application_unavailable', currentRevision: current.revision };
      if (current.intakeActive === input.active) {
        return { ok: false, reason: 'invalid_state', currentRevision: current.revision };
      }
      const installation: SolutionInstallation = {
        ...current,
        intakeActive: input.active,
        revision: current.revision + 1,
        updatedAt: this.#now().toISOString(),
        updatedBySubject: actor,
      };
      this.#installations.set(key, installation);
      return {
        ok: true,
        installation: effectiveInstallation(installation, this.#managedDefinition),
      };
    });
  }
}
