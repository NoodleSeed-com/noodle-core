/** Solution installation/operator command catalog. Pure data — no runtime imports. */
import type { CommandSpec, FlagSpec } from './catalog-types.js';

const OPTIONAL_FLAG = {
  required: false,
  repeatable: false,
  sensitive: false,
  aliases: [],
  conflictsWith: [],
} as const;
const REQUIRED_ARGUMENT = {
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
const APP: FlagSpec = {
  ...OPTIONAL_FLAG,
  name: 'app',
  type: 'string',
  value: '<slug>',
  summary: 'Application slug.',
};
const ENV: FlagSpec = {
  ...OPTIONAL_FLAG,
  name: 'env',
  type: 'string',
  value: '<slug>',
  summary: 'Environment slug.',
};
const SERVICE: FlagSpec = {
  ...OPTIONAL_FLAG,
  name: 'service',
  type: 'string',
  value: '<url>',
  summary: 'Control-plane service URL.',
};
const AUTH_TOKEN: FlagSpec = {
  ...OPTIONAL_FLAG,
  name: 'auth-token',
  type: 'string',
  value: '<token>',
  summary: 'Control-plane authentication token.',
  sensitive: true,
};
const JSON_FLAG: FlagSpec = {
  ...OPTIONAL_FLAG,
  name: 'json',
  type: 'boolean',
  summary: 'Emit JSON output.',
};
const RETENTION: FlagSpec = {
  ...OPTIONAL_FLAG,
  name: 'retention-days',
  type: 'integer',
  value: '<days>',
  summary: 'Managed-record retention in days.',
  constraints: { choices: [7, 30, 90], default: 30 },
};
const INSTALLATION_ARGUMENT = {
  ...REQUIRED_ARGUMENT,
  name: 'installation',
  summary: 'Solution installation identifier.',
};
const COLLECTION_ARGUMENT = {
  ...REQUIRED_ARGUMENT,
  name: 'collection',
  summary: 'Managed collection key.',
};
const RECORD_ARGUMENT = {
  ...REQUIRED_ARGUMENT,
  name: 'record',
  summary: 'Managed record identifier.',
};
const SOLUTION_COMMON_FLAGS: readonly FlagSpec[] = [ORG, SERVICE, AUTH_TOKEN, JSON_FLAG];
const EXPECTED_REVISION: FlagSpec = {
  ...OPTIONAL_FLAG,
  name: 'expected-revision',
  type: 'integer',
  value: '<revision>',
  summary: 'Expected current resource revision.',
  required: true,
  constraints: { minimum: 1 },
};
const IDEMPOTENCY_KEY: FlagSpec = {
  ...OPTIONAL_FLAG,
  name: 'idempotency-key',
  type: 'string',
  value: '<key>',
  summary: 'Retry-safe operation key.',
  required: true,
};
const PAGING_FLAGS: readonly FlagSpec[] = [
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
const RECORD_QUERY_FLAGS: readonly FlagSpec[] = [
  {
    ...OPTIONAL_FLAG,
    name: 'filters',
    type: 'string',
    value: '<json>',
    summary:
      'JSON array of up to eight field/value equality filters, combined with AND. Only declared fields.',
  },
  {
    ...OPTIONAL_FLAG,
    name: 'sort-field',
    type: 'string',
    value: '<field>',
    summary: 'Declared native collection sort field.',
  },
  {
    ...OPTIONAL_FLAG,
    name: 'sort-direction',
    type: 'string',
    value: '<asc|desc>',
    summary: 'Sort direction; requires --sort-field.',
  },
  {
    ...OPTIONAL_FLAG,
    name: 'created-at-from',
    type: 'string',
    value: '<timestamp>',
    summary: 'Inclusive creation-time lower bound; narrows the 10,000-record payload-query scan.',
  },
  {
    ...OPTIONAL_FLAG,
    name: 'created-at-to',
    type: 'string',
    value: '<timestamp>',
    summary: 'Inclusive creation-time upper bound.',
  },
];

const RECORD_FLAGS: readonly FlagSpec[] = [
  ...SOLUTION_COMMON_FLAGS,
  {
    ...OPTIONAL_FLAG,
    name: 'data',
    type: 'string',
    value: '<json>',
    summary: 'Structured JSON record data.',
  },
  {
    ...OPTIONAL_FLAG,
    name: 'idempotency-key',
    type: 'string',
    value: '<key>',
    summary: 'Retry-safe create key.',
  },
  {
    ...OPTIONAL_FLAG,
    name: 'expected-revision',
    type: 'integer',
    value: '<revision>',
    summary: 'Expected current record revision.',
  },
  {
    ...OPTIONAL_FLAG,
    name: 'status',
    type: 'string',
    value: '<status>',
    summary: 'Record status or list filter.',
  },
  {
    ...OPTIONAL_FLAG,
    name: 'assignee',
    type: 'string',
    value: '<subject>',
    summary: 'Assignee subject or list filter.',
  },
  {
    ...OPTIONAL_FLAG,
    name: 'note',
    type: 'string',
    value: '<text>',
    summary: 'Operator note text.',
  },
  ...PAGING_FLAGS,
  {
    ...OPTIONAL_FLAG,
    name: 'include-deleted',
    type: 'boolean',
    summary: 'Include payload-free tombstones.',
  },
];

export const CATALOG_SOLUTIONS: CommandSpec = {
  name: 'solutions',
  section: 'resources',
  helpRank: 1,
  summary: 'Install and operate data-driven business solutions.',
  arguments: [],
  flags: [],
  subcommands: [
    {
      name: 'installation-options',
      summary: 'List organizations currently authorized to install solutions.',
      arguments: [],
      flags: [SERVICE, AUTH_TOKEN, JSON_FLAG, ...PAGING_FLAGS],
      jsonOutput: { mode: 'single' },
    },
    ...(['agreement', 'notice'] as const).map((family) => ({
      name: family,
      summary:
        family === 'agreement'
          ? 'Review and explicitly accept the organization agreement.'
          : 'Inspect or change the business notice shown to agent users.',
      arguments: [],
      flags: [],
      subcommands: [
        {
          name: 'get',
          summary: 'Read current state and mutation authority.',
          arguments: family === 'notice' ? [INSTALLATION_ARGUMENT] : [],
          flags: SOLUTION_COMMON_FLAGS,
          jsonOutput: { mode: 'single' as const },
        },
        {
          name: family === 'agreement' ? 'accept' : 'set',
          summary:
            family === 'agreement'
              ? 'Accept the exact reviewed version as an organization owner.'
              : 'Save the business notice with revision protection.',
          arguments: family === 'notice' ? [INSTALLATION_ARGUMENT] : [],
          flags: [
            ...SOLUTION_COMMON_FLAGS,
            ...(family === 'agreement'
              ? [
                  {
                    ...OPTIONAL_FLAG,
                    name: 'version',
                    type: 'string' as const,
                    value: '<version>',
                    summary: 'Current agreement version.',
                    required: true,
                  },
                  {
                    ...OPTIONAL_FLAG,
                    name: 'document-digest',
                    type: 'string' as const,
                    value: '<sha256>',
                    summary: 'Exact reviewed document digest.',
                    required: true,
                  },
                  {
                    ...OPTIONAL_FLAG,
                    name: 'accept',
                    type: 'boolean' as const,
                    summary: 'Explicitly accept the reviewed documents for this organization.',
                    required: true,
                  },
                ]
              : [
                  { ...EXPECTED_REVISION, constraints: { minimum: 0 } },
                  ...(
                    [
                      ['display-name', 'Business identity shown to agent users.'],
                      ['privacy-url', 'Public HTTPS privacy notice.'],
                      ['support-url', 'HTTPS support page or mailto address.'],
                    ] as const
                  ).map(([name, summary]) => ({
                    ...OPTIONAL_FLAG,
                    name,
                    summary,
                    type: 'string' as const,
                    value: '<value>',
                    required: true,
                  })),
                ]),
          ],
          jsonOutput: { mode: 'single' as const },
        },
      ],
    })),
    {
      name: 'activity',
      summary: 'Inspect payload-free operation evidence and its retention policy.',
      arguments: [],
      flags: [],
      subcommands: [
        ...(['list', 'export'] as const).map((name) => ({
          name,
          summary:
            name === 'export'
              ? 'Export one authorized page of operation evidence.'
              : 'List operation evidence; returned is not confirmed completion.',
          arguments: [INSTALLATION_ARGUMENT],
          flags: [
            ...SOLUTION_COMMON_FLAGS,
            {
              ...OPTIONAL_FLAG,
              name: 'limit',
              type: 'integer' as const,
              value: '<count>',
              summary: 'Maximum entries in this page.',
              constraints: { minimum: 1, maximum: 100 },
            },
            {
              ...OPTIONAL_FLAG,
              name: 'cursor',
              type: 'string' as const,
              value: '<cursor>',
              summary: 'Opaque continuation from the prior page.',
            },
          ],
          jsonOutput: { mode: 'single' as const },
        })),
        {
          name: 'preview',
          summary: 'Preview hypothetical history impact at the verified paid-period end.',
          arguments: [INSTALLATION_ARGUMENT],
          flags: SOLUTION_COMMON_FLAGS,
          jsonOutput: { mode: 'single' },
        },
        {
          name: 'settings',
          summary: 'Inspect or change Activity retention within plan limits.',
          arguments: [],
          flags: [],
          subcommands: [
            {
              name: 'get',
              summary: 'Read retention, plan maximum, edit permission and current revision.',
              arguments: [INSTALLATION_ARGUMENT],
              flags: SOLUTION_COMMON_FLAGS,
              jsonOutput: { mode: 'single' },
            },
            {
              name: 'set',
              summary: 'Change retention with an explicit revision check.',
              arguments: [INSTALLATION_ARGUMENT],
              flags: [
                ...SOLUTION_COMMON_FLAGS,
                {
                  ...OPTIONAL_FLAG,
                  required: true,
                  name: 'retention-days',
                  type: 'integer',
                  value: '<days>',
                  summary: 'Desired retention within the current plan maximum.',
                  constraints: { minimum: 1, maximum: 365 },
                },
                {
                  ...OPTIONAL_FLAG,
                  required: true,
                  name: 'expected-revision',
                  type: 'string',
                  value: '<hash>',
                  summary: 'Revision returned by activity settings get.',
                },
              ],
              jsonOutput: { mode: 'single' },
            },
          ],
        },
      ],
    },
    {
      name: 'connections',
      summary: 'Inspect integrations, connect through Portal, or disconnect an account.',
      arguments: [],
      flags: [],
      subcommands: [
        {
          name: 'list',
          summary: 'List declared connection availability.',
          arguments: [INSTALLATION_ARGUMENT],
          flags: SOLUTION_COMMON_FLAGS,
          jsonOutput: { mode: 'single' },
        },
        {
          name: 'connect',
          summary: 'Open the authenticated Portal account consent flow.',
          arguments: [INSTALLATION_ARGUMENT],
          flags: [
            ...SOLUTION_COMMON_FLAGS,
            {
              ...OPTIONAL_FLAG,
              name: 'portal',
              type: 'string',
              value: '<origin>',
              summary: 'Portal origin; defaults to NOODLE_PORTAL_URL or the managed Portal.',
              constraints: { default: 'https://portal.noodleseed.com' },
            },
            {
              ...OPTIONAL_FLAG,
              name: 'no-open',
              type: 'boolean',
              summary: 'Print the browser URL without opening it.',
            },
          ],
          jsonOutput: { mode: 'single' },
        },
        {
          name: 'disconnect',
          summary: 'Revoke Noodle access to a connected account.',
          arguments: [
            INSTALLATION_ARGUMENT,
            {
              ...REQUIRED_ARGUMENT,
              name: 'connection',
              summary: 'Declared connection identifier.',
            },
          ],
          flags: [
            ...SOLUTION_COMMON_FLAGS,
            {
              ...OPTIONAL_FLAG,
              name: 'expected-revision',
              type: 'string',
              value: '<revision>',
              summary: 'Current connection revision.',
            },
          ],
          jsonOutput: { mode: 'single' },
        },
      ],
    },
    {
      name: 'catalog',
      summary: 'List centrally managed solution profiles.',
      arguments: [],
      flags: [SERVICE, AUTH_TOKEN, JSON_FLAG],
      jsonOutput: { mode: 'single' },
    },
    {
      name: 'list',
      summary: 'List solution installations for an organization or the current identity.',
      arguments: [],
      flags: [...SOLUTION_COMMON_FLAGS, ...PAGING_FLAGS],
      jsonOutput: { mode: 'single' },
    },
    {
      name: 'install',
      summary: 'Install a managed profile or immutable private deployment.',
      arguments: [
        {
          ...REQUIRED_ARGUMENT,
          name: 'profile',
          summary: 'Managed profile key.',
          required: false,
          constraints: { choices: ['travel', 'ecommerce', 'restaurant'] },
        },
      ],
      flags: [
        ...SOLUTION_COMMON_FLAGS,
        APP,
        ENV,
        RETENTION,
        ...(
          [
            [
              'display-name',
              '<name>',
              'Receiving business name; supply all three notice fields together.',
            ],
            ['privacy-url', '<url>', 'Business public HTTPS privacy notice.'],
            ['support-url', '<url>', 'Business HTTPS support page or mailto address.'],
            ['publisher-org', '<org>', 'Private definition publisher organization.'],
            ['definition-app', '<app>', 'App containing the private definition deployment.'],
            [
              'definition-env',
              '<env>',
              'Environment containing the private definition deployment.',
            ],
            ['deployment', '<deployment>', 'Immutable private definition deployment identifier.'],
          ] as const
        ).map(([name, value, summary]) => ({
          ...OPTIONAL_FLAG,
          name,
          type: 'string' as const,
          value,
          summary,
        })),
      ],
      jsonOutput: { mode: 'single' },
    },
    {
      name: 'inspect',
      summary: 'Inspect one solution installation.',
      arguments: [INSTALLATION_ARGUMENT],
      flags: SOLUTION_COMMON_FLAGS,
      jsonOutput: { mode: 'single' },
    },
    ...(['pause', 'resume'] as const).map((name) => ({
      name,
      summary: `${name === 'pause' ? 'Pause' : 'Resume'} anonymous public intake.`,
      arguments: [INSTALLATION_ARGUMENT],
      flags: [...SOLUTION_COMMON_FLAGS, EXPECTED_REVISION],
      jsonOutput: { mode: 'single' as const },
    })),
    {
      name: 'grants',
      summary: 'Manage installation-scoped business grants.',
      arguments: [],
      flags: [],
      subcommands: [
        {
          name: 'list',
          summary: 'List live and revoked business grants.',
          arguments: [INSTALLATION_ARGUMENT],
          flags: SOLUTION_COMMON_FLAGS,
          jsonOutput: { mode: 'single' },
        },
        {
          name: 'set',
          summary: 'Create or update a business grant.',
          arguments: [INSTALLATION_ARGUMENT],
          flags: [
            ...SOLUTION_COMMON_FLAGS,
            {
              ...OPTIONAL_FLAG,
              name: 'subject',
              type: 'string',
              value: '<subject>',
              summary: 'Canonical business-user subject.',
              required: true,
            },
            {
              ...OPTIONAL_FLAG,
              name: 'email',
              type: 'string',
              value: '<email>',
              summary: 'Business-user email address.',
              required: true,
            },
            {
              ...OPTIONAL_FLAG,
              name: 'role',
              type: 'string',
              value: '<role>',
              summary: 'Business role.',
              required: true,
              constraints: { choices: ['administrator', 'manager', 'operator', 'viewer'] },
            },
            {
              ...OPTIONAL_FLAG,
              name: 'expected-revision',
              type: 'integer',
              value: '<revision>',
              summary: 'Expected current grant revision; 0 for a new grant.',
            },
          ],
          jsonOutput: { mode: 'single' },
        },
        {
          name: 'revoke',
          summary: 'Revoke a business grant using optimistic concurrency.',
          arguments: [INSTALLATION_ARGUMENT],
          flags: [
            ...SOLUTION_COMMON_FLAGS,
            {
              ...OPTIONAL_FLAG,
              name: 'subject',
              type: 'string',
              value: '<subject>',
              summary: 'Canonical business-user subject.',
              required: true,
            },
            {
              ...OPTIONAL_FLAG,
              name: 'expected-revision',
              type: 'integer',
              value: '<revision>',
              summary: 'Expected current grant revision.',
              required: true,
            },
          ],
          jsonOutput: { mode: 'single' },
        },
      ],
    },
    {
      name: 'invitations',
      summary: 'Invite staff into one business solution workspace.',
      arguments: [],
      flags: [],
      subcommands: [
        {
          name: 'list',
          summary: 'List installation-scoped staff invitations.',
          arguments: [INSTALLATION_ARGUMENT],
          flags: SOLUTION_COMMON_FLAGS,
          jsonOutput: { mode: 'single' },
        },
        {
          name: 'create',
          summary: 'Create one expiring staff invitation link.',
          arguments: [INSTALLATION_ARGUMENT],
          flags: [
            ...SOLUTION_COMMON_FLAGS,
            {
              ...OPTIONAL_FLAG,
              name: 'email',
              type: 'string',
              value: '<email>',
              summary: 'Verified email address the invitee must use.',
              required: true,
            },
            {
              ...OPTIONAL_FLAG,
              name: 'role',
              type: 'string',
              value: '<role>',
              summary: 'Installation business role.',
              required: true,
              constraints: { choices: ['administrator', 'manager', 'operator', 'viewer'] },
            },
            IDEMPOTENCY_KEY,
          ],
          jsonOutput: { mode: 'single' },
        },
        {
          name: 'revoke',
          summary: 'Revoke a pending staff invitation.',
          arguments: [
            INSTALLATION_ARGUMENT,
            { ...REQUIRED_ARGUMENT, name: 'invitation', summary: 'Invitation identifier.' },
          ],
          flags: [...SOLUTION_COMMON_FLAGS, EXPECTED_REVISION],
          jsonOutput: { mode: 'single' },
        },
        {
          name: 'accept',
          summary: 'Accept an invitation as the signed-in verified identity.',
          arguments: [
            {
              ...REQUIRED_ARGUMENT,
              name: 'token',
              summary: 'One-use invitation token.',
              sensitive: true,
            },
          ],
          flags: [SERVICE, AUTH_TOKEN, JSON_FLAG],
          jsonOutput: { mode: 'single' },
        },
      ],
    },
    {
      name: 'records',
      summary: 'Operate one installed managed collection.',
      arguments: [],
      flags: [],
      usage:
        'solutions records <list|create|get|update|assign|status|note|activity|delete|migrate-schema|export> <installation> <collection> [record] [options]',
      subcommands: [
        ...[
          'list',
          'create',
          'get',
          'update',
          'assign',
          'status',
          'note',
          'activity',
          'delete',
          'migrate-schema',
          'export',
        ].map((name) => ({
          name,
          summary:
            name === 'activity'
              ? 'Read native record history newest first; default 50, maximum 100, with --cursor for older pages.'
              : name === 'migrate-schema'
                ? 'Administrator-only conversion of an eligible legacy request record with revision protection.'
                : `${name[0]?.toUpperCase()}${name.slice(1)} managed records.`,
          arguments: [
            INSTALLATION_ARGUMENT,
            COLLECTION_ARGUMENT,
            ...(name === 'list' || name === 'create' || name === 'export' ? [] : [RECORD_ARGUMENT]),
          ],
          flags: [
            ...RECORD_FLAGS,
            ...(name === 'list' ? RECORD_QUERY_FLAGS : []),
            ...(name === 'update'
              ? [
                  {
                    ...OPTIONAL_FLAG,
                    name: 'unset',
                    type: 'string' as const,
                    value: '<fields>',
                    summary:
                      'Comma-separated optional field keys to remove; cannot overlap --data. May be used without --data.',
                  },
                ]
              : []),
          ],
          jsonOutput: { mode: 'single' as const },
        })),
      ],
    },
    {
      name: 'sources',
      summary: 'Inspect and control one external collection source.',
      arguments: [],
      flags: [],
      usage:
        'solutions sources <show|configure|pause|resume|refresh> <installation> <collection> [options]',
      subcommands: [
        {
          name: 'show',
          summary: 'Inspect collection source authority and health.',
          arguments: [INSTALLATION_ARGUMENT, COLLECTION_ARGUMENT],
          flags: SOLUTION_COMMON_FLAGS,
          jsonOutput: { mode: 'single' },
        },
        {
          name: 'configure',
          summary: 'Bind and explicitly enable an external collection source.',
          arguments: [INSTALLATION_ARGUMENT, COLLECTION_ARGUMENT],
          flags: [
            ...SOLUTION_COMMON_FLAGS,
            EXPECTED_REVISION,
            ...(
              [
                [
                  'binding-reference',
                  '<binding>',
                  'Credential connection ID compiled into the installed artifact.',
                ],
                ['binding-generation', '<generation>', 'Immutable source binding generation.'],
                [
                  'configuration-reference',
                  '<config>',
                  'Credential configuration revision compiled into the installed artifact.',
                ],
              ] as const
            ).map(([name, value, summary]) => ({
              ...OPTIONAL_FLAG,
              name,
              type: name === 'binding-generation' ? ('integer' as const) : ('string' as const),
              value,
              summary,
              required: true,
            })),
            {
              ...OPTIONAL_FLAG,
              name: 'enable',
              type: 'boolean',
              summary: 'Consent to enable synchronization for this source.',
              required: true,
            },
            {
              ...OPTIONAL_FLAG,
              name: 'replace',
              type: 'boolean',
              summary: 'Replace an existing source binding with optimistic concurrency.',
              required: false,
            },
          ],
          jsonOutput: { mode: 'single' },
        },
        ...(
          [
            ['pause', 'Pause collection source synchronization.'],
            ['resume', 'Resume collection source synchronization.'],
          ] as const
        ).map(([name, summary]) => ({
          name,
          summary,
          arguments: [INSTALLATION_ARGUMENT, COLLECTION_ARGUMENT],
          flags: [...SOLUTION_COMMON_FLAGS, EXPECTED_REVISION],
          jsonOutput: { mode: 'single' as const },
        })),
        {
          name: 'refresh',
          summary: 'Queue a coalesced collection source refresh.',
          arguments: [INSTALLATION_ARGUMENT, COLLECTION_ARGUMENT],
          flags: [...SOLUTION_COMMON_FLAGS, EXPECTED_REVISION, IDEMPOTENCY_KEY],
          jsonOutput: { mode: 'single' },
        },
      ],
    },
  ],
};
