import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TenantRef } from '../store.js';
import {
  type AlertFiringState,
  type AlertRuleRecord,
  type AlertRuleStore,
  type CreateAlertRuleInput,
  compareAlertRules,
  newAlertRuleRecord,
  validateAlertRuleId,
  withFiringState,
} from './alert-rules.js';
import { validateSlug } from './validate.js';

/**
 * JSON-file {@link AlertRuleStore}: one file per rule at `<dataDir>/alert-rules/<id>.json`,
 * written atomically (temp file + `rename`, matching `JsonFileGithubConnectionStore`). Rule ids
 * are service-minted UUIDs and every read/write path re-validates the id shape, so an id is
 * always a safe filename component (no traversal).
 */
export class JsonFileAlertRuleStore implements AlertRuleStore {
  readonly #dir: string;
  readonly #now: () => Date;
  /** Serializes read-modify-write mutations (firing-state updates), mirroring the github file store. */
  #mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string, options: { now?: () => Date } = {}) {
    this.#dir = join(dataDir, 'alert-rules');
    this.#now = options.now ?? (() => new Date());
  }

  #withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#mutationQueue.then(operation, operation);
    this.#mutationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  createAlertRule(input: CreateAlertRuleInput): Promise<AlertRuleRecord> {
    return this.#withMutation(async () => {
      const record = newAlertRuleRecord(input, this.#now);
      await this.#writeRecord(record);
      return record;
    });
  }

  async listAlertRules(ref: TenantRef): Promise<readonly AlertRuleRecord[]> {
    const org = validateSlug('org', ref.org);
    const app = validateSlug('app', ref.app);
    const env = validateSlug('env', ref.env);
    return (await this.#loadAll())
      .filter(
        (record) => record.orgSlug === org && record.appSlug === app && record.environment === env,
      )
      .sort(compareAlertRules);
  }

  async getAlertRule(ref: TenantRef, id: string): Promise<AlertRuleRecord | undefined> {
    const org = validateSlug('org', ref.org);
    const app = validateSlug('app', ref.app);
    const env = validateSlug('env', ref.env);
    const record = await this.#readRecord(validateAlertRuleId(id));
    if (record === undefined) return undefined;
    return record.orgSlug === org && record.appSlug === app && record.environment === env
      ? record
      : undefined;
  }

  deleteAlertRule(ref: TenantRef, id: string): Promise<boolean> {
    return this.#withMutation(async () => {
      const found = await this.getAlertRule(ref, id);
      if (found === undefined) return false;
      await rm(join(this.#dir, `${found.id}.json`), { force: true });
      return true;
    });
  }

  async listEnabledAlertRules(): Promise<readonly AlertRuleRecord[]> {
    return (await this.#loadAll()).filter((record) => record.enabled);
  }

  updateAlertFiringState(
    id: string,
    state: AlertFiringState,
  ): Promise<AlertRuleRecord | undefined> {
    return this.#withMutation(async () => {
      const record = await this.#readRecord(validateAlertRuleId(id));
      if (record === undefined) return undefined;
      const updated = withFiringState(record, state);
      await this.#writeRecord(updated);
      return updated;
    });
  }

  async #readRecord(id: string): Promise<AlertRuleRecord | undefined> {
    try {
      const text = await readFile(join(this.#dir, `${id}.json`), 'utf8');
      return JSON.parse(text) as AlertRuleRecord;
    } catch {
      return undefined;
    }
  }

  async #loadAll(): Promise<readonly AlertRuleRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.#dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const records: AlertRuleRecord[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue; // skip in-flight *.tmp files
      try {
        const text = await readFile(join(this.#dir, name), 'utf8');
        records.push(JSON.parse(text) as AlertRuleRecord);
      } catch {
        // Fail-soft: a corrupt/unreadable record must not crash the caller — skip it.
      }
    }
    return records;
  }

  async #writeRecord(record: AlertRuleRecord): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    const target = join(this.#dir, `${record.id}.json`);
    const tmp = `${target}.${randomUUID()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    await rename(tmp, target);
  }
}
