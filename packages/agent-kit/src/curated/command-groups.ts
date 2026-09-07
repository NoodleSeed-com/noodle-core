// Curated grouping + one-line summary for each `noodle` CLI command.
//
// The command NAMES are generated from packages/cli/src/cli.ts (see ../generated/surface.ts);
// this file is the human-authored grouping and prose the cli-commands skill reference renders.
// The drift gate (../../test/skill-drift-gate.test.ts) fails when a command has no entry, so a
// new command cannot ship without a skill summary. Keep each summary one line and third-person.

export interface CommandGroupEntry {
  /** Display group the command renders under, in `COMMAND_GROUP_ORDER`. */
  readonly group: string;
  /** One-line, third-person description of what the command does. */
  readonly summary: string;
  /** Public skill visibility. Commands remain in `commands --json` even when not taught publicly. */
  readonly audience?: 'developer' | 'internal' | 'retired';
}

/** Render order for command groups in references/cli-commands.md. */
export const COMMAND_GROUP_ORDER: readonly string[] = [
  'Authoring & validation',
  'Local run & inspect',
  'Hosted deploy & operations',
  'Org & members',
  'Managed config',
  'Governance & observability',
  'CLI maintenance',
  'Deprecated',
];

export const COMMAND_GROUPS: Record<string, CommandGroupEntry> = {
  start: {
    group: 'Authoring & validation',
    summary:
      'Guided first-run: sign in, scaffold, then deploy or run locally (`--json` for headless).',
  },
  init: { group: 'Authoring & validation', summary: 'Create a local Noodle project.' },
  setup: {
    group: 'Authoring & validation',
    summary: 'Reconcile project config and local agent files (dry-run unless `--write`).',
  },
  agents: {
    group: 'Authoring & validation',
    summary: 'Manage AI agent skills and project context (`setup`/`context`/`doctor`).',
  },
  validate: {
    group: 'Authoring & validation',
    summary: 'Author-time compile/schema/connector check; no service (`--json`, `--fix-prompt`).',
  },
  check: {
    group: 'Authoring & validation',
    summary:
      'Check tool design (`tool_design_*`) and MCP Apps/widget readiness; no service. `--min-severity warn` shows only what needs fixing.',
  },
  test: { group: 'Authoring & validation', summary: 'Local compile plus a loopback MCP smoke.' },
  import: {
    group: 'Authoring & validation',
    summary: 'Import an OpenAPI spec into a starter `server.ts`.',
  },
  export: {
    group: 'Authoring & validation',
    summary:
      'Compile locally and write a portable manifest or target host-plugin archive (no service).',
  },
  docs: { group: 'Authoring & validation', summary: 'Export docs in an LLM-readable format.' },
  connect: {
    group: 'Authoring & validation',
    summary: 'Print connection setup for an agent host (Claude Code, Codex, Cursor, etc.).',
  },
  auth: {
    group: 'Authoring & validation',
    summary:
      'Use `auth google` for keyless Google workload identity; diagnose downstream credentials without a business-tool call.',
  },
  doctor: {
    group: 'Authoring & validation',
    summary: 'Check login, service, project, validation, and config.',
  },

  dev: {
    group: 'Local run & inspect',
    summary: 'Run a local loopback runtime that serves + hot-reloads the manifest (no login).',
  },
  devtools: {
    group: 'Local run & inspect',
    summary: 'Preview local widget metadata and rendering.',
  },
  design: {
    group: 'Local run & inspect',
    summary: 'Inspects the latest finalized widget design brief (`inspect --latest --json`).',
  },
  tools: { group: 'Local run & inspect', summary: 'List local tools via a loopback MCP smoke.' },
  resources: {
    group: 'Local run & inspect',
    summary: 'List local resources via a loopback MCP smoke.',
  },
  prompts: {
    group: 'Local run & inspect',
    summary: 'List local prompts via a loopback MCP smoke.',
  },

  login: { group: 'Hosted deploy & operations', summary: 'Authenticate with Noodle Seed Cloud.' },
  logout: { group: 'Hosted deploy & operations', summary: 'Clear saved credentials.' },
  whoami: {
    group: 'Hosted deploy & operations',
    summary: 'Print the current authenticated user.',
  },
  feedback: {
    group: 'Hosted deploy & operations',
    summary: 'Send sanitized product feedback (bug, idea, docs gap) to the Noodle Seed team.',
  },
  link: {
    group: 'Hosted deploy & operations',
    summary: 'Bind this directory to a Noodle Seed Cloud target (org/app/env).',
  },
  deploy: {
    group: 'Hosted deploy & operations',
    summary: 'Deploy the server to Noodle Seed Cloud.',
  },
  open: {
    group: 'Hosted deploy & operations',
    summary: 'Open or print the latest deployment URL.',
  },
  status: { group: 'Hosted deploy & operations', summary: 'Show hosted deployment status.' },
  inspect: {
    group: 'Hosted deploy & operations',
    summary: 'Inspect hosted deployment metadata without secret material.',
  },
  smoke: {
    group: 'Hosted deploy & operations',
    summary: 'Run hosted readiness diagnostics and print external smoke commands.',
  },
  rollback: {
    group: 'Hosted deploy & operations',
    summary: 'Roll back to a previous deployment.',
  },
  archive: {
    group: 'Hosted deploy & operations',
    summary:
      'Archive the whole app: endpoints answer 410 Gone; hard-deleted after the retention window.',
  },
  restore: {
    group: 'Hosted deploy & operations',
    summary: 'Restore an archived app within the retention window.',
  },
  access: {
    group: 'Hosted deploy & operations',
    summary: 'Set the access mode (owner-only|org-members|authenticated|customers).',
  },
  list: {
    group: 'Hosted deploy & operations',
    summary: 'Removed — promoted to `deployments list` (prints the recovery pointer and exits 2).',
    audience: 'retired',
  },
  apps: {
    group: 'Hosted deploy & operations',
    summary: 'List or inspect hosted apps for an org (`apps list`/`apps inspect <app>`).',
  },
  envs: {
    group: 'Hosted deploy & operations',
    summary: 'List or inspect environments for an app (`envs list`/`envs inspect <env>`).',
  },
  deployments: {
    group: 'Hosted deploy & operations',
    summary:
      'List or inspect individual deployments (`deployments list`/`deployments inspect <id>`).',
  },
  distributions: {
    group: 'Hosted deploy & operations',
    summary:
      'Publish immutable host archives, record their lifecycle, and operate bounded delivery.',
  },
  target: {
    group: 'Hosted deploy & operations',
    summary: 'Show or set the deployment target (local|cloud|other).',
  },
  service: {
    group: 'Hosted deploy & operations',
    summary: 'Query hosted service capabilities.',
  },
  solutions: {
    group: 'Hosted deploy & operations',
    summary:
      'Install managed solutions and operate their grants, records, activity, exports, and deletion.',
  },
  assistant: {
    group: 'Hosted deploy & operations',
    summary: 'Manage backend credentials for customer-branded embedded assistant clients.',
  },

  orgs: { group: 'Org & members', summary: 'List or create orgs.' },
  members: { group: 'Org & members', summary: 'Manage org members (list/add/remove).' },

  github: {
    group: 'Hosted deploy & operations',
    summary:
      'Connect, inspect, or disconnect the GitHub repository behind an app’s GitHub-native deploys ' +
      '(`connect`/`status`/`disconnect`; `connect` opens a browser install, `--repo` for headless).',
  },

  secrets: {
    group: 'Managed config',
    summary: 'Manage managed secrets (set/list/delete/resolve) by org/app/env scope.',
  },
  variables: {
    group: 'Managed config',
    summary: 'Manage managed variables (set/list/delete/resolve) by org/app/env scope.',
  },

  knowledge: {
    group: 'Governance & observability',
    summary: 'Operator-only knowledge components: list, status, and refresh (ADR 0202).',
  },
  audit: {
    group: 'Governance & observability',
    summary: 'Operator governance audit status and event queries.',
  },
  billing: {
    group: 'Governance & observability',
    summary:
      'Super-admin preview of the explicit legacy billing-account migration without writing data (`billing migration preview`).',
    audience: 'internal',
  },
  'platform-auth': {
    group: 'Governance & observability',
    summary:
      'Run aggregate-only super-admin WorkOS inventory, import, reconciliation, rollout, rollback, and finalization operations.',
    audience: 'internal',
  },
  policy: {
    group: 'Governance & observability',
    summary: 'Manage policy (status/list/show/effective/simulate/suspend/quota/rate/...).',
  },
  logs: {
    group: 'Governance & observability',
    summary: 'View service/deployment logs.',
  },
  metrics: {
    group: 'Governance & observability',
    summary:
      'MCP analytics for a deployed server (volume, sessions, latency percentiles, two-tier errors, ' +
      'tools, clients). Agents: `noodle metrics --agent-output` for a health verdict + next actions.',
  },
  events: {
    group: 'Governance & observability',
    summary:
      'The per-request MCP event stream with status/tool/client filters; `--session <id>` replays one ' +
      'session in order. Agents: add `--json` and filter (`--status tool_error|mcp_error`) when debugging.',
  },
  intents: {
    group: 'Governance & observability',
    summary:
      'Operate optional environment-scoped intent capture (`status|enable|disable|list|purge`); model participation is best-effort and purge is irreversible.',
  },
  alerts: {
    group: 'Governance & observability',
    summary:
      'Analytics alert rules (`add|list|remove|test`): an edge-triggered webhook fires when error share, ' +
      'error count, calls, or p95 latency breaches. Webhook URLs are stored server-side and shown redacted.',
  },

  help: { group: 'CLI maintenance', summary: 'Print CLI usage and command help.' },
  version: { group: 'CLI maintenance', summary: 'Print the installed CLI version.' },
  commands: {
    group: 'CLI maintenance',
    summary:
      'Print the machine-readable command catalog (`--json`) or a compact human list. Agents: ' +
      '`noodle commands --json` for every command, subcommand, flag, and exit code without reading source.',
  },
  features: {
    group: 'CLI maintenance',
    summary:
      'Print the versioned Claude, ChatGPT, and Embedded compatibility registry (`--json` or `--markdown`).',
  },
  update: {
    group: 'CLI maintenance',
    summary:
      'Check for, install, or safely repair the CLI update. Agents: `noodle update --check --json`, then ' +
      '`noodle update --yes --json`; add `--repair` only when the check reports `repairSafe: true`.',
  },

  keys: {
    group: 'Deprecated',
    summary: 'Removed: this command no longer exists; hosted access is identity-based.',
    audience: 'retired',
  },
};
