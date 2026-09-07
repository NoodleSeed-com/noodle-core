// Renderers for the hierarchical `noodle-seed` skill: one SKILL.md router plus one-level-deep
// reference files. Factual sections (SDK surface, CLI commands, compile errors, React hooks) are
// derived from the generated surface (./generated/surface.ts) + curated maps (./curated/*), so
// they never drift from the real SDK/CLI/compiler. This module owns the reference registry, generated
// references, and curated agent-contract reference; skill-router.ts owns route selection, while the
// rest of the curated prose references live in the focused ./skill-*-ref(s).ts modules. The drift gate
// enforces both currency (every generated name rendered) and structure (router < 500 lines,
// references one level deep, long references open with a Contents TOC).
import { COMMAND_GROUP_ORDER, COMMAND_GROUPS } from './curated/command-groups.js';
import { ERROR_FIXES } from './curated/error-fixes.js';
import { CLI_COMMANDS, COMPILE_ERROR_CODES, SDK_EXPORTS } from './generated/surface.js';
import { mdTable } from './md.js';
import { renderAgentGuideReference } from './skill-agent-guide-ref.js';
import { renderBuildAnMcpAppReference } from './skill-app-playbook-ref.js';
import {
  renderAuthoringWorkflowReference,
  renderExamplesReference,
  renderWidgetsAndAppsReference,
} from './skill-authoring-refs.js';
import { renderConnectAnApiReference } from './skill-connect-refs.js';
import { renderExperienceDesignReference } from './skill-design-refs.js';
import { renderEmbeddedAssistantReference } from './skill-embedded-assistant-ref.js';
import { renderWrapExistingAppReference } from './skill-existing-app-ref.js';
import { renderFeedbackReference } from './skill-feedback-ref.js';
import {
  renderAppDirectoryComplianceReference,
  renderDeployAndOpsReference,
  renderInspectHostedReference,
  renderPublishingReference,
  renderTestInHostsReference,
  renderTroubleshootingReference,
} from './skill-operations-refs.js';
import { APP_DIRECTORY_COMPLIANCE_REFERENCE } from './skill-router.js';
import { renderBuildAnMcpServerReference } from './skill-server-playbook-ref.js';
import { renderToolDesignReference } from './skill-tool-design-ref.js';
import { renderVerifyAndRecoverReference } from './skill-verification-ref.js';

/** A reference file emitted under the skill directory, one level deep. */
export interface SkillReference {
  readonly relPath: string;
  readonly render: () => string;
}

export { skillRouterBody } from './skill-router.js';

// ----------------------------------------------------------------------------
// references/sdk-surface.md (GENERATED from SDK_EXPORTS + curated recipes)
// ----------------------------------------------------------------------------

const SDK_GROUPS: ReadonlyArray<{ label: string; members: readonly string[] }> = [
  { label: 'Server & tools', members: ['server', 'tool'] },
  { label: 'Views & assets', members: ['asset', 'annotations'] },
  {
    label: 'Connectors & flows',
    members: ['connector', 'connection', 'bind', 'googleWorkloadIdentity', 'when'],
  },
  { label: 'Resources & prompts', members: ['resource', 'prompt'] },
  { label: 'Managed config', members: ['secret', 'variable'] },
  { label: 'Customer auth', members: ['customerAuth'] },
  { label: 'Sessions', members: ['handoffSession'] },
  { label: 'Schemas', members: ['z'] },
];

