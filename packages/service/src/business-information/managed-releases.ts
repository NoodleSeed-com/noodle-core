import type {
  BuiltInProfileKey,
  InstalledCollectionDefinition,
  ManagedRequestRecord,
  SolutionDefinitionReference,
  SolutionDefinitionSnapshot,
  SolutionInstallation,
} from './contracts.js';
import { isLegacyRequestUpgrade } from './legacy-request-migration.js';
import { managedSolutionBlueprint } from './managed-solution-blueprints.js';
import {
  BUILT_IN_SOLUTION_PROFILE_RELEASES,
  builtInDefinition,
  builtInDefinitionAtRelease,
  isBuiltInProfileKey,
} from './profiles.js';

export type ManagedDefinitionResolver = (key: BuiltInProfileKey) => SolutionDefinitionSnapshot;
type ManagedDefinitionSnapshot = SolutionDefinitionSnapshot & {
  readonly reference: Extract<SolutionDefinitionReference, { kind: 'managed' }>;
};

/** Resolves the one service-wide stable release while preserving installation-owned configuration. */
export function resolveManagedInstallation(
  installation: SolutionInstallation,
  resolveCurrent: ManagedDefinitionResolver = builtInDefinition,
): SolutionInstallation {
  if (installation.definition.reference.kind !== 'managed') return cloneInstallation(installation);
  const key = installation.definition.reference.definitionId;
  const installed = registeredDefinition(key, installation.profileVersion);
  assertSameDefinition(installed, installation.definition, 'stored installation');
  const current = resolveCurrent(key);
  if (current.reference.kind !== 'managed' || current.reference.definitionId !== key) {
    throw new Error(`managed definition resolver returned the wrong definition for "${key}"`);
  }
  const registeredCurrent = registeredDefinition(key, current.reference.release);
  assertSameDefinition(registeredCurrent, current, 'managed definition resolver');
  if (current.reference.release < installed.reference.release) {
    throw new Error(
      `managed definition rollback "${key}@${current.reference.release}" requires accepted-record compatibility proof`,
    );
  }
  for (
    let release = installed.reference.release + 1;
    release <= current.reference.release;
    release += 1
  ) {
    const previous = registeredDefinition(key, release - 1);
    const next = registeredDefinition(key, release);
    assertCompatibleManagedRelease(previous, next);
  }
  for (const collection of installation.managedCollections) {
    if (!current.collections.some((candidate) => candidate.key === collection)) {
      throw new Error(`managed release removed enabled collection "${collection}"`);
    }
  }
  return cloneInstallation({
    ...installation,
    profileVersion: current.reference.release,
    managedCollections: [...installation.managedCollections],
    definition: current,
  });
}

/** Resolves the exact validator that accepted a stored row, independently of current presentation. */
export function collectionForStoredRecord(
  installation: SolutionInstallation,
  record: ManagedRequestRecord,
): InstalledCollectionDefinition {
  if (
    record.scope.org !== installation.scope.org ||
    record.scope.app !== installation.scope.app ||
    record.scope.env !== installation.scope.env ||
    record.scope.installationId !== installation.scope.installationId ||
    record.profileKey !== installation.profileKey
  ) {
    throw new Error('stored record does not belong to its solution installation');
  }
  let definition: SolutionDefinitionSnapshot;
  if (installation.definition.reference.kind === 'private') {
    definition = installation.definition;
    if (record.profileVersion !== installation.profileVersion) {
      throw new Error('stored private record uses an unsupported definition version');
    }
  } else {
    if (!isBuiltInProfileKey(record.profileKey)) {
      throw new Error(`stored record uses unknown profile "${record.profileKey}"`);
    }
    definition = builtInDefinitionAtRelease(record.profileKey, record.profileVersion);
  }
  const collection = definition.collections.find(
    (candidate) => candidate.key === record.collectionKey,
  );
  if (
    collection === undefined ||
    collection.schemaVersion !== record.schemaVersion ||
    normalizeDigest(collection.schemaDigest) !== normalizeDigest(record.schemaDigest)
  ) {
    throw new Error(
      `stored record uses unsupported schema identity "${record.profileKey}@${record.profileVersion}/${record.collectionKey}@${record.schemaVersion}:${record.schemaDigest}"`,
    );
  }
  return structuredClone(collection);
}

