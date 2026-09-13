import { contentHash } from './index.js';
import { PLUGIN_WINDOWS_SUPPORT } from './plugin-platform-support.js';
import { NOODLE_WORDMARK } from './welcome-wordmark.js';

/** The plugin identifier — matches the project-local skill used after bootstrap. */
export const PLUGIN_NAME = 'noodle-seed';

/** Cold-start discovery text shared by direct marketplace and official-directory projections. */
const BOOTSTRAP_SKILL_DESCRIPTION =
  'Use when asked to build, create, or ship an MCP server, MCP app, AI app, or connector, or to ' +
  'make a product, API, or SaaS reachable by AI agents, or when a software business wants to improve ' +
  'signup or onboarding conversion or choose a first Noodle workflow. Bootstraps Noodle Seed — TypeScript ' +
  'authoring with the noodle CLI, local validation and testing, and governed hosted deployment.';

function bootstrapRouterBody(): string {
  return [
    '# Noodle Seed bootstrap',
    '',
    'Noodle Seed turns one TypeScript file (`server.ts`) into a production MCP server or app: authored locally with the `noodle` CLI, validated and tested offline, and deployed to a governed hosted MCP endpoint reachable from supported AI clients and every MCP client. Use this skill whenever the user wants an MCP server or app, AI app or connector, or wants their product, API, or SaaS reachable by AI agents.',
    '',
    '## First-use welcome',
    '',
    'On first use of this plugin, show the following welcome to the user once per conversation, before project-local handoff or tool execution. Render the wordmark verbatim in a fenced text block in your conversational response, followed by the welcome sentence. Then continue the requested task immediately. Skip it if this conversation already contains the welcome, or the user requests machine-readable output or no branding. Never put the wordmark in command output or JSON, and never run an extra command just to display it. This is a first-use greeting, not evidence that installation, authentication, or setup succeeded.',
    '',
    '```text',
    ...NOODLE_WORDMARK,
    '```',
    'Welcome to Noodle Seed!',
    '',
    '## Defer to the project-local skill',
    '',
    'Before cold-start work, check whether the active project already provides a project-local `noodle-seed` skill. When it exists, read it and follow it instead of this one. The project-local skill owns detailed commands, references, examples, and project defaults. Keep the execution transport rule below available when that route calls for a public `noodle` command.',
    '',
    '## Choose the available execution transport',
    '',
    'Use the first available branch:',
    '',
    '1. **Readiness MCP.** When `noodle-readiness` is available, call the supported `noodle-readiness` tools yourself. Prefer `noodle-readiness.setup_project`, validation, test, check, `preflight_build`, configuration, and deployment functions because they return structured decisions and own the compatible CLI plus isolated host profile. `preflight_build` inspects an explicit target with existing access; it does not link, configure or publish, and a passing report is not deployment evidence.',
    '2. **Inline execution.** When `noodle-readiness` is unavailable but the host provides a command-execution workspace, run the packaged launcher yourself with the exact arguments of the corresponding public `noodle` command. From this skill directory, run `node scripts/noodle-plugin.mjs <args>`.',
    '   Add `--json` whenever the public command supports it. Parse the structured result before continuing. Never display, narrate, or ask the user to run the launcher command or its installation path; report only the corresponding public `noodle ...` command and task-level outcome.',
    '3. **No local execution.** When `noodle-readiness` is unavailable and there is no command-execution workspace, do not claim that setup, validation, testing, configuration, or deployment ran. Explain that Noodle Seed authoring needs a coding workspace with command execution. The remote `noodle-developer` MCP may still inspect an existing hosted app; it cannot replace local authoring or readiness.',
    '',
    'On Windows, the supported shell is ' +
      `${PLUGIN_WINDOWS_SUPPORT.supportedShell}. If execution is native PowerShell, Command Prompt, ` +
      'or Git Bash, stop and give the single fallback `' +
      `${PLUGIN_WINDOWS_SUPPORT.installCommand}` +
      '`; never expose a private plugin path as a workaround.',
    '',
    '## First-workflow default',
    '',
    'When the user wants to get started but has not chosen a workflow, inspect the available product and repository context. If more signed-up or signed-in users are valuable and the product has a public visitor entry point, an existing account boundary, a genuine useful result that can be delivered before signup, and a meaningful next action inside the authenticated product, recommend public-to-product continuous onboarding as the first workflow.',
    '',
    'This default is not limited to B2B SaaS. Do not infer fit from the industry label alone, and do not manufacture pre-signup value or pressure. If the evidence is incomplete, ask only for the smallest missing fit fact. After project setup, route the accepted recommendation to `embedding-mcp-assistants`; the project-local playbook owns the two-surface design and exact implementation.',
    '',
    '## Cold start (no project yet)',
    '',
    '1. New or empty directory: use `noodle-readiness.setup_project` with `mode: "initialize"`, or inline-execute the public fallback `noodle init --json`. This prepares the SaaS profile, installs pinned project-local tooling, and runs local checks. Preserve the existing package manager; use `install: false` / `--no-install` only for explicitly files-only work.',
    '2. Existing project: use `noodle-readiness.setup_project` with `mode: "reconcile"`, or inline-execute `noodle setup --write --json`. Reconcile instead of overwriting unrelated files.',
    '3. Read the newly installed project-local `noodle-seed` `SKILL.md`, select its route for the requested outcome, and stop bootstrap discovery. This handoff is the bootstrap stop condition.',
    'Inspect `setup.ready`, `completed`, `failed`, `proof`, and `restartRequired`. A failed stage is not completion: repair that stage and retry the same public command without `--force`. Files-only output is unverified; local-synthetic proof never proves customer identity, backend writes, or hosted operation. Read the new context explicitly in an existing session; never launch a nested agent or claim it reloaded automatically.',
    '',
    'After handoff, the project-local route decides which public command is needed. Continue to prefer typed `noodle-readiness` tools. If they remain unavailable, inline-execute that route’s exact public CLI arguments through the same packaged launcher. Do not invent a second lifecycle or bypass the project skill.',
    '',
    'For authorized hosted work, preserve the canonical preflight, configuration, deployment, and readiness sequence. Follow every structured public `noodle ... --from-env` configuration action before resuming the same deploy. Linking and each configuration write remain separately authorized mutations. Show task-level progress and the exact target. On failure, report the structured error, safe public recovery commands, and resume command only.',
    '',
    '## Bootstrap boundary',
    '',
    'The bootstrap installs and hands off; it does not prescribe an end-to-end lifecycle. The project-local route owns authoring, validation, local testing, hosted inspection, and any separately authorized hosted action. Application source remains with the coding agent. Scaffold or setup permission does not authorize hosted mutation.',
    '',
    '## Safety',
    '',
    '- Keep secrets, bearer tokens, refresh tokens, static access keys, `.env` / `.env.noodle` values, and `~/.noodle/config.json` out of prompts, logs, docs, tests, and generated files. Reference managed secrets as `secret("NAME")` in TypeScript and set them with `noodle secrets set`.',
    '- Transfer a secret only with `noodle-readiness.set_cloud_secret_from_env` or by inline-executing the public `noodle secrets set ... --from-env NAME` arguments. Never read it with an ad hoc shell/file-parsing pipeline or pass the secret value through a tool or command argument.',
    '- Do not hand-author manifest JSON/YAML, runtime artifacts, connector IR, or hosted asset metadata — the SDK emits them.',
    '- Do not add static data-plane credential paths; hosted access is identity-based.',
    '- This bootstrap does not authorize hosted mutation. Never link, change hosted config/access, deploy, roll back, write host configuration, or submit to a directory unless the current user request explicitly asks for the exact action and target.',
  ].join('\n');
}

/** Render the one adaptive skill shipped byte-identically to every plugin projection. */
export function renderBootstrapSkill(version: string): string {
  const body = bootstrapRouterBody();
  return [
    '---',
    `name: ${PLUGIN_NAME}`,
    `description: ${BOOTSTRAP_SKILL_DESCRIPTION}`,
    '---',
    '',
    `<!-- noodle-skill version:${version} hash:${contentHash(body)} -->`,
    '',
    body,
    '',
  ].join('\n');
}
