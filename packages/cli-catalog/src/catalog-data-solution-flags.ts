/** Shared solution operator catalog data. No runtime dependencies. */
import type { FlagSpec } from './catalog-types.js';

export const OPTIONAL_FLAG = {
  required: false,
  repeatable: false,
  sensitive: false,
  aliases: [],
  conflictsWith: [],
} as const;

export const REQUIRED_ARGUMENT = {
  type: 'string',
  required: true,
  variadic: false,
  sensitive: false,
  constraints: {},
} as const;

const ORG: FlagSpec = {
  ...OPTIONAL_FLAG,
  name: 'org',
  type: 'string',
  value: '<slug>',
  summary: 'Organization slug.',
};

export const SERVICE: FlagSpec = {
  ...OPTIONAL_FLAG,
  name: 'service',
  type: 'string',
  value: '<url>',
  summary: 'Control-plane service URL.',
};

export const AUTH_TOKEN: FlagSpec = {
  ...OPTIONAL_FLAG,
  name: 'auth-token',
  type: 'string',
  value: '<token>',
  summary: 'Control-plane authentication token.',
  sensitive: true,
};

export const JSON_FLAG: FlagSpec = {
  ...OPTIONAL_FLAG,
  name: 'json',
  type: 'boolean',
  summary: 'Emit JSON output.',
};

export const INSTALLATION_ARGUMENT = {
  ...REQUIRED_ARGUMENT,
  name: 'installation',
  summary: 'Solution installation identifier.',
};

export const SOLUTION_COMMON_FLAGS: readonly FlagSpec[] = [ORG, SERVICE, AUTH_TOKEN, JSON_FLAG];

export const EXPECTED_REVISION: FlagSpec = {
  ...OPTIONAL_FLAG,
  name: 'expected-revision',
  type: 'integer',
  value: '<revision>',
  summary: 'Expected current resource revision.',
  required: true,
  constraints: { minimum: 1 },
};

export const IDEMPOTENCY_KEY: FlagSpec = {
  ...OPTIONAL_FLAG,
  name: 'idempotency-key',
  type: 'string',
  value: '<key>',
  summary: 'Retry-safe operation key.',
  required: true,
};

export const PAGING_FLAGS: readonly FlagSpec[] = [
  {
    ...OPTIONAL_FLAG,
    name: 'cursor',
    type: 'string',
    value: '<cursor>',
    summary: 'Opaque page cursor.',
  },
  {
    ...OPTIONAL_FLAG,
    name: 'limit',
    type: 'integer',
    value: '<count>',
    summary: 'Bounded page size.',
    constraints: { minimum: 1, maximum: 100 },
  },
];
