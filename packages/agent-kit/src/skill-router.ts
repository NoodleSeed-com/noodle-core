// Intent router for the project-local `noodle-seed` skill. Keep this file small: it selects one
// outcome workflow and bounds progressive disclosure. Detailed MCP guidance belongs in the
// one-level reference tree rendered by skill-content.ts.

import { BEHAVIOR_SKILLS, type BehaviorSkillName } from './behavior-skills.js';
import type { AgentTarget } from './index.js';

export const SKILL_DESCRIPTION =
  'Use when building, validating, testing, deploying, or operating a local or hosted Noodle Seed ' +
  'MCP server or app authored in TypeScript with the noodle CLI.';

export type SkillReferencePath = `references/${string}.md`;

export const APP_DIRECTORY_COMPLIANCE_REFERENCE: SkillReferencePath =
  'references/app-directory-compliance.md';

type SkillRouteId =
  | 'design-product'
  | 'create-product-guide'
  | 'wrap-existing-app'
  | 'build-server'
  | 'connect-api'
  | 'build-app'
  | 'verify-recover'
  | 'debug-recover'
  | 'inspect-hosted'
  | 'deploy-hosted'
  | 'embed-assistant'
  | 'publish'
  | 'feedback';

export interface SkillRoute {
  readonly id: SkillRouteId;
  readonly intent: string;
  readonly skill: BehaviorSkillName;
  readonly exitCondition: string;
}

export const SKILL_ROUTES: readonly SkillRoute[] = [
  {
    id: 'design-product',
    intent: 'Turn a vague MCP product idea into a bounded design before implementation',
    skill: 'designing-mcp-products',
    exitCondition:
      'The product contract identifies the user benefit, model boundary, evidence, and next implementation skill.',
  },
  {
    id: 'create-product-guide',
    intent: 'Create, revise, regenerate, or recover the product skill for this MCP server',
    skill: 'creating-product-agent-guides',
    exitCondition:
      'The grounded TypeScript guide and generated-file plan are proven, with each approved write applied explicitly or left pending.',
  },
  {
    id: 'wrap-existing-app',
    intent: 'Plan how to wrap an existing application that has no stable usable public API',
    skill: 'wrapping-existing-applications',
    exitCondition:
      'A sanitized identity-first capability map and repository-scoped implementation plan are presented for approval before mutation.',
  },
  {
    id: 'build-server',
    intent: 'Create or extend a headless MCP server whose external API contract is already modeled',
    skill: 'authoring-mcp-servers',
    exitCondition:
      'The requested server behavior is locally validated and tested; connector reads have real-output evidence.',
  },
  {
    id: 'connect-api',
    intent:
      'Connect a real API only when all four API-evidence inputs exist: API base URL, authentication scheme, representative safe read, and observed response',
    skill: 'connecting-apis-to-mcp',
    exitCondition:
      'A representative live read returns populated, intentionally mapped fields without exposing credentials.',
  },
  {
    id: 'build-app',
    intent: 'Build or change an MCP App, widget, or host-visible UI',
    skill: 'building-mcp-apps',
    exitCondition:
      'The UI has a stated user benefit, passes the requested checks, and degrades to useful text.',
  },
  {
    id: 'verify-recover',
    intent: 'Validate, test, or prove a project at a named delivery evidence level',
    skill: 'verifying-mcp-delivery',
    exitCondition:
      'The failing evidence layer is repaired and rerun, or the remaining blocker and exact next action are reported.',
  },
  {
    id: 'debug-recover',
    intent:
      'Diagnose or recover an existing project with concrete local or hosted failure evidence',
    skill: 'debugging-mcp-delivery',
    exitCondition:
      'The failing layer is repaired and rerun, or the stable blocker and exact next action are reported.',
  },
  {
    id: 'inspect-hosted',
    intent:
      'Inspect or diagnose hosted status, logs, metrics, events, or deployment metadata read-only',
    skill: 'debugging-mcp-delivery',
    exitCondition:
      'The requested hosted evidence is reported without changing target, configuration, access, or deployment state.',
  },
  {
    id: 'deploy-hosted',
    intent:
      'Deploy, configure, connect with writes, change access, or roll back a hosted MCP service when explicitly requested',
    skill: 'deploying-mcp-services',
    exitCondition:
      'The requested hosted state is evidenced without claiming unperformed host or production checks.',
  },
  {
    id: 'embed-assistant',
    intent: 'Embed a Noodle assistant in an existing SaaS or web application',
    skill: 'embedding-mcp-assistants',
    exitCondition:
      'The requested embed boundary works with verified identity and credential separation at the tested level.',
  },
  {
    id: 'publish',
    intent: 'Prepare or submit an integration to a host directory',
    skill: 'publishing-mcp-integrations',
    exitCondition:
      'The requested submission evidence is complete and any host-review uncertainty is explicit.',
  },
  {
    id: 'feedback',
    intent: 'Report a Noodle Seed bug, documentation gap, or product improvement',
    skill: 'reporting-noodle-feedback',
    exitCondition:
      'A sanitized dry-run preview and exact proposal are shown, then one submission occurs only after explicit approval.',
  },
];