const SDK_NOTES: Record<string, string> = {
  server: '`server(name, options, definitions)` — the server/app root.',
  tool: '`tool(name, options)` — declare every tool; add `view` to render an MCP App or `visibility: ["app"]` for an app-only helper.',
  asset: '`asset("./path")` — reference a packaged asset (e.g. an image).',
  annotations: '`annotations(...)` — tool/Apps annotation metadata.',
  connector:
    '`connector("id").version(...).http({...})` or `.compute(...)` — declarative data connectors.',
  connection:
    '`connection("logical_id", source)` — stable downstream-account/workload identity used by a connector binding.',
  bind: '`bind(connector, { profile, connection })` — bind one connector alias to an exact credential profile and logical connection.',
  googleWorkloadIdentity:
    '`googleWorkloadIdentity({ provider: variable(...), access })` — keyless deployed-workload access to Google APIs through WIF; configure with `noodle auth google`.',
  when: '`when(...)` — declarative conditions for recorded flows (no native branching on runtime values).',
  resource: '`resource(name, { ... })` — an MCP resource.',
  prompt: '`prompt(name, { ... })` — an MCP prompt.',
  secret: '`secret("NAME")` — reference a managed secret (operated via `noodle secrets`).',
  variable:
    '`variable("NAME")` — reference managed configuration; add `{ schema, default?, portal?, requiredFor? }` and register in `server.variables` for typed business settings. Operate through `noodle variables` or authorized Portal settings.',
  customerAuth:
    '`customerAuth.oidc(...)`, `.federatedOidc(...)`, `.firebase(...)`, or `.microsoft(...)` — end-user/customer identity for `--access customers` deployments. A direct/federated issuer must publish direct RFC 8414 discovery, Dynamic Client Registration, authorization-code + refresh grants, PKCE `code_challenge_methods_supported: ["S256"]`, public-client `token_endpoint_auth_methods_supported: ["none"]`, and a public JWKS; verify it with `noodle auth doctor src/server.ts`. Firebase Web App fields are browser-visible configuration: use `variable(...)`, not `secret(...)`, and restrict the key in Firebase.',
  handoffSession: '`handoffSession(...)` — typed cross-host handoff session envelopes.',
  z: '`z` — Zod, for input/output schemas (compiles to JSON Schema 2020-12).',
};

