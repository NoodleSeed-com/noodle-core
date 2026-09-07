import type { AgentTarget } from './skill-registry.js';
import type { SkillReferencePath } from './skill-router.js';

export const EXPECTED_BEHAVIOR_SKILL_NAMES = [
  'designing-mcp-products',
  'creating-product-agent-guides',
  'wrapping-existing-applications',
  'authoring-mcp-servers',
  'connecting-apis-to-mcp',
  'building-mcp-apps',
  'embedding-mcp-assistants',
  'verifying-mcp-delivery',
  'debugging-mcp-delivery',
  'deploying-mcp-services',
  'publishing-mcp-integrations',
  'reporting-noodle-feedback',
] as const;

export type BehaviorSkillName = (typeof EXPECTED_BEHAVIOR_SKILL_NAMES)[number];

export interface BehaviorSkill {
  readonly name: BehaviorSkillName;
  readonly description: string;
  readonly outcome: string;
  readonly positiveTriggers: readonly string[];
  readonly negativeTriggers: readonly string[];
  readonly requiredInputs: readonly string[];
  readonly primaryReference: SkillReferencePath;
  readonly supportingReferences: readonly SkillReferencePath[];
  readonly evidence: string;
  readonly recovery: string;
  readonly stop: string;
}

export const BEHAVIOR_SKILLS: readonly BehaviorSkill[] = [
  {
    name: 'designing-mcp-products',
    description:
      'Use when a Noodle Seed MCP product idea needs conversational fit, user benefit, scope, interaction, or evidence design before implementation.',
    outcome:
      'Produce the smallest decision-ready MCP product design before code or hosted mutation.',
    positiveTriggers: [
      'Turn a vague product idea into an MCP product.',
      'Decide whether this job needs an MCP App.',
    ],
    negativeTriggers: [
      'Do not use for an already specified implementation.',
      'Do not use for generic product or UI design outside MCP.',
    ],
    requiredInputs: [
      'Target user and job.',
      'System data or action the model cannot supply.',
      'Requested stopping point.',
    ],
    primaryReference: 'references/experience-design.md',
    supportingReferences: ['references/authoring-workflow.md'],
    evidence:
      'A bounded product contract states user benefit, model boundary, interaction, fallback, product-guide decision, risks, and next implementation skill.',
    recovery:
      'If the idea is broad, reduce it to one conversational job and one representative success path.',
    stop: 'Stop before implementation when the design inputs or product fit are unresolved.',
  },
  {
    name: 'creating-product-agent-guides',
    description:
      'Use when a Noodle Seed MCP server needs a new or revised product agent guide, App Package skill, or explicit product-skill regeneration.',
    outcome:
      'Create or revise one grounded TypeScript product guide, prove it locally, and preview every generated-file change before explicit installation.',
    positiveTriggers: [
      'Teach agents how to use this MCP product across multiple capabilities.',
      'Create, revise, regenerate, or recover an app product skill.',
    ],
    negativeTriggers: [
      'Do not use merely to add or change an MCP capability; use the owning server or App build skill.',
      'Do not invent product workflows, capability names, or weaker safety boundaries from source shape alone.',
    ],
    requiredInputs: [
      'Configured TypeScript entrypoint and its declared MCP capabilities.',
      'Builder-confirmed product triggers, workflow judgment, and boundaries that source cannot prove.',
      'Separate approval for source editing and generated app-skill installation or replacement.',
    ],
    primaryReference: 'references/product-agent-guides.md',
    supportingReferences: [],
    evidence:
      'The approved TypeScript guide references only declared capabilities, validation and local smoke pass, and the explicit package plan is either approved and applied or left as a preview.',
    recovery:
      'Repair structured guide errors by exact path; preserve modified or unowned local files and use only the previewed app-skill recovery action the builder approves.',
    stop: 'Stop before editing source or materializing generated app-skill files at each separate approval boundary.',
  },
  {
    name: 'wrapping-existing-applications',
    description:
      'Use when an existing application has no stable usable API and needs a read-only, identity-first Noodle Seed integration plan before implementation.',
    outcome:
      'Produce the smallest safe, repository-grounded existing-application integration plan before any mutation.',
    positiveTriggers: [
      'Plan how to wrap an existing application that has no usable public API.',
      'Map internal application capabilities into an approved Noodle Seed implementation plan.',
    ],
    negativeTriggers: [
      'Do not use when all four API-evidence inputs exist—an API base URL, authentication scheme, representative safe read, and observed response; use `connecting-apis-to-mcp`. Missing, stale, inaccessible, undocumented-only, or otherwise unusable API evidence remains in `wrapping-existing-applications`.',
      'Do not use to execute an approved plan, diagnose a concrete failure, or mutate hosted state.',
    ],
    requiredInputs: [
      'Repository scope and requested stopping point.',
      'Target user jobs.',
      'End-user identity provider and caller population.',
      'One static preconfigured downstream origin, or a routing blocker and owning-workflow handoff.',
    ],
    primaryReference: 'references/wrap-existing-app.md',
    supportingReferences: ['references/authoring-workflow.md', 'references/tool-design.md'],
    evidence:
      'A sanitized capability map and repository-scoped plan state identity, authorization, routing, application changes, tool budget, tests, blockers, and the first unproven layer.',
    recovery:
      'With a stable origin but no safe stable HTTP boundary, plan the smallest application-owned stable HTTPS adapter over existing business functions. If a safe live verification input or working credential is missing, leave that evidence explicitly unproven and name the exact prerequisite. Only multi-origin routing or no stable HTTP origin blocks and hands off to the existing owning routing workflow.',
    stop: 'Stop after presenting the draft plan and before any file or hosted mutation until the user explicitly authorizes the exact next action and target.',
  },
  {
    name: 'authoring-mcp-servers',
    description:
      'Use when creating or extending a headless Noodle Seed MCP server, tool, resource, prompt, or typed model-facing capability.',
    outcome:
      'Deliver focused model-facing MCP behavior through the configured TypeScript entrypoint.',
    positiveTriggers: ['Build a headless MCP server.', 'Add a typed tool, resource, or prompt.'],
    negativeTriggers: [
      'Do not use when the primary outcome is a widget.',
      'Do not use only to diagnose or deploy existing behavior.',
    ],
    requiredInputs: [
      'Requested user intent.',
      'Expected typed result.',
      'External operation contract when applicable.',
    ],
    primaryReference: 'references/build-an-mcp-server.md',
    supportingReferences: ['references/authoring-workflow.md', 'references/sdk-surface.md'],
    evidence:
      'The TypeScript behavior and explicit product-guide decision validate and pass local smoke; connector reads also have real-output proof.',
    recovery:
      'Resume at the first failing compile, smoke, credential, mapping, or live-read layer.',
    stop: 'Stop at local delivery unless another requested outcome explicitly authorizes a handoff.',
  },
  {
    name: 'connecting-apis-to-mcp',
    description:
      'Use when all four API-evidence inputs exist—and only then: API base URL, authentication scheme, representative safe read, and observed response.',
    outcome:
      'Connect a real API using managed credentials and mappings proven against observed output.',
    positiveTriggers: [
      'Connect this API after confirming its base URL, authentication scheme, safe read, and observed response.',
    ],
    negativeTriggers: [
      'Do not use for static local behavior.',
      'Do not use when all available API evidence is stale, inaccessible, undocumented-only, or otherwise unusable.',
    ],
    requiredInputs: [
      'API base URL and authentication scheme.',
      'Representative safe read.',
      'User intent and observed response shape.',
    ],
    primaryReference: 'references/connect-an-api.md',
    supportingReferences: ['references/authoring-workflow.md'],
    evidence:
      'A safe live read returns populated intentionally mapped fields through the effective local target.',
    recovery:
      'Separate authentication, transport, response-shape, mapping, and empty-result failures before editing.',
    stop: 'Stop before live writes without explicit approval, known effect, and a safe target.',
  },
  {
    name: 'building-mcp-apps',
    description:
      'Use when a Noodle Seed MCP App, widget, interactive card, visual interaction, or host-visible UI is the primary requested outcome.',
    outcome:
      'Deliver an MCP App whose visual interaction earns its place and preserves useful model-visible fallback.',
    positiveTriggers: ['Build an MCP App or widget.', 'Add a host-visible interactive workflow.'],
    negativeTriggers: [
      'Do not use when concise text fully serves the user.',
      'Do not use for headless server work with no UI outcome.',
    ],
    requiredInputs: [
      'Target user and explicit UI benefit.',
      'Primary interaction and states.',
      'Model-visible result and text fallback.',
    ],
    primaryReference: 'references/build-an-mcp-app.md',
    supportingReferences: ['references/experience-design.md', 'references/widgets-and-apps.md'],
    evidence:
      'The App records its product-guide decision and passes validation, local smoke, app checks, and the requested preview or host evidence level.',
    recovery:
      'Distinguish data-contract, widget-runtime, rendering, host, and deployment failures.',
    stop: 'Stop before deployment or publication unless that distinct outcome was requested.',
  },
  {
    name: 'embedding-mcp-assistants',
    description:
      'Use when embedding a Noodle assistant into an existing SaaS or web application with browser, identity, session, and credential boundaries.',
    outcome:
      'Select one decision-complete assistant topology, then deliver the embed with identity and credential separation proven at the tested level.',
    positiveTriggers: [
      'Embed the Noodle assistant in an existing web app.',
      'Wire browser mounting and session exchange.',
    ],
    negativeTriggers: [
      'Do not use to build a standalone MCP App.',
      'Do not use when the request is only server authoring or deployment.',
    ],
    requiredInputs: [
      'Named end user, conversational job, and one to three workflows.',
      'Exact application origin, mounting point, and existing host framework.',
      'Access mode plus the identity, session, and server-owned routing boundary.',
      'Managed or custom renderer and its explicit product benefit.',
      'Model owner and requested local, hosted, or production evidence level.',
    ],
    primaryReference: 'references/embedded-assistant.md',
    supportingReferences: ['references/authoring-workflow.md'],
    evidence:
      'One architecture brief owns the selected topology, and the embed works at the requested boundary without forwarding inbound credentials to business backends.',
    recovery:
      'Localize failures to origin, session exchange, browser mount, MCP surface, or hosted configuration.',
    stop: 'Stop before code when the user, job, workflow, access, identity, origin, routing, renderer, model owner, or evidence target is unresolved; hand vague product intent to designing-mcp-products.',
  },
  {
    name: 'verifying-mcp-delivery',
    description:
      'Use when proving a Noodle Seed MCP project works at a named compile, local, connector, App, host, deployment, or production evidence level.',
    outcome: 'Report the highest evidence level actually rerun without upgrading weaker proof.',
    positiveTriggers: [
      'Verify this MCP delivery before handoff.',
      'Prove which delivery layers currently pass.',
    ],
    negativeTriggers: [
      'Do not use as a substitute for fixing a known failure.',
      'Do not infer hosted health from local success.',
    ],
    requiredInputs: [
      'Requested evidence level.',
      'Current target.',
      'Existing evidence and its freshness.',
    ],
    primaryReference: 'references/verify-and-recover.md',
    supportingReferences: ['references/test-in-hosts.md'],
    evidence:
      'Every dependency below the requested level passes now, or the first unproven layer is explicit.',
    recovery:
      'Hand a concrete failing layer to debugging-mcp-delivery with all passing evidence preserved.',
    stop: 'Stop after the requested level passes or the first bounded failure is isolated.',
  },
  {
    name: 'debugging-mcp-delivery',
    description:
      'Use when an existing Noodle Seed MCP project has a concrete validation, runtime, connector, App, host, deployment, or production failure.',
    outcome:
      'Repair or isolate the first failing evidence layer while preserving everything already proven.',
    positiveTriggers: [
      'Diagnose this failing MCP project.',
      'Inspect a hosted failure from logs or status.',
    ],
    negativeTriggers: [
      'Do not use for a greenfield build with no failure evidence.',
      'Do not mutate hosted state during read-only inspection.',
    ],
    requiredInputs: [
      'Exact failing command or symptom.',
      'Current target and evidence level.',
      'Most recent sanitized failure.',
    ],
    primaryReference: 'references/verify-and-recover.md',
    supportingReferences: ['references/troubleshooting.md', 'references/inspect-hosted.md'],
    evidence:
      'The failed layer is rerun successfully, or the stable blocker and exact next action are reported.',
    recovery:
      'After two attempts with the same signature, stop editing and preserve the repro and passing layers.',
    stop: 'Stop before hosted mutation unless the user separately requests deploying-mcp-services.',
  },
  {
    name: 'deploying-mcp-services',
    description:
      'Use when the user explicitly requests a Noodle Seed hosted link, configuration write, deployment, access change, rollback, or connection write.',
    outcome:
      'Apply only the explicitly authorized hosted mutation to the explicit org, app, and environment.',
    positiveTriggers: [
      'Deploy this MCP service to an explicit environment.',
      'Roll back or change hosted access.',
    ],
    negativeTriggers: [
      'Do not use for preparation, inspection, or local-only work.',
      'Do not select or default a mutation target implicitly.',
    ],
    requiredInputs: [
      'Explicit org, app, and environment.',
      'Authorized mutation.',
      'Pre-deploy verification evidence.',
    ],
    primaryReference: 'references/deploy-and-ops.md',
    supportingReferences: ['references/cli-commands.md'],
    evidence:
      'The requested hosted state is confirmed without claiming unperformed host or production checks.',
    recovery:
      'Preserve local evidence and isolate authentication, target, build, rollout, health, or rollback failures.',
    stop: 'Stop and ask when target, authority, or effect is ambiguous.',
  },
  {
    name: 'publishing-mcp-integrations',
    description:
      'Use when preparing, reviewing, or submitting a Noodle Seed MCP integration to a host or app directory.',
    outcome: 'Produce complete submission evidence with host-review uncertainty stated explicitly.',
    positiveTriggers: [
      'Prepare this MCP integration for a directory.',
      'Review or submit the host listing.',
    ],
    negativeTriggers: [
      'Do not use for ordinary deployment.',
      'Do not submit when the user requested preparation or review only.',
    ],
    requiredInputs: [
      'Target directory.',
      'Current deployment and verification evidence.',
      'Requested review, preparation, or submission boundary.',
    ],
    primaryReference: 'references/publishing.md',
    supportingReferences: ['references/app-directory-compliance.md'],
    evidence:
      'Required product, policy, deployment, media, and test evidence is present or explicitly missing.',
    recovery:
      'Return missing implementation or evidence to its owning skill without restarting discovery.',
    stop: 'Stop before external submission without explicit user authorization.',
  },
  {
    name: 'reporting-noodle-feedback',
    description:
      'Use when a Noodle Seed bug, misleading instruction, missing capability, or concrete product improvement should be proposed to the user.',
    outcome:
      'Preview one sanitized feedback proposal and submit it once only after informed explicit approval.',
    positiveTriggers: [
      'Report a Noodle Seed bug or documentation gap.',
      'Propose a concrete Noodle product improvement.',
    ],
    negativeTriggers: [
      'Do not use for generic project bugs.',
      'Do not send customer code, identifiers, logs, or secrets.',
    ],
    requiredInputs: [
      'One distinct finding.',
      'Sanitized observed and expected behavior.',
      'User approval for the exact dry-run preview and live command.',
    ],
    primaryReference: 'references/feedback.md',
    supportingReferences: [],
    evidence:
      'The user saw the exact sanitized preview, diagnostics, destination, and live command; only a returned reference proves submission.',
    recovery:
      'If login or rate limits block the one live submission, report that nothing was sent. A recording failure has an unknown outcome: report no reference and never auto-login or retry-loop.',
    stop: 'Stop after the local dry-run and before the live command until the user explicitly approves it.',
  },
];

