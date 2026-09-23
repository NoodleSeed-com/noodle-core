/** Solution installation/operator catalog. Imports only dependency-free sibling data. */

import { SOLUTION_CONVERSATIONS } from './catalog-data-solution-conversations.js';
import { SOLUTION_DRAFTS } from './catalog-data-solution-drafts.js';
import {
  AUTH_TOKEN,
  EXPECTED_REVISION,
  IDEMPOTENCY_KEY,
  INSTALLATION_ARGUMENT,
  JSON_FLAG,
  OPTIONAL_FLAG,
  PAGING_FLAGS,
  REQUIRED_ARGUMENT,
  SERVICE,
  SOLUTION_COMMON_FLAGS,
} from './catalog-data-solution-flags.js';
import { SOLUTION_HISTORY } from './catalog-data-solution-history.js';
import { SOLUTION_PAGE } from './catalog-data-solution-page.js';
import { COLLECTION_ARGUMENT, SOLUTION_RECORDS } from './catalog-data-solution-records.js';
import { SOLUTION_WORKSPACE } from './catalog-data-solution-workspace.js';
import type { CommandSpec, FlagSpec } from './catalog-types.js';

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

const RETENTION: FlagSpec = {
  ...OPTIONAL_FLAG,
  name: 'retention-days',
  type: 'integer',
  value: '<days>',
  summary: 'Managed-record retention in days.',
  constraints: { choices: [7, 30, 90], default: 30 },
};

export const CATALOG_SOLUTIONS: CommandSpec = {
  name: 'solutions',
  section: 'resources',
  helpRank: 1,
  summary: 'Install and operate data-driven business solutions.',
  arguments: [],
  flags: [],
  subcommands: [
    SOLUTION_DRAFTS,
    SOLUTION_PAGE,
    SOLUTION_WORKSPACE,
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
      name: 'operations',
      summary: 'Inspect and recover application operation custody.',
      arguments: [],
      flags: [],
      subcommands: [
        {
          name: 'coordination',
          summary: 'Administrator-only review of held external operations.',
          arguments: [],
          flags: [],
          subcommands: (['list', 'resolve'] as const).map((name) => ({
            name,
            summary:
              name === 'list'
                ? 'List held operations in one installation.'
                : 'Release an inactive exact hold after reviewing the external outcome.',
            arguments: [INSTALLATION_ARGUMENT],
            flags: [
              ...SOLUTION_COMMON_FLAGS,
              ...(name === 'list'
                ? [
                    {
                      ...OPTIONAL_FLAG,
                      name: 'limit',
                      type: 'integer' as const,
                      value: '<count>',
                      summary: 'Maximum records in this page.',
                      constraints: { minimum: 1, maximum: 100 },
                    },
                    {
                      ...OPTIONAL_FLAG,
                      name: 'before-resource',
                      type: 'string' as const,
                      value: '<hash>',
                      summary: 'Continuation resource returned by the previous list.',
                    },
                  ]
                : [
                    ...(
                      [
                        ['resource', 'Exact resource hash from list.'],
                        ['token', 'Exact custody token from list.'],
                        ['reason', 'Single-line review reason; 1 to 256 characters.'],
                      ] as const
                    ).map(([flag, summary]) => ({
                      ...OPTIONAL_FLAG,
                      name: flag,
                      summary,
                      required: true,
                      sensitive: flag === 'token',
                      type: 'string' as const,
                      value: '<value>',
                    })),
                  ]),
            ],
            jsonOutput: { mode: 'single' as const },
          })),
        },
      ],
    },
    SOLUTION_CONVERSATIONS,
    SOLUTION_HISTORY,
    {
      name: 'activity',
      summary: 'Inspect payload-free operation evidence and preview plan history impact.',
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
              constraints: { default: 'https://portal.noodleseed.dev' },
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
    ...Object.entries({
      inspect: 'Inspect one solution installation.',
      activate: 'Retry activation of a saved installation without changing its intake setting.',
      pause: 'Pause anonymous public intake.',
      resume: 'Resume anonymous public intake.',
    }).map(([name, summary]) => ({
      name,
      summary,
      arguments: [INSTALLATION_ARGUMENT],
      flags: ['pause', 'resume'].includes(name)
        ? [...SOLUTION_COMMON_FLAGS, EXPECTED_REVISION]
        : SOLUTION_COMMON_FLAGS,
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
    SOLUTION_RECORDS,
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
