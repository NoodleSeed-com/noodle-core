/**
 * Catalog data for the restricted WorkOS platform-auth migration operator. Pure data — no imports
 * beyond types — so the compiled CLI and raw-source documentation generator can both load it.
 */
import type { CommandSpec, FlagSpec, SubcommandSpec } from './catalog-types.js';

const FLAG_FIELDS = {
  required: false,
  repeatable: false,
  sensitive: false,
  aliases: [],
  conflictsWith: [],
} as const;
const SUBCOMMAND_FIELDS = { arguments: [], flags: [] } as const;
const NO_FLAGS: readonly FlagSpec[] = [];

function flag(value: FlagSpec): FlagSpec {
  return value;
}

function subcommand(value: SubcommandSpec): SubcommandSpec {
  return value;
}

const SERVICE_FLAG = flag({
  ...FLAG_FIELDS,
  name: 'service',
  type: 'string',
  value: '<url>',
  summary: 'Control-plane service URL.',
});
const AUTH_TOKEN_FLAG = flag({
  ...FLAG_FIELDS,
  name: 'auth-token',
  type: 'string',
  value: '<token>',
  summary: 'Control-plane authentication token.',
  sensitive: true,
});
const JSON_FLAG = flag({
  ...FLAG_FIELDS,
  name: 'json',
  type: 'boolean',
  summary: 'Emit one JSON result envelope.',
});
const YES_FLAG = flag({
  ...FLAG_FIELDS,
  name: 'yes',
  type: 'boolean',
  summary: 'Confirm an approved mutation non-interactively.',
});
const COMMON_FLAGS: readonly FlagSpec[] = [SERVICE_FLAG, AUTH_TOKEN_FLAG, JSON_FLAG];

const EXPECTED_GENERATION_FLAG = flag({
  ...FLAG_FIELDS,
  name: 'expected-generation',
  type: 'integer',
  value: '<n>',
  summary: 'Inventory generation the mutation is approved against.',
  required: true,
  constraints: { minimum: 0 },
});
const RELEASE_SHA_FLAG = flag({
  ...FLAG_FIELDS,
  name: 'release-sha',
  type: 'string',
  value: '<sha>',
  summary: 'Exact lowercase release commit approved for the mutation.',
  required: true,
  constraints: { minLength: 40, maxLength: 40 },
});
const PREVIEW_CHECKSUM_FLAG = flag({
  ...FLAG_FIELDS,
  name: 'preview-checksum',
  type: 'string',
  value: '<checksum>',
  summary: 'Checksum of the approved operation preview.',
  required: true,
  sensitive: true,
  constraints: { minLength: 64, maxLength: 64 },
});
const IDEMPOTENCY_KEY_FLAG = flag({
  ...FLAG_FIELDS,
  name: 'idempotency-key',
  type: 'string',
  value: '<key>',
  summary: 'Private replay key for an approved mutation.',
  required: true,
  sensitive: true,
  constraints: { minLength: 8, maxLength: 256 },
});
const REASON_FLAG = flag({
  ...FLAG_FIELDS,
  name: 'reason',
  type: 'string',
  value: '<text>',
  summary: 'Operator reason recorded with the mutation.',
  required: true,
  constraints: { minLength: 1, maxLength: 256 },
});
const MUTATION_EVIDENCE_FLAGS: readonly FlagSpec[] = [
  EXPECTED_GENERATION_FLAG,
  RELEASE_SHA_FLAG,
  PREVIEW_CHECKSUM_FLAG,
  IDEMPOTENCY_KEY_FLAG,
  REASON_FLAG,
  YES_FLAG,
];

