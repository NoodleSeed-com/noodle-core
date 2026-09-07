import { createHash } from 'node:crypto';
import type {
  BuiltInProfileKey,
  InstalledCollectionDefinition,
  JsonObject,
  SolutionDefinitionSnapshot,
} from './contracts.js';
import {
  managedSolutionBlueprint,
  managedSolutionVariables,
} from './managed-solution-blueprints.js';
import { PayloadValidationError, validateManagedPayload, validateScalar } from './validation.js';

export interface ManagedRequestJsonSchema {
  readonly $schema: 'https://json-schema.org/draft/2020-12/schema';
  readonly type: 'object';
  readonly additionalProperties: false;
  readonly required: readonly string[];
  readonly properties: Readonly<
    Record<
      string,
      {
        readonly type: 'string';
        readonly minLength?: number;
        readonly maxLength: number;
        readonly enum?: readonly string[];
        readonly default?: string;
      }
    >
  >;
}

export interface ManagedCollectionProfile {
  readonly management?: { readonly assignment?: true; readonly notes?: true };
  readonly publicFields?: readonly string[];
  readonly key: string;
  readonly schemaVersion: number;
  readonly schemaDigest: string;
  readonly labels: {
    readonly singular: string;
    readonly plural: string;
    readonly navigation: string;
  };
  readonly schema: ManagedRequestJsonSchema;
}

export interface BuiltInSolutionProfile {
  readonly key: BuiltInProfileKey;
  readonly version: number;
  readonly label: string;
  readonly collections: readonly ManagedCollectionProfile[];
}

const requestSchema = (
  required: readonly string[],
  properties: ManagedRequestJsonSchema['properties'],
): ManagedRequestJsonSchema => ({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required,
  properties,
});

function collection(
  key: string,
  labels: ManagedCollectionProfile['labels'],
  schema: ManagedRequestJsonSchema,
  schemaVersion = 1,
): ManagedCollectionProfile {
  return {
    key,
    schemaVersion,
    schemaDigest: createHash('sha256').update(stableJson(schema)).digest('hex'),
    labels,
    schema,
  };
}

const travelV1 = collection(
  'travel_requests',
  { singular: 'Travel request', plural: 'Travel requests', navigation: 'Requests' },
  requestSchema(['request_type', 'summary'], {
    request_type: {
      type: 'string',
      enum: ['service', 'cancellation', 'refund', 'recovery'],
      maxLength: 32,
    },
    summary: { type: 'string', minLength: 1, maxLength: 2000 },
    booking_reference: { type: 'string', maxLength: 128 },
    traveler_reference: { type: 'string', maxLength: 128 },
  }),
);

const travelV2 = collection(
  'travel_requests',
  { singular: 'Travel request', plural: 'Travel requests', navigation: 'Requests' },
  requestSchema(['request_type', 'summary'], {
    request_type: {
      type: 'string',
      enum: ['service', 'cancellation', 'refund', 'recovery', 'information'],
      maxLength: 32,
    },
    summary: { type: 'string', minLength: 1, maxLength: 2000 },
    booking_reference: { type: 'string', maxLength: 128 },
    traveler_reference: { type: 'string', maxLength: 128 },
    priority: { type: 'string', enum: ['normal', 'urgent'], maxLength: 16 },
  }),
  2,
);

const service = collection(
  'service_requests',
  { singular: 'Service request', plural: 'Service requests', navigation: 'Requests' },
  requestSchema(['request_type', 'summary'], {
    request_type: {
      type: 'string',
      enum: ['support', 'access', 'configuration', 'recovery'],
      maxLength: 32,
    },
    summary: { type: 'string', minLength: 1, maxLength: 2000 },
    account_reference: { type: 'string', maxLength: 128 },
    workspace_reference: { type: 'string', maxLength: 128 },
  }),
);

const ecommerce = collection(
  'return_requests',
  { singular: 'Return request', plural: 'Return requests', navigation: 'Returns' },
  requestSchema(['order_reference', 'reason'], {
    order_reference: { type: 'string', minLength: 1, maxLength: 128 },
    reason: { type: 'string', minLength: 1, maxLength: 2000 },
    item_reference: { type: 'string', maxLength: 128 },
    requested_resolution: {
      type: 'string',
      enum: ['refund', 'exchange', 'store_credit', 'support'],
      maxLength: 32,
    },
  }),
);