/** Release-gate proof: a rollback target must retain a validator for every accepted record identity. */
export function assertManagedRollbackReaders(
  key: BuiltInProfileKey,
  targetRelease: number,
  records: readonly Pick<
    ManagedRequestRecord,
    'profileKey' | 'profileVersion' | 'collectionKey' | 'schemaVersion' | 'schemaDigest'
  >[],
): void {
  const target = registeredDefinition(key, targetRelease);
  for (const record of records) {
    if (record.profileKey !== key) continue;
    if (record.profileVersion > target.reference.release) {
      throw new Error(
        `rollback target "${key}@${targetRelease}" cannot read accepted profile release ${record.profileVersion}`,
      );
    }
    const historical = registeredDefinition(key, record.profileVersion).collections.find(
      (collection) => collection.key === record.collectionKey,
    );
    if (
      historical === undefined ||
      historical.schemaVersion !== record.schemaVersion ||
      normalizeDigest(historical.schemaDigest) !== normalizeDigest(record.schemaDigest)
    ) {
      throw new Error(`rollback target cannot read accepted schema for "${record.collectionKey}"`);
    }
  }
}

export function assertCompatibleManagedRelease(
  previous: SolutionDefinitionSnapshot,
  next: SolutionDefinitionSnapshot,
): void {
  const previousReference = previous.reference;
  const nextReference = next.reference;
  if (
    previousReference.kind !== 'managed' ||
    nextReference.kind !== 'managed' ||
    previousReference.definitionId !== nextReference.definitionId ||
    nextReference.release !== previousReference.release + 1
  ) {
    throw new Error('managed releases must be consecutive revisions of one definition');
  }
  const previousTools = new Set((previous.variables ?? []).flatMap((entry) => entry.requiredFor));
  const blueprint = managedSolutionBlueprint(
    previousReference.definitionId,
    previousReference.release,
  );
  if (blueprint) previousTools.add(blueprint.tool);
  for (const setting of previous.variables ?? []) {
    const updated = next.variables?.find((entry) => entry.name === setting.name);
    if (
      !updated ||
      !compatibleProperty(setting.valueSchema, updated.valueSchema) ||
      (setting.portal !== undefined && updated.portal === undefined)
    )
      throw new Error(`managed release changed setting compatibility for "${setting.name}"`);
  }
  for (const setting of next.variables ?? []) {
    const old = previous.variables?.find((entry) => entry.name === setting.name);
    if (
      !Object.hasOwn(setting, 'default') &&
      setting.requiredFor.some(
        (tool) => previousTools.has(tool) && !old?.requiredFor.includes(tool),
      )
    )
      throw new Error(`managed release added an unresolved requirement for "${setting.name}"`);
  }
  for (const oldCollection of previous.collections) {
    const newCollection = next.collections.find((candidate) => candidate.key === oldCollection.key);
    if (newCollection === undefined) {
      throw new Error(`managed release removed collection "${oldCollection.key}"`);
    }
    if (stableJson(oldCollection.authority) !== stableJson(newCollection.authority)) {
      throw new Error(`managed release changed authority for "${oldCollection.key}"`);
    }
    if (
      stableJson(oldCollection.behavior) !== stableJson(newCollection.behavior) &&
      !isLegacyRequestUpgrade(oldCollection, newCollection)
    ) {
      throw new Error(`managed release changed behavior for "${oldCollection.key}"`);
    }
    if (
      !isLegacyRequestUpgrade(oldCollection, newCollection) &&
      stableJson(oldCollection.management) !== stableJson(newCollection.management)
    ) {
      throw new Error(`managed release changed native controls for "${oldCollection.key}"`);
    }
    assertCompatibleSchema(oldCollection, newCollection);
  }
}