// Worked, minimal-complete recipes for the builders that have no obvious one-line shape (resource,
// prompt, and a non-trivial tool `fulfil`). The full-server recipes are gate-verified on every
// `pnpm test` (scripts/verify-skill-snippets.mjs runs `noodle validate` on each); the resource/prompt
// fragments were validated when authored (assembled into a server) but are illustrative shape, not
// independently gated.
const SDK_RECIPES: readonly string[] = [
  '## Recipes',
  '',
  'Minimal, complete, compiling recipes — author in `src/server.ts`, then `noodle validate`. Inside a `fulfil`, `ctx.input` (a prompt’s arguments or a templated resource’s URI variables) and `ctx.connectors` are **symbolic**: reference them to record a flow. Recording is not execution, so never branch on their runtime values with native `if` — use `when(...)`.',
  '',
  '### Resource',
  '',
  '`resource(name, { uri, title?, description?, mimeType?, fulfil })`. `fulfil` returns the resource body itself — a plain string, or a bare content entry `{ uri, mimeType, text }` — and the runtime maps it into MCP `contents` for you. Do **not** return a `{ contents: [...] }` wrapper: the runtime already wraps it, so that double-wraps (the whole JSON ends up inside `contents[0].text`). Use a fixed URI for a constant document, or a `{var}` template whose variable arrives on `ctx.input`.',
  '',
  '```ts',
  "import { resource } from '@noodleseed/one';",
  '',
  '// Fixed-URI resource: one constant document the model can read.',
  "resource('changelog', {",
  "  uri: 'docs://changelog',",
  "  title: 'Changelog',",
  "  mimeType: 'text/markdown',",
  '  // Return the bare content entry (or just a string); never a { contents: [...] } wrapper.',
  "  fulfil: () => ({ uri: 'docs://changelog', mimeType: 'text/markdown', text: 'Changelog: 1.0.0 first release' }),",
  '});',
  '',
  '// {var} URI-template resource: the URI variable arrives on ctx.input (a symbolic ref).',
  "resource('ticket', {",
  "  uri: 'tickets://{id}',",
  "  title: 'Support ticket',",
  "  mimeType: 'text/markdown',",
  '  fulfil: (ctx) => ({',
  '    uri: `tickets://${ctx.input.id}`,',
  "    mimeType: 'text/markdown',",
  '    text: `Ticket ${ctx.input.id}`,',
  '  }),',
  '});',
  '```',
  '',
  '### Prompt',
  '',
  "`prompt(name, { title?, description?, arguments?, fulfil })`. `arguments` is a Zod object (each key becomes a `prompts/list` descriptor) or an explicit `[{ name, description?, required? }]` list. `fulfil` returns `{ messages: [{ role, content: { type: 'text', text } }] }`; supplied argument values arrive on `ctx.input`.",
  '',
  '```ts',
  "import { prompt, z } from '@noodleseed/one';",
  '',
  "prompt('summarize_ticket', {",
  "  title: 'Summarize ticket',",
  "  description: 'Draft a short summary of a support ticket.',",
  '  // A Zod object: each key becomes a prompts/list descriptor (or pass [{ name, description?, required? }]).',
  '  arguments: z.object({',
  "    ticket_id: z.string().describe('Ticket to summarize'),",
  "    tone: z.enum(['concise', 'detailed']).default('concise'),",
  '  }),',
  '  // Argument values arrive on ctx.input; return the prompts/get messages shape.',
  '  fulfil: (ctx) => ({',
  '    messages: [',
  '      {',
  "        role: 'user',",
  '        content: {',
  "          type: 'text',",
  '          text: `Summarize ticket ${ctx.input.ticket_id} in a ${ctx.input.tone} tone.`,',
  '        },',
  '      },',
  '    ],',
  '  }),',
  '});',
  '```',
  '',
  '### Non-trivial tool: ctx connectors, annotations, visibility, async',
  '',
  "`ctx` is `{ input, user, connectors }`. Bind connectors with `use` on the server, then call one inside `fulfil` to record a step. `annotations.readOnly()` declares a closed-world safe read. TypeScript action helpers enforce confirmation only with `{ confirm: true }`; omitted or `false` executes directly, and action/destructive/open-world hints alone never enable the gate. For stateless hosts that cannot present Noodle confirmation, set `interactions: { confirmationFallback: 'host' }` in the `server` options to explicitly trust native host write approval; omission remains fail-closed and the fallback never supplies missing `ctx.elicit` input. `visibility` defaults to `['model', 'app']` — set `['app']` to hide a helper from the model. For a narrow explicit-intent tool, `modelVisibility: { latestMessageIncludesAny: [...] }` deterministically limits model discovery to a latest user message containing one normalized literal phrase. Add `oncePerSession: true` to prevent another successful model-selected use in that conversation, and `requiredWhenVisible: true` only when the matching tool must be called before normal discovery resumes. These are presentation controls, not authorization or idempotency. `fulfil` may be `async` (the compiler awaits it while recording).",
  '',
  '```ts',
  "import { annotations, connector, server, tool, z } from '@noodleseed/one';",
  '',
  '// A tool-facing HTTP connector, bound to the server via `use`, reachable as ctx.connectors.crm.',
  "const crm = connector('crm')",
  "  .version('1.0.0')",
  '  .http({',
  "    baseUrl: 'https://crm.example.com',",
  "    allowedOrigins: ['https://crm.example.com'],",
  '    operations: {',
  '      get_ticket: {',
  "        type: 'read',",
  "        method: 'GET',",
  "        path: '/tickets',",
  "        query: ['id'],",
  '        input: z.object({ id: z.string() }),',
  '        output: z.object({ subject: z.string().optional(), status: z.string().optional() }),',
  "        response: { subject: '${response.subject}', status: '${response.status}' },",
  '      },',
  '    },',
  '  });',
  '',
  "export default server('support', { title: 'Support', version: '1.0.0', use: { crm } }, [",
  "  tool('get_ticket', {",
  "    description: 'Fetch a support ticket by id.',",
  '    input: z.object({ id: z.string() }),',
  '    output: z.object({ subject: z.string(), status: z.string() }),',
  '    annotations: annotations.readOnly(), // read-only hint for hosts',
  "    visibility: ['model', 'app'], // default; use ['app'] to hide the tool from the model",
  "    modelVisibility: { latestMessageIncludesAny: ['show ticket', 'open ticket'] },",
  '    // ctx is { input, user, connectors }. A connector call records one flow step (a Ref) —',
  '    // recording is not execution, so never branch on the result with native if (use when).',
  '    fulfil: ({ input, connectors }) => {',
  '      const found = connectors.crm.get_ticket({ id: input.id });',
  '      return { subject: found.subject, status: found.status };',
  '    },',
  '  }),',
  "  tool('echo', {",
  "    description: 'Echo text back.',",
  '    input: z.object({ text: z.string() }),',
  '    output: z.object({ echo: z.string() }),',
  '    annotations: annotations.action(), // world-affecting hint; add { confirm: true } to gate',
  '    // fulfil may be async — the compiler awaits it while recording the flow.',
  '    fulfil: async ({ input }) => ({ echo: input.text }),',
  '  }),',
  ']);',
  '```',
  '',
  '### Conditional flow with when()',
  '',
  '`when(condition, () => record)` records the inner step(s) guarded by a condition instead of a native `if`. `when` is a **free function** (import it), the condition is `ref.equals(scalar)` (equality only — no `<`/`>`/`&&`), and the recorded step is skipped at runtime unless the condition holds. Never write a native `if` on a symbolic ref, and never call a method on one (e.g. `input.name.trim()`) — both silently mis-record or throw; compose strings with a template literal and branch with `when(...)`.',
  '',
  '```ts',
  "import { connector, server, tool, when, z } from '@noodleseed/one';",
  '',
  '// Two read operations; the tracking lookup only runs when the order came back shipped.',
  "const orders = connector('orders')",
  "  .version('1.0.0')",
  '  .http({',
  "    baseUrl: 'https://orders.example.com',",
  "    allowedOrigins: ['https://orders.example.com'],",
  '    operations: {',
  '      get_order: {',
  "        type: 'read',",
  "        method: 'GET',",
  "        path: '/orders',",
  "        query: ['id'],",
  '        input: z.object({ id: z.string() }),',
  '        output: z.object({ id: z.string().optional(), status: z.string().optional() }),',
  "        response: { id: '${response.id}', status: '${response.status}' },",
  '      },',
  '      get_tracking: {',
  "        type: 'read',",
  "        method: 'GET',",
  "        path: '/tracking',",
  "        query: ['order_id'],",
  '        input: z.object({ order_id: z.string() }),',
  '        output: z.object({ url: z.string().optional() }),',
  "        response: { url: '${response.url}' },",
  '      },',
  '    },',
  '  });',
  '',
  "export default server('orders_app', { title: 'Orders', version: '1.0.0', use: { orders } }, [",
  "  tool('track_order', {",
  "    description: 'Find shipment tracking for an order.',",
  '    input: z.object({ orderId: z.string() }),',
  '    output: z.object({',
  '      orderId: z.string(),',
  '      status: z.string(),',
  '      trackingUrl: z.string().optional(),',
  '    }),',
  '    fulfil: ({ input, connectors }) => {',
  '      const order = connectors.orders.get_order({ id: input.orderId });',
  '      // Record the tracking step only when order.status === "shipped" (equality-only condition).',
  "      const tracking = when(order.status.equals('shipped'), () =>",
  '        connectors.orders.get_tracking({ order_id: order.id }),',
  '      );',
  '      return {',
  '        orderId: order.id,',
  '        status: order.status,',
  '        // `.optional()` marks a ref that may be absent when its guarding step did not run.',
  '        trackingUrl: tracking.url.optional(),',
  '      };',
  '    },',
  '  }),',
  ']);',
  '```',
];

