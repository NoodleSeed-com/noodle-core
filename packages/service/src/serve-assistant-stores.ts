import type { DailyCounterStore } from '@noodle-borg/admission-limits/portable';
import { PostgresDailyCounterStore } from '@noodle-borg/admission-limits/postgres';
import type {
  AssistantAppearanceSettingsStore,
  AssistantElevationStore,
  AssistantStore,
  PublicEmbedStore,
} from '@noodle-borg/assistant-gateway/portable';
import {
  PostgresAssistantAppearanceSettingsStore,
  PostgresAssistantElevationStore,
  PostgresAssistantStore,
  PostgresPublicEmbedStore,
} from '@noodle-borg/assistant-gateway/postgres';
import type { Pool } from 'pg';

/**
 * The five durable stores an assistant needs, built together because they are one concern: where an
 * assistant's state lives. Extracted from `serve.ts` so the composition root stays a wiring list rather
 * than also being a persistence factory.
 *
 * Each is skipped when the caller already supplied one, so a test or an embedded host can substitute a
 * fake without this file knowing.
 */
/** Whatever the caller already has; `undefined` is meaningful, so it survives rather than being dropped. */
export interface SuppliedAssistantStores {
  readonly assistantStore?: AssistantStore | undefined;
  readonly assistantAppearance?: AssistantAppearanceSettingsStore | undefined;
  readonly publicEmbeds?: PublicEmbedStore | undefined;
  readonly admissionCounters?: DailyCounterStore | undefined;
  readonly elevations?: AssistantElevationStore | undefined;
}

export interface AssistantStoreSet {
  readonly assistantStore: AssistantStore;
  readonly assistantAppearance: AssistantAppearanceSettingsStore;
  readonly publicEmbeds: PublicEmbedStore;
  readonly admissionCounters: DailyCounterStore;
  readonly elevations: AssistantElevationStore;
}

export async function createPostgresAssistantStores(
  pool: Pool,
  supplied: SuppliedAssistantStores,
): Promise<AssistantStoreSet> {
  let assistantStore = supplied.assistantStore;
  if (assistantStore === undefined) {
    const postgres = new PostgresAssistantStore(pool);
    await postgres.ensureSchema();
    assistantStore = postgres;
  }
  let assistantAppearance = supplied.assistantAppearance;
  if (assistantAppearance === undefined) {
    const postgres = new PostgresAssistantAppearanceSettingsStore(pool);
    await postgres.ensureSchema();
    assistantAppearance = postgres;
  }
  // Public surfaces are only served where their state is durable: a spend ceiling that resets on restart
  // and is unshared across instances is not a ceiling, so the gateway refuses a non-durable counter store
  // outright rather than serving strangers a budget that does not hold.
  let publicEmbeds = supplied.publicEmbeds;
  if (publicEmbeds === undefined) {
    const postgres = new PostgresPublicEmbedStore(pool);
    await postgres.ensureSchema();
    publicEmbeds = postgres;
  }
  let admissionCounters = supplied.admissionCounters;
  if (admissionCounters === undefined) {
    const postgres = new PostgresDailyCounterStore(pool);
    await postgres.ensureSchema();
    admissionCounters = postgres;
  }
  // Without an elevation store, a mixed surface never offers mid-conversation sign-in and a spent
  // ticket answers 503 elevation_unavailable — so hosted sign-in exists only if this is wired. The
  // ticket is minted on one instance and spent through another backend, so it must be durable.
  let elevations = supplied.elevations;
  if (elevations === undefined) {
    const postgres = new PostgresAssistantElevationStore(pool);
    await postgres.ensureSchema();
    elevations = postgres;
  }
  return { assistantStore, assistantAppearance, publicEmbeds, admissionCounters, elevations };
}

/**
 * The same five stores as service options, omitting any this deployment does not have. A service with
 * no public-surface stores serves authenticated embeds only, and the public mint route refuses outright
 * rather than half-working — so "absent" has to survive the handoff rather than become `undefined`.
 */
export function assistantStoreOptions(set: SuppliedAssistantStores): Partial<AssistantStoreSet> {
  return {
    ...(set.assistantStore ? { assistantStore: set.assistantStore } : {}),
    ...(set.assistantAppearance ? { assistantAppearance: set.assistantAppearance } : {}),
    ...(set.publicEmbeds ? { publicEmbeds: set.publicEmbeds } : {}),
    ...(set.admissionCounters ? { admissionCounters: set.admissionCounters } : {}),
    ...(set.elevations ? { elevations: set.elevations } : {}),
  };
}