const BATCH_SIZE_FLAG = flag({
  ...FLAG_FIELDS,
  name: 'batch-size',
  type: 'integer',
  value: '<1-100>',
  summary: 'Maximum identities advanced by one bounded operation.',
  required: true,
  constraints: { minimum: 1, maximum: 100 },
});
const PERCENTAGE_FLAG = flag({
  ...FLAG_FIELDS,
  name: 'percentage',
  type: 'integer',
  value: '<1-100>',
  summary: 'Percentage of platform authentication traffic assigned to WorkOS.',
  required: true,
  constraints: { minimum: 1, maximum: 100 },
});
const COHORT_MODE_FLAG = flag({
  ...FLAG_FIELDS,
  name: 'cohort-mode',
  type: 'string',
  value: '<mode>',
  summary: 'Whether activation preserves or replaces the current client cohorts.',
  required: true,
  constraints: { choices: ['preserve', 'replace'] },
});
const CANARY_CLIENT_FLAG = flag({
  ...FLAG_FIELDS,
  name: 'canary-client-id',
  type: 'string',
  value: '<id>',
  summary: 'Canary client included when replacing activation cohorts.',
  repeatable: true,
});
const RECOVERY_CLIENT_FLAG = flag({
  ...FLAG_FIELDS,
  name: 'recovery-client-id',
  type: 'string',
  value: '<id>',
  summary: 'Recovery client included when replacing activation cohorts.',
  repeatable: true,
});
const ACCELERATION_APPROVAL_FLAG = flag({
  ...FLAG_FIELDS,
  name: 'acceleration-approval',
  type: 'string',
  value: '<path>',
  summary:
    'Optional mode-0600 typed approval for the exact accelerated WorkOS stage transition; activate only.',
  sensitive: true,
});
const FINALIZATION_FLAGS: readonly FlagSpec[] = [
  flag({
    ...FLAG_FIELDS,
    name: 'rollback-rehearsal-checksum',
    type: 'string',
    value: '<checksum>',
    summary: 'Checksum of the approved rollback rehearsal evidence.',
    required: true,
    sensitive: true,
    constraints: { minLength: 64, maxLength: 64 },
  }),
  flag({
    ...FLAG_FIELDS,
    name: 'staging-workos-only-smoke-checksum',
    type: 'string',
    value: '<checksum>',
    summary: 'Checksum of the approved staging WorkOS-only smoke evidence.',
    required: true,
    sensitive: true,
    constraints: { minLength: 64, maxLength: 64 },
  }),
];

function leaf(name: string, summary: string, flags: readonly FlagSpec[]): SubcommandSpec {
  return subcommand({
    ...SUBCOMMAND_FIELDS,
    name,
    summary,
    flags: [...flags, ...COMMON_FLAGS],
    jsonOutput: { mode: 'single' },
  });
}

const MIGRATION_ACTIONS: readonly SubcommandSpec[] = [
  leaf('inventory', 'Build or inspect a bounded identity inventory generation.', [
    flag({
      ...FLAG_FIELDS,
      name: 'generation',
      type: 'integer',
      value: '<n>',
      summary: 'Reuse the same generation until inventory reaches a terminal state.',
      constraints: { default: 0, minimum: 0 },
    }),
  ]),
  leaf('preview', 'Preview one migration operation without changing state.', [
    flag({
      ...FLAG_FIELDS,
      name: 'operation',
      type: 'string',
      value: '<operation>',
      summary: 'Migration operation to preview.',
      required: true,
      constraints: {
        choices: [
          'start_import',
          'reconcile',
          'recover_outbox',
          'activate',
          'rollback',
          'finalize',
        ],
      },
    }),
    flag({
      ...FLAG_FIELDS,
      ...BATCH_SIZE_FLAG,
      required: false,
      constraints: { default: 100, minimum: 1, maximum: 100 },
    }),
    flag({ ...FLAG_FIELDS, ...PERCENTAGE_FLAG, required: false }),
    flag({ ...FLAG_FIELDS, ...COHORT_MODE_FLAG, required: false }),
    CANARY_CLIENT_FLAG,
    RECOVERY_CLIENT_FLAG,
    ACCELERATION_APPROVAL_FLAG,
    ...FINALIZATION_FLAGS.map((item) => flag({ ...FLAG_FIELDS, ...item, required: false })),
  ]),
  leaf('status', 'Inspect the current migration and rollout state.', NO_FLAGS),
  leaf('start-import', 'Start the approved WorkOS identity import.', MUTATION_EVIDENCE_FLAGS),
  leaf('reconcile', 'Advance one approved reconciliation batch.', [
    BATCH_SIZE_FLAG,
    ...MUTATION_EVIDENCE_FLAGS,
  ]),
  leaf('recover-outbox', 'Advance one approved outbox-recovery batch.', [
    BATCH_SIZE_FLAG,
    ...MUTATION_EVIDENCE_FLAGS,
  ]),
  leaf('activate', 'Activate the approved WorkOS traffic cohort.', [
    PERCENTAGE_FLAG,
    COHORT_MODE_FLAG,
    CANARY_CLIENT_FLAG,
    RECOVERY_CLIENT_FLAG,
    ACCELERATION_APPROVAL_FLAG,
    ...MUTATION_EVIDENCE_FLAGS,
  ]),
  leaf('rollback', 'Roll back the approved WorkOS activation.', MUTATION_EVIDENCE_FLAGS),
  leaf('finalize', 'Finalize the approved WorkOS federation migration.', [
    ...FINALIZATION_FLAGS,
    ...MUTATION_EVIDENCE_FLAGS,
  ]),
];