const restaurant = collection(
  'guest_requests',
  { singular: 'Guest request', plural: 'Guest requests', navigation: 'Guest requests' },
  requestSchema(['request_type', 'summary'], {
    request_type: {
      type: 'string',
      enum: ['reservation_help', 'order_help', 'feedback', 'recovery'],
      maxLength: 32,
    },
    summary: { type: 'string', minLength: 1, maxLength: 2000 },
    location_reference: { type: 'string', maxLength: 128 },
    reservation_reference: { type: 'string', maxLength: 128 },
  }),
);

export const BUILT_IN_SOLUTION_PROFILE_RELEASES: Readonly<
  Record<BuiltInProfileKey, readonly BuiltInSolutionProfile[]>
> = {
  travel: [
    { key: 'travel', version: 1, label: 'Travel', collections: [travelV1] },
    { key: 'travel', version: 2, label: 'Travel', collections: [travelV2] },
    { key: 'travel', version: 3, label: 'Travel', collections: [lightweightCollection(travelV2)] },
  ],
  b2b_saas: [{ key: 'b2b_saas', version: 1, label: 'B2B SaaS', collections: [service] }],
  ecommerce: [
    { key: 'ecommerce', version: 1, label: 'Ecommerce', collections: [ecommerce] },
    {
      key: 'ecommerce',
      version: 2,
      label: 'Ecommerce',
      collections: [lightweightCollection(ecommerce)],
    },
  ],
  restaurant: [
    { key: 'restaurant', version: 1, label: 'Restaurant', collections: [restaurant] },
    {
      key: 'restaurant',
      version: 2,
      label: 'Restaurant',
      collections: [lightweightCollection(restaurant)],
    },
  ],
};

export const BUILT_IN_SOLUTION_PROFILES: Readonly<
  Record<BuiltInProfileKey, BuiltInSolutionProfile>
> = {
  travel: currentProfile('travel'),
  b2b_saas: { key: 'b2b_saas', version: 1, label: 'B2B SaaS', collections: [service] },
  ecommerce: currentProfile('ecommerce'),
  restaurant: currentProfile('restaurant'),
};

/** Public managed catalog. The legacy SaaS request profile remains readable but cannot be newly sold. */
export const MANAGED_SOLUTION_PROFILE_KEYS = ['travel', 'ecommerce', 'restaurant'] as const;

export function builtInProfile(key: BuiltInProfileKey): BuiltInSolutionProfile {
  const profile = BUILT_IN_SOLUTION_PROFILES[key];
  if (profile === undefined) throw new Error(`unknown built-in solution profile "${String(key)}"`);
  return profile;
}

export function builtInProfileAtRelease(
  key: BuiltInProfileKey,
  release: number,
): BuiltInSolutionProfile {
  const profile = BUILT_IN_SOLUTION_PROFILE_RELEASES[key].find(
    (candidate) => candidate.version === release,
  );
  if (profile === undefined) {
    throw new Error(`unsupported built-in solution profile release "${key}@${release}"`);
  }
  return profile;
}

export function isBuiltInProfileKey(value: string): value is BuiltInProfileKey {
  return (
    value === 'travel' || value === 'b2b_saas' || value === 'ecommerce' || value === 'restaurant'
  );
}

export function builtInCollection(
  profileKey: BuiltInProfileKey,
  collectionKey: string,
): ManagedCollectionProfile {
  const normalized = validateScalar('collection key', collectionKey, 64);
  const found = builtInProfile(profileKey).collections.find(
    (candidate) => candidate.key === normalized,
  );
  if (found === undefined) {
    throw new Error(`collection "${normalized}" is not declared by profile "${profileKey}"`);
  }
  return found;
}

export function validateProfilePayload(
  profileKey: BuiltInProfileKey,
  collectionKey: string,
  value: unknown,
): JsonObject {
  const payload = validateManagedPayload(value);
  const collectionProfile = builtInCollection(profileKey, collectionKey);
  validateJsonSchema(collectionProfile.schema, payload);
  return payload;
}

export function builtInDefinition(key: BuiltInProfileKey): SolutionDefinitionSnapshot {
  return definitionFromProfile(builtInProfile(key));
}