function assertCompatibleSchema(
  previous: InstalledCollectionDefinition,
  next: InstalledCollectionDefinition,
): void {
  const oldSchema = objectSchema(previous.recordSchema, previous.key);
  const newSchema = objectSchema(next.recordSchema, next.key);
  if (
    oldSchema.type !== newSchema.type ||
    oldSchema.additionalProperties !== newSchema.additionalProperties ||
    stableJson(oldSchema.required) !== stableJson(newSchema.required)
  ) {
    throw new Error(`managed release changed required fields for "${previous.key}"`);
  }
  for (const [name, oldProperty] of Object.entries(oldSchema.properties)) {
    const newProperty = newSchema.properties[name];
    if (newProperty === undefined) {
      throw new Error(`managed release removed field "${previous.key}.${name}"`);
    }
    if (!compatibleProperty(oldProperty, newProperty)) {
      throw new Error(`managed release changed field semantics for "${previous.key}.${name}"`);
    }
  }
  const changed = stableJson(previous.recordSchema) !== stableJson(next.recordSchema);
  if (changed && next.schemaVersion <= previous.schemaVersion) {
    throw new Error(`managed release changed schema without advancing "${previous.key}" version`);
  }
  if (!changed && next.schemaVersion !== previous.schemaVersion) {
    throw new Error(`managed release advanced unchanged schema "${previous.key}"`);
  }
}

function compatibleProperty(previous: unknown, next: unknown): boolean {
  if (!isObject(previous) || !isObject(next)) return stableJson(previous) === stableJson(next);
  const oldEnum = stringArray(previous.enum);
  const newEnum = stringArray(next.enum);
  const withoutEnum = (value: Record<string, unknown>): Record<string, unknown> => {
    const { enum: ignored, ...rest } = value;
    void ignored;
    return rest;
  };
  if (stableJson(withoutEnum(previous)) !== stableJson(withoutEnum(next))) return false;
  if (oldEnum === undefined) return newEnum === undefined;
  return newEnum !== undefined && oldEnum.every((value) => newEnum.includes(value));
}

function objectSchema(
  schema: unknown,
  collection: string,
): {
  type: unknown;
  additionalProperties: unknown;
  required: unknown;
  properties: Record<string, unknown>;
} {
  if (!isObject(schema) || !isObject(schema.properties)) {
    throw new Error(`managed collection "${collection}" does not use a supported object schema`);
  }
  return {
    type: schema.type,
    additionalProperties: schema.additionalProperties,
    required: schema.required,
    properties: schema.properties,
  };
}

function registeredDefinition(key: BuiltInProfileKey, release: number): ManagedDefinitionSnapshot {
  const definition = builtInDefinitionAtRelease(key, release);
  if (definition.reference.kind !== 'managed') {
    throw new Error(`profile "${key}" is not a managed solution definition`);
  }
  return definition as ManagedDefinitionSnapshot;
}

function assertSameDefinition(
  expected: SolutionDefinitionSnapshot,
  actual: SolutionDefinitionSnapshot,
  source: string,
): void {
  if (stableJson(expected) !== stableJson(actual)) {
    throw new Error(`${source} does not match its immutable managed release`);
  }
}

function cloneInstallation(installation: SolutionInstallation): SolutionInstallation {
  return {
    ...installation,
    scope: { ...installation.scope },
    managedCollections: [...installation.managedCollections],
    definition: structuredClone(installation.definition),
  };
}

function normalizeDigest(value: string): string {
  return value.replace(/^sha256:/, '');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : undefined;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Immutable release rows used by schema backfill and release-gate inspection. */
export function builtInManagedReleaseDefinitions(): readonly SolutionDefinitionSnapshot[] {
  return (
    Object.entries(BUILT_IN_SOLUTION_PROFILE_RELEASES) as [
      BuiltInProfileKey,
      readonly { version: number }[],
    ][]
  ).flatMap(([key, releases]) =>
    releases
      .filter(() => key !== 'b2b_saas')
      .map((release) => builtInDefinitionAtRelease(key, release.version)),
  );
}

function validateBuiltInManagedReleaseRegistry(): void {
  for (const [key, releases] of Object.entries(BUILT_IN_SOLUTION_PROFILE_RELEASES) as [
    BuiltInProfileKey,
    readonly { version: number }[],
  ][]) {
    if (key === 'b2b_saas') continue;
    for (let index = 0; index < releases.length; index += 1) {
      if (releases[index]?.version !== index + 1) {
        throw new Error(`managed definition "${key}" release history must be contiguous`);
      }
      if (index > 0) {
        assertCompatibleManagedRelease(
          builtInDefinitionAtRelease(key, index),
          builtInDefinitionAtRelease(key, index + 1),
        );
      }
    }
  }
}

validateBuiltInManagedReleaseRegistry();