const MIGRATION_SUBCOMMAND: SubcommandSpec = subcommand({
  ...SUBCOMMAND_FIELDS,
  name: 'migration',
  summary: 'Inventory, import, reconcile, activate, roll back, or finalize WorkOS federation.',
  subcommands: MIGRATION_ACTIONS,
});

const RESET_OPERATION_ID_FLAG = flag({
  ...FLAG_FIELDS,
  name: 'operation-id',
  type: 'string',
  value: '<reset-operation-id>',
  summary:
    'For rollback/finalize previews this identifier is required; it is forbidden for quarantine previews, status and mutations require it.',
  required: true,
  sensitive: true,
  constraints: { minLength: 8, maxLength: 256 },
});
const RESET_TARGET_FILE_FLAG = flag({
  ...FLAG_FIELDS,
  name: 'target-file',
  type: 'string',
  value: '<path>',
  summary:
    'For quarantine previews this flag is required; it is forbidden for rollback/finalize previews. Secure 0600 JSON file containing exactly three principal IDs.',
  sensitive: true,
});
const RESET_PREVIEW_OPERATION_FLAG = flag({
  ...FLAG_FIELDS,
  name: 'operation',
  type: 'string',
  value: '<operation>',
  summary: 'Account-reset operation to preview.',
  required: true,
  constraints: { choices: ['quarantine', 'rollback', 'finalize'] },
});
const RESET_YES_FLAG = flag({
  ...YES_FLAG,
  required: true,
  summary: 'Required confirmation for an approved account-reset mutation.',
});
const RESET_MUTATION_EVIDENCE_FLAGS: readonly FlagSpec[] = [
  EXPECTED_GENERATION_FLAG,
  RELEASE_SHA_FLAG,
  PREVIEW_CHECKSUM_FLAG,
  IDEMPOTENCY_KEY_FLAG,
  REASON_FLAG,
  RESET_YES_FLAG,
];
const ACCOUNT_RESET_ACTIONS: readonly SubcommandSpec[] = [
  leaf(
    'preview',
    'Preview one account-reset operation without changing state; flags are conditional.',
    [
      RESET_PREVIEW_OPERATION_FLAG,
      flag({ ...FLAG_FIELDS, ...RESET_TARGET_FILE_FLAG, required: false }),
      flag({ ...FLAG_FIELDS, ...RESET_OPERATION_ID_FLAG, required: false }),
    ],
  ),
  leaf('status', 'Inspect one account-reset operation using its opaque identifier.', [
    RESET_OPERATION_ID_FLAG,
  ]),
  leaf('quarantine', 'Quarantine the three approved account-reset targets.', [
    RESET_OPERATION_ID_FLAG,
    ...RESET_MUTATION_EVIDENCE_FLAGS,
  ]),
  leaf('rollback', 'Restore the three quarantined account-reset targets.', [
    RESET_OPERATION_ID_FLAG,
    ...RESET_MUTATION_EVIDENCE_FLAGS,
  ]),
  leaf('finalize', 'Finalize cleanup for the three approved account-reset targets.', [
    RESET_OPERATION_ID_FLAG,
    ...RESET_MUTATION_EVIDENCE_FLAGS,
  ]),
];
const ACCOUNT_RESET_SUBCOMMAND: SubcommandSpec = subcommand({
  ...SUBCOMMAND_FIELDS,
  name: 'account-reset',
  summary: 'Operate the private exact-three platform account reset.',
  subcommands: ACCOUNT_RESET_ACTIONS,
});

export const CATALOG_PLATFORM_AUTH: readonly CommandSpec[] = [
  {
    name: 'platform-auth',
    section: 'operate',
    helpRank: 16,
    summary:
      'Run the super-admin WorkOS platform-auth migration, rollout, and account-reset workflow.',
    arguments: [],
    subcommands: [MIGRATION_SUBCOMMAND, ACCOUNT_RESET_SUBCOMMAND],
    flags: [],
  },
];