/** Complete lookup catalog. Routes above, not this inventory, own discovery. */
const REFERENCE_INDEX_LINES: readonly string[] = [
  '- `references/agent-contract.md` — the `--json` envelope, exit codes, and the three output modes.',
  '- `references/product-agent-guides.md` — decide, interview, propose, prove, preview, and explicitly install one host-neutral product guide.',
  '- `references/sdk-surface.md` — what to import from `@noodleseed/one` and which builder to use.',
  '- `references/cli-commands.md` — every `noodle` command, grouped by area.',
  '- `references/compile-errors.md` — fix `noodle validate` errors by code.',
  '- `references/build-an-mcp-server.md` — outcome-first workflow for a focused, tested, model-facing MCP product.',
  '- `references/authoring-workflow.md` — input paths, fit checks, connector patterns, authentication, invocation context, testing, and managed config.',
  '- `references/tool-design.md` — intent-shaped tools, titles and annotations, bounded outputs, tool-surface budget, and context provisioning.',
  '- `references/embedded-assistant.md` — HTTPS origins, managed model config, deploy sequencing, session exchange, browser mounting, and credential boundaries.',
  '- `references/connect-an-api.md` — secure credentials, probe the live API, model the observed shape, and prove real output.',
  '- `references/wrap-existing-app.md` — read-only identity-first planning for an existing application with no stable usable API.',
  '- `references/build-an-mcp-app.md` — product-fit, output-boundary, fallback, and evidence workflow for an MCP App.',
  '- `references/experience-design.md` — design an app experience: funnel boundary, grounding, two users, display modes, and wireframe.',
  '- `references/widgets-and-apps.md` — MCP Apps, typed views, widget hooks, output shaping, and CSP.',
  '- `references/test-in-hosts.md` — connect and test in real MCP hosts and protocol inspection clients.',
  '- `references/verify-and-recover.md` — ordered evidence ladder, bounded repair, and honest completion claims.',
  '- `references/troubleshooting.md` — runtime symptom to cause and fix, locally and hosted.',
  '- `references/inspect-hosted.md` — read-only hosted status, logs, metrics, events, and deployment diagnosis.',
  '- `references/deploy-and-ops.md` — explicitly authorized hosted link, config, deploy, access, connection writes, and rollback.',
  '- `references/publishing.md` — prepare and submit to app and connector directories.',
  `- \`${APP_DIRECTORY_COMPLIANCE_REFERENCE}\` — the pre-submission experience and policy checklist.`,
  '- `references/examples.md` — flagship example index and a canonical `server.ts`.',
  '- `references/feedback.md` — draft sanitized product feedback and submit only with user approval.',
];

function routeTableLines(): readonly string[] {
  return [
    '| User outcome | Load sibling skill | Canonical playbook | Done when |',
    '| :--- | :--- | :--- | :--- |',
    ...SKILL_ROUTES.map((route) => {
      const skill = BEHAVIOR_SKILLS.find((candidate) => candidate.name === route.skill);
      if (skill === undefined) throw new Error(`missing behavior skill for route ${route.id}`);
      const supporting =
        skill.supportingReferences.length > 0
          ? skill.supportingReferences.map((reference) => `\`${reference}\``).join(', ')
          : 'None';
      return `| ${route.intent} | \`${route.skill}\` | \`${skill.primaryReference}\` (${supporting}) | ${route.exitCondition} |`;
    }),
  ];
}

