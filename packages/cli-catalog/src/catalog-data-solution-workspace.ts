/** Fixed-role workspace administration. No execution or business permission authority lives here. */
import {
  EXPECTED_REVISION,
  OPTIONAL_FLAG,
  SOLUTION_COMMON_FLAGS,
} from './catalog-data-solution-flags.js';
import type { FlagSpec, SubcommandSpec } from './catalog-types.js';

const common = SOLUTION_COMMON_FLAGS.map((flag) =>
  flag.name === 'org' ? { ...flag, required: true } : flag,
);
const confirm: FlagSpec = {
  ...OPTIONAL_FLAG,
  name: 'confirm',
  type: 'boolean',
  required: true,
  summary: 'Confirm this workspace access change.',
};
const value = (name: string, summary: string): FlagSpec => ({
  ...OPTIONAL_FLAG,
  name,
  summary,
  type: 'string',
  required: true,
  value: '<value>',
});
const role: FlagSpec = {
  ...value('role', 'One fixed workspace role.'),
  constraints: { choices: ['owner', 'administrator', 'builder', 'operator', 'viewer'] },
};
const subject = value('subject', 'Canonical member subject from workspace show.');
export const SOLUTION_WORKSPACE: SubcommandSpec = {
  name: 'workspace',
  summary: 'Inspect and administer versioned business workspace access.',
  arguments: [],
  flags: [],
  subcommands: [
    {
      name: 'show',
      summary: 'Inspect current workspace members, permissions and pending invitations.',
      arguments: [],
      flags: common,
      jsonOutput: { mode: 'single' },
    },
    {
      name: 'invite',
      summary: 'Create a seven-day invitation; the one-time token is returned only here.',
      arguments: [],
      flags: [
        ...common,
        EXPECTED_REVISION,
        value('email', 'Verified email address that may claim this invitation.'),
        { ...role, required: false, constraints: { ...role.constraints, default: 'operator' } },
      ],
      jsonOutput: { mode: 'single' },
    },
    {
      name: 'set-role',
      summary: 'Change a member role under current delegation and last-Owner checks.',
      arguments: [],
      flags: [...common, EXPECTED_REVISION, subject, role, confirm],
      jsonOutput: { mode: 'single' },
    },
    {
      name: 'remove',
      summary: 'Remove a workspace member without removing the last Owner.',
      arguments: [],
      flags: [...common, EXPECTED_REVISION, subject, confirm],
      jsonOutput: { mode: 'single' },
    },
    {
      name: 'revoke-invitation',
      summary: 'Revoke an unclaimed invitation.',
      arguments: [],
      flags: [
        ...common,
        EXPECTED_REVISION,
        value('invitation', 'Invitation ID from workspace show.'),
        confirm,
      ],
      jsonOutput: { mode: 'single' },
    },
    {
      name: 'accept',
      summary: 'Claim an invitation using the signed-in verified email.',
      arguments: [],
      flags: [
        ...common,
        value(
          'token-from-env',
          'Environment variable containing the one-time invitation token; not the token itself.',
        ),
        confirm,
      ],
      jsonOutput: { mode: 'single' },
    },
  ],
};
