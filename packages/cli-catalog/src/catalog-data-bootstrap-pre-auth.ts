/** Bootstrap and local authoring command catalog data. Pure data — no runtime imports. */
import type { CommandSpec, FlagSpec } from './catalog-types.js';

const OPTIONAL_FLAG = {
  required: false,
  repeatable: false,
  sensitive: false,
  aliases: [],
  conflictsWith: [],
} as const;

const JSON_FLAG: FlagSpec = {
  ...OPTIONAL_FLAG,
  name: 'json',
  type: 'boolean',
  summary: 'Emit JSON output.',
};
const CONNECTORS_FLAG: FlagSpec = {
  ...OPTIONAL_FLAG,
  name: 'connectors',
  type: 'string',
  value: '<file>',
  summary: 'Connector configuration file.',
};
const SERVICE_FLAG: FlagSpec = {
  ...OPTIONAL_FLAG,
  name: 'service',
  type: 'string',
  value: '<url>',
  summary: 'Control-plane service URL.',
};
const AUTH_TOKEN_FLAG: FlagSpec = {
  ...OPTIONAL_FLAG,
  name: 'auth-token',
  type: 'string',
  value: '<token>',
  summary: 'Control-plane authentication token.',
  sensitive: true,
};
const ORG_FLAG: FlagSpec = {
  ...OPTIONAL_FLAG,
  name: 'org',
  type: 'string',
  value: '<slug>',
  summary: 'Organization slug.',
};
const APP_FLAG: FlagSpec = {
  ...OPTIONAL_FLAG,
  name: 'app',
  type: 'string',
  value: '<slug>',
  summary: 'Application slug.',
};
const ENV_FLAG: FlagSpec = {
  ...OPTIONAL_FLAG,
  name: 'env',
  type: 'string',
  value: '<slug>',
  summary: 'Environment slug.',
};
const WRITE_FLAG: FlagSpec = {
  ...OPTIONAL_FLAG,
  name: 'write',
  type: 'boolean',
  summary: 'Write the generated configuration.',
};
const FORCE_FLAG: FlagSpec = {
  ...OPTIONAL_FLAG,
  name: 'force',
  type: 'boolean',
  summary: 'Overwrite changed generated files.',
};
const REGENERATE_APP_SKILL_FLAG: FlagSpec = {
  ...OPTIONAL_FLAG,
  name: 'regenerate-app-skill',
  type: 'boolean',
  summary: 'Preview or explicitly apply app-skill regeneration, migration, rename, or removal.',
};
const REPLACE_MODIFIED_APP_SKILL_FLAG: FlagSpec = {
  ...OPTIONAL_FLAG,
  name: 'replace-modified-app-skill',
  type: 'boolean',
  summary: 'Replace modified previously owned app-skill files; requires --regenerate-app-skill.',
};
export const CATALOG_BOOTSTRAP_PRE_AUTH: readonly CommandSpec[] = [
  {
    name: 'start',
    section: 'start',
    summary: 'Guided first-run: scaffold and verify locally, then optionally sign in and deploy.',
    arguments: [],
    flags: [
      {
        ...OPTIONAL_FLAG,
        name: 'deploy',
        type: 'boolean',
        summary: 'Finish by deploying to Noodle Seed Cloud.',
      },
      {
        ...OPTIONAL_FLAG,
        name: 'local',
        type: 'boolean',
        summary: 'Finish with local checks; continue development with noodle dev.',
      },
      {
        ...OPTIONAL_FLAG,
        name: 'name',
        type: 'string',
        value: '<slug>',
        summary: 'Project name.',
      },
      {
        ...OPTIONAL_FLAG,
        name: 'template',
        type: 'string',
        value: '<template>',
        summary: 'Project template.',
        constraints: { choices: ['saas', 'hello', 'http-api', 'widget'], default: 'saas' },
      },
      ORG_FLAG,
      APP_FLAG,
      ENV_FLAG,
      {
        ...OPTIONAL_FLAG,
        name: 'access',
        type: 'string',
        value: '<mode>',
        summary: 'Hosted MCP access policy.',
        constraints: {
          choices: ['owner-only', 'org-members', 'authenticated', 'customers'],
          default: 'owner-only',
        },
      },
      SERVICE_FLAG,
      AUTH_TOKEN_FLAG,
      {
        ...OPTIONAL_FLAG,
        name: 'yes',
        type: 'boolean',
        summary: 'Accept guided defaults without prompting.',
      },
      {
        ...JSON_FLAG,
        summary: 'Run headlessly with flags answering every prompt.',
      },
    ],
    jsonOutput: { mode: 'single' },
  },
  {
    name: 'init',
    section: 'start',
    summary: 'Scaffold, install and verify a local Noodle project; safely resume partial setup.',
    arguments: [
      {
        name: 'dir',
        type: 'string',
        summary: 'Directory to initialize.',
        required: false,
        variadic: false,
        sensitive: false,
        constraints: {},
      },
    ],
    flags: [
      {
        ...OPTIONAL_FLAG,
        name: 'template',
        type: 'string',
        value: '<template>',
        summary: 'Project template.',
        constraints: { choices: ['saas', 'hello', 'http-api', 'widget'], default: 'saas' },
      },
      {
        ...OPTIONAL_FLAG,
        name: 'name',
        type: 'string',
        value: '<slug>',
        summary: 'Project name.',
      },
      FORCE_FLAG,
      {
        ...OPTIONAL_FLAG,
        name: 'package-manager',
        type: 'string',
        value: '<manager>',
        summary:
          'Preserve npm/pnpm/yarn ownership. Yarn supports files-only setup; bundled CLI installation is unsupported.',
        constraints: { choices: ['npm', 'pnpm', 'yarn'] },
      },
      {
        ...OPTIONAL_FLAG,
        name: 'no-install',
        type: 'boolean',
        summary: 'Prepare files only; do not install dependencies or claim local verification.',
      },
      {
        ...OPTIONAL_FLAG,
        name: 'launch',
        type: 'string',
        value: '<target>',
        summary:
          'Explicitly launch a fresh installed coding agent after verification (interactive terminal only).',
        constraints: { choices: ['codex', 'claude-code', 'none'], default: 'none' },
      },
      {
        ...OPTIONAL_FLAG,
        name: 'agents',
        type: 'string',
        value: '<target>',
        summary: 'Coding-agent files to configure.',
        constraints: { choices: ['codex', 'claude-code', 'all', 'none'] },
      },
      {
        ...OPTIONAL_FLAG,
        name: 'no-agents',
        type: 'boolean',
        summary: 'Skip coding-agent file setup.',
      },
      {
        ...OPTIONAL_FLAG,
        name: 'no-docs-mcp',
        type: 'boolean',
        summary: 'Skip connecting the docs assistant MCP.',
      },
      {
        ...OPTIONAL_FLAG,
        name: 'dry-run',
        type: 'boolean',
        summary: 'Preview file changes without writing them.',
      },
      JSON_FLAG,
    ],
    jsonOutput: { mode: 'single' },
    local: true,
  },
  {
    name: 'setup',
    section: 'account',
    helpRank: 7,
    summary: 'Reconcile project config and local coding-agent files.',
    arguments: [],
    flags: [
      {
        ...WRITE_FLAG,
        summary: 'Write files; without this flag the command is a dry run.',
      },
      FORCE_FLAG,
      {
        ...OPTIONAL_FLAG,
        name: 'project',
        type: 'string',
        value: '<dir>',
        summary: 'Project directory.',
      },
      {
        ...OPTIONAL_FLAG,
        name: 'agents',
        type: 'string',
        value: '<target>',
        summary: 'Coding-agent files to configure.',
        constraints: { choices: ['codex', 'claude-code', 'all', 'none'] },
      },
      {
        ...OPTIONAL_FLAG,
        name: 'no-agents',
        type: 'boolean',
        summary: 'Skip coding-agent file setup.',
      },
      JSON_FLAG,
    ],
    jsonOutput: { mode: 'single' },
    local: true,
  },
  {
    name: 'link',
    section: 'account',
    helpRank: 6,
    summary: 'Bind this directory to a Noodle Seed Cloud deploy target (org/app/env).',
    arguments: [],
    flags: [
      { ...ORG_FLAG, required: true },
      { ...APP_FLAG, required: true },
      ENV_FLAG,
      SERVICE_FLAG,
      {
        ...OPTIONAL_FLAG,
        name: 'access',
        type: 'string',
        value: '<mode>',
        summary: 'Hosted MCP access policy.',
        constraints: {
          choices: ['owner-only', 'org-members', 'authenticated', 'public', 'mixed', 'customers'],
        },
      },
      {
        ...OPTIONAL_FLAG,
        name: 'entrypoint',
        type: 'string',
        value: '<path>',
        summary: 'Authored server entrypoint to save.',
      },
      {
        ...OPTIONAL_FLAG,
        name: 'save',
        type: 'string',
        value: '<scope>',
        summary: 'Configuration scope for the saved link.',
        constraints: { choices: ['local', 'project'], default: 'local' },
      },
    ],
  },
  {
    name: 'doctor',
    section: 'account',
    helpRank: 12,
    summary: 'Check login, service, project, validation, and config.',
    arguments: [],
    flags: [
      SERVICE_FLAG,
      AUTH_TOKEN_FLAG,
      ORG_FLAG,
      APP_FLAG,
      ENV_FLAG,
      {
        ...OPTIONAL_FLAG,
        name: 'entrypoint',
        type: 'string',
        value: '<path>',
        summary: 'Authored server entrypoint to validate.',
      },
      CONNECTORS_FLAG,
      {
        ...OPTIONAL_FLAG,
        name: 'agent-output',
        type: 'boolean',
        summary: 'Emit an agent-ready readiness prompt with the next command per failed check.',
      },
      {
        ...JSON_FLAG,
        summary: 'Emit structured checks and summary.',
      },
    ],
    jsonOutput: { mode: 'single' },
  },
  {
    name: 'agents',
    section: 'account',
    helpRank: 8,
    summary: 'Preview or install project-local Noodle and app product skills.',
    arguments: [],
    flags: [],
    subcommands: [
      {
        name: 'setup',
        summary: 'Reconcile Noodle guidance and the app product skill (dry-run unless --write).',
        arguments: [],
        flags: [
          {
            ...OPTIONAL_FLAG,
            name: 'agents',
            type: 'string',
            value: '<target>',
            summary: 'Coding-agent files to configure.',
            constraints: { choices: ['claude-code', 'codex', 'all', 'none'] },
          },
          {
            ...OPTIONAL_FLAG,
            name: 'project',
            type: 'string',
            value: '<dir>',
            summary: 'Project directory.',
          },
          WRITE_FLAG,
          {
            ...FORCE_FLAG,
            summary: 'Replace changed Noodle-owned files; never modified app product skills.',
          },
          {
            ...OPTIONAL_FLAG,
            name: 'refresh',
            type: 'boolean',
            summary: 'Force re-fetch the latest skills.',
          },
          REGENERATE_APP_SKILL_FLAG,
          REPLACE_MODIFIED_APP_SKILL_FLAG,
          JSON_FLAG,
        ],
        jsonOutput: { mode: 'single' },
      },
      {
        name: 'doctor',
        summary: 'Report Noodle and app product-skill install, modification, and staleness.',
        arguments: [],
        flags: [
          {
            ...OPTIONAL_FLAG,
            name: 'agents',
            type: 'string',
            value: '<target>',
            summary: 'Coding-agent files to inspect.',
            constraints: { choices: ['claude-code', 'codex', 'all', 'none'] },
          },
          {
            ...OPTIONAL_FLAG,
            name: 'project',
            type: 'string',
            value: '<dir>',
            summary: 'Project directory.',
          },
          JSON_FLAG,
        ],
        jsonOutput: { mode: 'single' },
      },
    ],
    local: true,
  },
];