const SDK_AUTHORING_SIGNATURES: readonly string[] = [
  '## Authoring signatures',
  '',
  '- `server(name, options, definitions)` — `options` commonly includes `title`, `version`, `instructions`, `agentGuide`, `distribution`, `branding`, `auth`, `use`, `provides`, `state`, and `handoff`; `definitions` is the array of tools/resources/prompts.',
  '- `tool(name, { description, input, output, annotations?, visibility?, modelVisibility?, view?, fulfil })` — `input`/`output` are Zod schemas; `fulfil({ input, connectors, user })` returns data matching `output`. Add `view: { component, entry }` for a React widget; use `visibility: ["app"]` for an app-only helper. Use `modelVisibility.latestMessageIncludesAny` only for normalized literal explicit-intent discovery; `oncePerSession` and `requiredWhenVisible` add deterministic presentation controls, never authorization or idempotency.',
  '- Keep tool input names application-owned and meaningful; `__noodleIntent` is reserved for an optional serve-time operator analytics adapter and never reaches `fulfil`.',
  '- `resource(name, { uri, description?, mimeType?, fulfil })` and `prompt(name, { description?, arguments?, fulfil })` expose MCP resources/prompts.',
  '- View metadata (`viewTitle`, `viewDescription`, `csp`, `domain`, `permissions`) belongs on the tool that renders it; `asset("./path")` packages local files.',
  '- `customerAuth.*(...)` belongs in `server` options when deployed customer callers need verified identity; inspect `examples/customer-auth` or `examples/sharepoint` before using it.',
  '- `state` defines durable widget state handles; handle schemas may use `.optional()`/`.default()` — defaulted fields are optional on write, so a save that omits them still validates. Add `claimOnAuthentication: true` only to an explicitly caller-scoped handle with a finite TTL when a mixed public assistant should atomically adopt that expiring draft on sign-in-ticket spend. `handoff` declares allowed external domains for safe host handoff.',
];