export function skillRouterBody(_target: AgentTarget): string {
  const preamble =
    'Use this skill for project-local Noodle Seed authoring in the active coding host; preserve generated and user instruction boundaries.';
  return [
    '# Noodle Seed',
    '',
    'Build, validate, test, deploy, and operate Noodle Seed MCP servers and apps authored in TypeScript with the `noodle` CLI. Author from the configured entrypoint (usually `server.ts`); keep the authoring surface TypeScript-only.',
    '',
    preamble,
    '',
    "If the request is unrelated to the Noodle MCP surface, stop here: follow the project's normal instructions and run no Noodle lifecycle commands.",
    '',
    '**Installed-plugin execution.** When this skill is supplied by the Noodle Developer plugin, you write and test the application source, then use its supported `noodle-readiness` tools for project setup, build gates, exact-target linking, variables, secret-from-environment transfer, gated deployment, and feedback. Treat the corresponding public `noodle ...` command as recovery text, never as permission to discover or expose an internal launcher. If a tool fails, report its structured error and public `noodle ...` command; do not ask the user to copy a private installation path or perform an operation the authorized tool can perform.',
    '',
    '## Route the request',
    '',
    'Choose exactly one primary route from the user outcome below, then load the selected sibling skill and hand off the request. Read that primary reference in full; read supporting references only when the sibling or observed evidence requires them. Do not reread the corpus or restart discovery after the handoff.',
    '',
    'Apply this precedence when wording overlaps: concrete failure evidence takes the debugging route; an explicit request to create, revise, regenerate, or recover an app product skill takes `creating-product-agent-guides`; an MCP App/UI outcome takes the App route; an existing application with no stable, usable API or specification takes `wrapping-existing-applications`; only when all four API-evidence inputs exist—an API base URL, authentication scheme, representative safe read, and observed response—use `connecting-apis-to-mcp`; missing, stale, inaccessible, undocumented-only, or otherwise unusable evidence remains in `wrapping-existing-applications`; both integration routes take precedence over generic server building; hosted inspection is debugging read-only; hosted mutation requires the explicitly requested deployment route.',
    '',
    'Negative routing examples: “Inspect hosted logs/status” → `inspect-hosted` (read-only). “Prepare for deployment” → the applicable build or verification route; with existing access it may inspect `deploy preflight`, then stop with a handoff. Preparation does not authorize `link`, hosted config, publication, rollback, host writes, or submission. “Keep this local” → a build or verification route, never a hosted route.',
    '',
    ...routeTableLines(),
    '',
    '## Common machine loop',
    '',
    'Every `--json` command speaks the canonical envelope on stdout. Parse machine state instead of scraping human prose; `references/agent-contract.md` owns the envelope, streaming records, and exit codes.',
    '',
    'Inside the installed plugin, perform mapped steps with `noodle-readiness` tools and use the public `noodle ...` spelling only when reporting the logical action or a fallback. Outside the plugin, run the public CLI directly. Never construct a hidden launcher command.',
    '',
    "1. **Discover** — use `noodle commands --json` when the required command or flags are uncertain; don't read CLI source.",
    '2. **Author** — for build routes, edit the configured TypeScript entrypoint, usually `src/server.ts`.',
    '3. **Validate** — run `noodle validate --json`; repair each `error.errors[]` item at its `path`, then re-run `noodle validate --json`.',
    '4. **Smoke** — run `noodle test --json` after validation passes.',
    '5. **Prove the requested level** — connector routes require a safe live read with `noodle tools call`; App routes require `noodle check --json` and `noodle devtools`; hosted or host actions run only when the selected route and current user request authorize that exact level.',
    '6. **Report evidence** — claim only the highest level actually exercised and name anything not run.',
    '',
    '## Reference lookup catalog',
    '',
    'This is a lookup catalog, not a discovery checklist. Return here only when the selected primary route names a missing technical detail:',
    '',
    ...REFERENCE_INDEX_LINES,
    '',
    '## Product feedback',
    '',
    'When you discover a bug, missing capability, misleading doc, or improvement idea, draft and sanitize one finding, then preview it with `noodle-readiness.preview_product_feedback` in the installed plugin or `noodle feedback ... --dry-run --json` in the public CLI. Inspect and show the normalized submission, diagnostics, and private destination. Ask for explicit approval of that exact proposal; do not submit it until approval. Then call `noodle-readiness.submit_product_feedback` once with approval, or run the public CLI once without `--dry-run`. Follow `references/feedback.md`; pass structured arguments directly instead of composing a shell command, never include customer code, secrets, personal data, or identifying project details, and never auto-login or retry-loop.',
    '',
    '## Safety',
    '',
    '- Keep secrets, bearer tokens, refresh tokens, static access keys, `.env` / `.env.noodle` values, and `~/.noodle/config.json` out of prompts, logs, docs, tests, and generated files.',
    '- Never expose an internal launcher or private installation path, ask the user to paste a command the plugin can execute, or use an ad hoc shell/file-parsing pipeline to move a secret. Use the typed secret-from-environment tool or `noodle secrets set ... --from-env NAME`.',
    '- Do not hand-author manifest JSON/YAML, runtime artifacts, connector IR, or hosted asset metadata.',
    '- Do not add static data-plane credential paths; hosted access is identity-based.',
    '- Hosted mutation is opt-in. Run `link`, hosted secret/variable/config/access changes, deploy, rollback, host configuration writes, or directory submission only when the current user request explicitly authorizes the exact mutation and target. An inspect, prepare, validate, test, or local-only request grants no such authority; stop and ask before crossing that boundary.',
    '',
    '## Customization',
    '',
    'This skill is regenerated by `noodle agents setup --write`. For project-specific standards, create a separate skill; do not edit this file or its references.',
  ].join('\n');
}