export function renderBehaviorSkillBody(skill: BehaviorSkill, _target: AgentTarget): string {
  return [
    `# ${skill.name}`,
    '',
    skill.outcome,
    '',
    '## Use when',
    '',
    ...skill.positiveTriggers.map((trigger) => `- ${trigger}`),
    '',
    '## Do not use when',
    '',
    ...skill.negativeTriggers.map((trigger) => `- ${trigger}`),
    '',
    '## Required inputs',
    '',
    ...skill.requiredInputs.map((entry) => `- ${entry}`),
    '',
    '## Workflow',
    '',
    `Read and follow the canonical playbook at \`${skill.primaryReference}\`. It owns the workflow; do not recreate it here or load the command catalog speculatively.`,
    ...skill.supportingReferences.map(
      (reference) =>
        `Load the supporting reference at \`${reference}\` only when the playbook or observed evidence names that concern.`,
    ),
    '',
    '## Verification evidence',
    '',
    skill.evidence,
    '',
    '## Recovery paths',
    '',
    skill.recovery,
    '',
    '## Stop conditions',
    '',
    skill.stop,
    '',
    '## Handoff contract',
    '',
    'Pass the selected outcome, explicit target, changed files, commands run, passing evidence, first unproven evidence layer, sanitized failure, remaining authority, and exact next action. The receiving skill continues from that layer; do not restart discovery or discard prior proof.',
  ].join('\n');
}