function renderSdkSurfaceReference(): string {
  const remaining = new Set(SDK_EXPORTS);
  const sections: string[] = [];
  for (const group of SDK_GROUPS) {
    const members = group.members.filter((name) => remaining.has(name));
    if (members.length === 0) continue;
    for (const name of members) remaining.delete(name);
    sections.push(
      `### ${group.label}`,
      '',
      ...members.map((name) => `- ${SDK_NOTES[name] ?? `\`${name}\``}`),
      '',
    );
  }
  if (remaining.size > 0) {
    sections.push(
      '### Other',
      '',
      ...[...remaining].map((name) => `- ${SDK_NOTES[name] ?? `\`${name}\``}`),
      '',
    );
  }
  return [
    '# @noodleseed/one SDK surface',
    '',
    'Import these from `@noodleseed/one`. They are declarative builders that emit manifest data — do not hand-author the manifest or runtime artifacts. React view helpers come from `@noodleseed/one/react` (`generateHelpers`); the hook surface is documented in `widgets-and-apps.md`.',
    'Platform helper connectors are explicit subpath imports from `@noodleseed/one/platform` (`noodlePlatform`, `noodlePlatformCatalog`) when an app needs first-party hosted state APIs.',
    '',
    '## Contents',
    '',
    '- Exports by area',
    '- Authoring signatures',
    '- Recipes',
    '',
    '## Exports by area',
    '',
    ...sections,
    ...SDK_AUTHORING_SIGNATURES,
    '',
    ...SDK_RECIPES,
  ]
    .join('\n')
    .trimEnd();
}

// ----------------------------------------------------------------------------
// references/cli-commands.md (GENERATED from CLI_COMMANDS + curated groups)
// ----------------------------------------------------------------------------

function renderCliCommandsReference(): string {
  const groupOrder = [...COMMAND_GROUP_ORDER, 'Other'];
  const byGroup = new Map<string, string[]>();
  for (const name of CLI_COMMANDS) {
    if ((COMMAND_GROUPS[name]?.audience ?? 'developer') !== 'developer') continue;
    const group = COMMAND_GROUPS[name]?.group ?? 'Other';
    const list = byGroup.get(group) ?? [];
    list.push(name);
    byGroup.set(group, list);
  }
  const presentGroups = groupOrder.filter((group) => (byGroup.get(group)?.length ?? 0) > 0);
  const sections: string[] = [];
  for (const group of presentGroups) {
    const rows = (byGroup.get(group) ?? []).map((name) => [
      `\`noodle ${name}\``,
      COMMAND_GROUPS[name]?.summary ?? '—',
    ]);
    sections.push(`## ${group}`, '', mdTable(['Command', 'What it does'], rows), '');
  }
  return [
    '# noodle CLI commands',
    '',
    'Developer-facing `noodle` commands, grouped by area. Local authoring commands (`validate`, `test`, `dev`, `tools`, `resources`, `prompts`) need no login or link. Discover the exact command surface for the installed release with `noodle commands --json`.',
    '',
    '## Contents',
    '',
    ...presentGroups.map((group) => `- ${group}`),
    '',
    ...sections,
  ]
    .join('\n')
    .trimEnd();
}