export function builtInDefinitionAtRelease(
  key: BuiltInProfileKey,
  release: number,
): SolutionDefinitionSnapshot {
  return definitionFromProfile(builtInProfileAtRelease(key, release));
}

function definitionFromProfile(profile: BuiltInSolutionProfile): SolutionDefinitionSnapshot {
  const { key } = profile;
  const blueprint = managedSolutionBlueprint(key, profile.version);
  const variables = blueprint === undefined ? undefined : managedSolutionVariables();
  const digest = createHash('sha256')
    .update(
      stableJson({
        key: profile.key,
        version: profile.version,
        collections: profile.collections,
        ...(blueprint === undefined ? {} : { blueprint, variables }),
      }),
    )
    .digest('hex');
  return {
    reference:
      key === 'b2b_saas'
        ? { kind: 'legacy', definitionId: 'b2b_saas', release: profile.version, digest }
        : {
            kind: 'managed',
            definitionId: key,
            release: profile.version,
            digest,
          },
    title: profile.label,
    description: `Receive and operate ${profile.collections[0]?.labels.plural.toLowerCase() ?? 'business records'}.`,
    collections: profile.collections.map(collectionDefinition),
    ...(variables === undefined ? {} : { variables }),
  };
}

function currentProfile(key: BuiltInProfileKey): BuiltInSolutionProfile {
  const releases = BUILT_IN_SOLUTION_PROFILE_RELEASES[key];
  const profile = releases.at(-1);
  if (profile === undefined) throw new Error(`built-in solution profile "${key}" has no releases`);
  return profile;
}

function collectionDefinition(profile: ManagedCollectionProfile): InstalledCollectionDefinition {
  return {
    key: profile.key,
    title: profile.labels.plural,
    singularTitle: profile.labels.singular,
    description: `Managed ${profile.labels.plural.toLowerCase()} for this application.`,
    schemaVersion: profile.schemaVersion,
    schemaDigest: profile.schemaDigest,
    recordSchema: structuredClone(profile.schema) as unknown as JsonObject,
    summaryFields: profile.schema.required.slice(0, 6),
    authority: { authority: 'native' },
    ...(profile.management === undefined
      ? { behavior: { kind: 'request' as const } }
      : {
          management: profile.management,
          publicFields: profile.publicFields ?? [],
          editableFields: Object.keys(profile.schema.properties),
          fields: { status: { label: 'Status' } },
          filterFields: ['status'],
          sortFields: ['status'],
        }),
  };
}

function lightweightCollection(previous: ManagedCollectionProfile): ManagedCollectionProfile {
  return {
    ...collection(
      previous.key,
      previous.labels,
      {
        ...previous.schema,
        properties: {
          ...previous.schema.properties,
          status: {
            type: 'string',
            enum: ['new', 'in_progress', 'resolved', 'closed'],
            maxLength: 32,
            default: 'new',
          },
        },
      },
      previous.schemaVersion + 1,
    ),
    management: { assignment: true, notes: true },
    publicFields: Object.keys(previous.schema.properties),
  };
}

function validateJsonSchema(schema: ManagedRequestJsonSchema, payload: JsonObject): void {
  for (const required of schema.required) {
    if (!(required in payload)) {
      throw new PayloadValidationError('invalid_json', `managed payload requires "${required}"`);
    }
  }
  for (const [key, value] of Object.entries(payload)) {
    const property = schema.properties[key];
    if (property === undefined) {
      throw new PayloadValidationError(
        'invalid_json',
        `managed payload field "${key}" is undeclared`,
      );
    }
    if (typeof value !== 'string') {
      throw new PayloadValidationError(
        'invalid_json',
        `managed payload field "${key}" must be a string`,
      );
    }
    if (property.minLength !== undefined && value.length < property.minLength) {
      throw new PayloadValidationError(
        'invalid_json',
        `managed payload field "${key}" is too short`,
      );
    }
    if (value.length > property.maxLength) {
      throw new PayloadValidationError(
        'invalid_json',
        `managed payload field "${key}" is too long`,
      );
    }
    if (property.enum !== undefined && !property.enum.includes(value)) {
      throw new PayloadValidationError(
        'invalid_json',
        `managed payload field "${key}" has an unsupported value`,
      );
    }
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