// ----------------------------------------------------------------------------
// references/agent-contract.md (CURATED)
// ----------------------------------------------------------------------------

function renderAgentContractReference(): string {
  return [
    '# Agent contract: --json, exit codes, output modes',
    '',
    'Every `--json` command returns the canonical envelope below on stdout and keeps stderr empty. Decide what to do next by parsing machine state — do not scrape human prose.',
    '',
    '## Contents',
    '',
    '- Response envelope',
    '- Exit codes',
    '- Output modes',
    '- Repair loop',
    '',
    '## Response envelope',
    '',
    'A one-shot `--json` command returns exactly one JSON object on stdout; stderr stays empty:',
    '',
    '- **Success**: `{ ok: true, data, warnings? }` — `data` is the command payload; `warnings?` is an optional array of non-fatal notes.',
    '- **Failure**: `{ ok: false, error: { code, message, cause?, fix, next, requestId?, retryable?, retryAfterSeconds? } }` — `code` is the stable machine code to branch on, `message` is human text, `cause?` is the underlying error, `fix` states the correction, `next` names the command to run next, `requestId?` correlates a hosted call, and retry metadata tells automation whether and when to retry.',
    '- **Field errors** carry a dotted `path`: multi-error commands (e.g. `noodle validate`) nest them under `error.errors[]`, each `{ code, path, message }`. The top-level `error` still carries `code`/`message`/`fix`/`next`; the per-field `path`s live in `error.errors[]`.',
    '- **Repair prose is isolated**: ready-to-apply repair text appears only under `error.fixPrompt` (surfaced by `--fix-prompt`), never mixed into `message` or `data`.',
    '- **Streams are NDJSON envelopes**: the initial snapshot is `{ ok: true, data: { kind: "snapshot", snapshot } }`, subsequent records are `{ ok: true, data: { kind: "event", event } }`, and a terminal failure is the ordinary `{ ok: false, error }` envelope on its own line. Parse each line independently.',
    '',
    '## Exit codes',
    '',
    'Branch on the process exit code before parsing the body:',
    '',
    mdTable(
      ['Code', 'Meaning'],
      [
        ['`0`', 'ok'],
        ['`1`', 'failure (command ran, the work failed)'],
        ['`2`', 'usage (bad flags or arguments)'],
        ['`3`', 'auth (login or permission required)'],
        ['`4`', 'unreachable (service or network)'],
        ['`5`', 'mcp/tool-call error (a `tools`/`resources`/`prompts`/`test` smoke call failed)'],
      ],
    ),
    '',
    '## Output modes',
    '',
    'Two kinds of output — never mix them:',
    '',
    '- `--json` — **machine state**: the envelope above. Use it to decide what to do next.',
    '- `--fix-prompt` / `--agent-output` (aliases) — **agent-readable text**, not the envelope: a ready-to-apply repair prompt for authoring commands (`validate`/`test`/`check`), or an operational `health` verdict (`ok`/`attention`) with `attention[]` next-commands for ops commands (`metrics`/`doctor`/`alerts`). Use it to author a fix or judge a running deployment.',
    '',
    '## Repair loop',
    '',
    'On a `validate` failure: parse `error.code` + `path`, fix exactly that field in `src/server.ts`, then re-run `noodle validate --json`. Never freeform re-edit. Repeat until `ok: true`, then `noodle test --json`.',
  ].join('\n');
}

// ----------------------------------------------------------------------------
// references/compile-errors.md (GENERATED codes + curated fixes)
// ----------------------------------------------------------------------------

function renderCompileErrorsReference(): string {
  const rows = COMPILE_ERROR_CODES.map((code) => [`\`${code}\``, ERROR_FIXES[code] ?? '—']);
  return [
    '# Fixing noodle validate errors',
    '',
    '## Contents',
    '',
    '- The repair loop',
    '- Error codes',
    '',
    '## The repair loop',
    '',
    'Run `noodle validate` (add `--json` for the machine-readable envelope, `--fix-prompt` for an agent repair prompt). On failure the envelope is `{ok:false,error:{code,message,fix,next,errors:[{code,path,message}]}}`: each entry in `error.errors[]` carries a `code`, a dotted `path` to the offending field, and a `message`; many also carry `expected`/`got`, `didYouMean`/`suggestions`, and a `docAnchor` (the full envelope is in `agent-contract.md`). Fix the specific error the `path` locates, then re-validate. Do not freeform re-edit. Once `noodle validate` passes, run `noodle test`, then `noodle dev`.',
    '',
    '## Error codes',
    '',
    mdTable(['Code', 'Fix'], rows),
  ]
    .join('\n')
    .trimEnd();
}

// ----------------------------------------------------------------------------
// Reference registry (consumed by index.ts and the drift gate)
// ----------------------------------------------------------------------------

export const SKILL_REFERENCES: readonly SkillReference[] = [
  { relPath: 'references/product-agent-guides.md', render: renderAgentGuideReference },
  { relPath: 'references/sdk-surface.md', render: renderSdkSurfaceReference },
  { relPath: 'references/cli-commands.md', render: renderCliCommandsReference },
  { relPath: 'references/agent-contract.md', render: renderAgentContractReference },
  { relPath: 'references/compile-errors.md', render: renderCompileErrorsReference },
  { relPath: 'references/build-an-mcp-server.md', render: renderBuildAnMcpServerReference },
  { relPath: 'references/authoring-workflow.md', render: renderAuthoringWorkflowReference },
  { relPath: 'references/tool-design.md', render: renderToolDesignReference },
  { relPath: 'references/embedded-assistant.md', render: renderEmbeddedAssistantReference },
  { relPath: 'references/connect-an-api.md', render: renderConnectAnApiReference },
  { relPath: 'references/wrap-existing-app.md', render: renderWrapExistingAppReference },
  { relPath: 'references/build-an-mcp-app.md', render: renderBuildAnMcpAppReference },
  { relPath: 'references/experience-design.md', render: renderExperienceDesignReference },
  { relPath: 'references/widgets-and-apps.md', render: renderWidgetsAndAppsReference },
  { relPath: 'references/test-in-hosts.md', render: renderTestInHostsReference },
  { relPath: 'references/verify-and-recover.md', render: renderVerifyAndRecoverReference },
  { relPath: 'references/troubleshooting.md', render: renderTroubleshootingReference },
  { relPath: 'references/inspect-hosted.md', render: renderInspectHostedReference },
  { relPath: 'references/deploy-and-ops.md', render: renderDeployAndOpsReference },
  { relPath: 'references/publishing.md', render: renderPublishingReference },
  { relPath: APP_DIRECTORY_COMPLIANCE_REFERENCE, render: renderAppDirectoryComplianceReference },
  { relPath: 'references/examples.md', render: renderExamplesReference },
  { relPath: 'references/feedback.md', render: renderFeedbackReference },
];
