// Curated operations-side skill references: test-in-hosts, troubleshooting, deploy-and-ops,
// publishing. Facts here mirror the shipped CLI commands and host connection flows; keep prose
// aligned with `noodle connect`, `noodle check`, and the analytics command surface.
import { mdTable } from './md.js';
import { APP_DIRECTORY_COMPLIANCE_REFERENCE } from './skill-router.js';

// ----------------------------------------------------------------------------
// references/test-in-hosts.md (CURATED)
// ----------------------------------------------------------------------------

export function renderTestInHostsReference(): string {
  return [
    '# Test in real hosts',
    '',
    'Local `noodle dev` and `noodle devtools` prove the server works; the widget experience is only proven inside a real host. `noodle connect <client>` prints the exact setup flow per host.',
    '',
    '## Contents',
    '',
    '- Local inspection first',
    '- Agent hosts (Claude Code, Codex, editors)',
    '- ChatGPT (developer mode)',
    '- Claude',
    '- Public URL for a local server',
    '- What to verify',
    '',
    '## Local inspection first',
    '',
    'Run `noodle dev` and inspect the loopback endpoint with MCP Inspector: `noodle connect inspector` prints the flow (`npx @modelcontextprotocol/inspector <printed endpoint>`). Preview widget metadata and rendering with `noodle devtools`.',
    '',
    '## Agent hosts (Claude Code, Codex, editors)',
    '',
    '`noodle connect claude-code` / `noodle connect codex` (add `--write` for project-local setup). For other editors (`cursor`, `vscode`, `gemini`), `noodle connect <client>` prints the setup steps, and `noodle docs export --format llms` produces portable context. With a deployed endpoint, `noodle connect <client> --endpoint <url>` prints the MCP client registration config.',
    '',
    '## ChatGPT (developer mode)',
    '',
    '1. Deploy: `noodle deploy`, then `noodle open --print` for the hosted MCP URL (ChatGPT needs a public HTTPS endpoint, not loopback).',
    '2. In ChatGPT: Settings → Connectors → enable Developer mode → add the endpoint (`noodle connect chatgpt` prints these steps).',
    '3. Toggle the connector on in a new conversation and sign in when prompted; testers outside your org need a wider access mode (`noodle access set`).',
    '4. Test on mobile too — invoke the same connector from the ChatGPT iOS/Android apps to check widget layout.',
    '',
    '## Claude',
    '',
    '`noodle connect claude` prints the flow: deploy, then add the hosted MCP URL as a custom connector in Claude settings and sign in when prompted. Widgets render in Apps-capable Claude surfaces; elsewhere the tool’s text/structured result is shown.',
    '',
    '## Public URL for a local server',
    '',
    'To try an undeployed server in a host that requires a public URL, `noodle dev --tunnel` publishes a temporary public URL for the loopback endpoint (requires the external `cloudflared` binary on PATH). Treat it as a short-lived test URL — deploy for anything shared.',
    '',
    '## What to verify',
    '',
    'Run a golden prompt set — direct (“use <tool> to…”), indirect (a natural request the model should route), and negative (requests that must not trigger the tool). Confirm the model picks the right tool with the right arguments, the widget renders and its actions work, external links open, and the experience degrades to readable text where Apps are unsupported. Symptoms → `references/troubleshooting.md`.',
  ].join('\n');
}

// ----------------------------------------------------------------------------
// references/troubleshooting.md (CURATED)
// ----------------------------------------------------------------------------

export function renderTroubleshootingReference(): string {
  const rows: ReadonlyArray<readonly [string, string, string]> = [
    [
      'Images, fonts, or styles don’t load inside the widget',
      'The host sandbox silently blocks origins not declared in the widget CSP',
      'Add every asset origin to `csp: { resourceDomains: [...] }` (fetch/XHR origins go in `connectDomains`, embedded iframes in `frameDomains`), then re-run `noodle check --target chatgpt`',
    ],
    [
      'ChatGPT warns “Widget CSP is not set”',
      'The widget declares no `csp`',
      'Declare `csp` on the widget with the exact origins it uses',
    ],
    [
      'ChatGPT warns “Widget domain is not set”',
      'No `domain` on the widget (required for app-store submission)',
      'Set `domain: "https://…"` (one https origin per app) on each widget',
    ],
    [
      'External links do nothing, or show a safe-link warning',
      'Link opened outside the host bridge, or the target origin is not allowlisted',
      'Use `useOpenExternal()` (never `window.open`) and add the target origins to the server-level `handoff.allowedDomains`',
    ],
    [
      'Tool succeeds but no widget appears',
      'The tool has no view, or the host surface doesn’t support MCP Apps',
      'Use `tool`, run `noodle check`, preview with `noodle devtools`; on non-Apps surfaces only the text/structured result renders',
    ],
    [
      'Widget shows stale or missing data',
      'The widget reads `structuredContent`, which must match the `output` schema',
      'Make `fulfil` return exactly the `output` shape (arrays and nested objects are supported); inspect the live result with `noodle devtools`',
    ],
    [
      '`useCallTool` fails from the widget',
      'Tool name mismatch, or the helper tool is model-visible',
      'List names with `noodle tools`; widget-only helpers must be declared with `tool`',
    ],
    [
      '`noodle validate` passes but React views fail to bundle (“requires Vite”)',
      'Vite is missing from the app dependencies or its dependencies are not installed — widget bundling uses the app-local Vite',
      'Run `npm install --save-dev vite`, then retry `noodle validate` / `noodle dev` / `noodle deploy`',
    ],
    [
      'Hosted endpoint returns 401 to probes',
      'Expected: hosted servers challenge unauthenticated calls with OAuth metadata',
      'Sign in from the host when prompted; widen who may call with `noodle access set` if testers are outside the org',
    ],
    [
      'Tools error only after deploy',
      'Runtime/config differences surface hosted (secrets, connector reachability)',
      'Run `noodle smoke`, then `noodle metrics --agent-output` and `noodle events --tool <name> --status tool_error --json`; check `noodle secrets list` scope',
    ],
    [
      'A connector tool validates and lists, but returns empty or `undefined` fields',
      'The `response` mapping references a path the API does not return — usually the wrong root (a `.body` segment, when the parsed body is bound directly to `${response}`) or the wrong shape',
      'Run `noodle tools call <name> --args <json>` with the secret set and compare the mapped result to the API’s real JSON; map from `${response.<path>}` (the body is `${response}`, there is no `.body`) and use bracket array indices (`${response.items[0].id}`)',
    ],
    [
      'A connector should return a list but returns one item, `undefined`, or the whole raw objects',
      'A `${response.arr[0]…}` mapping picks ONE element; a response mapping cannot reshape array items and a tool’s Zod output does not strip them at runtime',
      'Bind the whole array with `${response.<arr>}`, then narrow each element in a compute connector (`references/connect-an-api.md` → “Return a list”)',
    ],
    [
      '`noodle dev` boots but the loopback returns `-32600 "not found"` (or 404) for a valid server',
      'A required `secret(...)` is unresolved — a missing secret fails compile *closed* at boot so nothing is served; the local secret was set at a scope `noodle dev` does not read',
      'Run `noodle secrets set NAME --runtime local --from-env NAME`; local config and dev resolve the same effective target, and every author-loop command stops with the exact target/recovery command before exposing an empty endpoint (`references/connect-an-api.md` → “Set the secret for local runs”)',
    ],
    [
      'Need to invoke a tool from the terminal',
      'Local tools run in-process; the `noodle` CLI is not a general MCP client for **deployed** URLs (there is no `call <url>` verb)',
      'Locally, `noodle tools call <name> --args <json>` (also `noodle resources read` / `noodle prompts get`) runs the tool against the in-process runtime — with the secret set it executes the connector against the real API, so use it to prove mapped output. For a **deployed** URL use MCP Inspector or `npx @mcpjam/cli@latest tools call --url <url> ...`',
    ],
    [
      'One customer/session reports a bad answer or protocol error',
      'The failure may be a model/tool error, host protocol error, or connector/runtime error',
      'Run `noodle metrics --agent-output`, then `noodle events --tool <name> --status tool_error --json`; copy the `sessionId` into `noodle events --session <id> --json`, then match timestamps with `noodle logs`',
    ],
  ];
  return [
    '# Troubleshooting in hosts',
    '',
    '## Contents',
    '',
    '- First moves',
    '- Customer-auth metadata',
    '- Symptom map',
    '',
    '## First moves',
    '',
    'Re-run the local gates before debugging in-host: `noodle validate`, `noodle check` (add `--target chatgpt` for ChatGPT-specific requirements), and `noodle doctor`. Confirm the CLI is current with `noodle update --check` and that the project-local skill is intact with `noodle agents doctor --json` — host metadata requirements evolve and fixes ship in the CLI/agent-kit. Never paste tokens, secrets, or `.env` / `.env.noodle` values into prompts or logs while debugging.',
    '',
    'For protocol/conformance checks, the headless harness is `@mcpjam/cli`, not a `noodle` subcommand. Use it against a local `noodle dev` URL without an access token, or against hosted URLs through the host/OAuth flow printed by `noodle connect`.',
    '',
    '## Customer-auth metadata',
    '',
    'Adding `embeddedAssistant(...)` does not select the MCP access mode or authorization server. Before changing auth, inspect the exact active deployment with `noodle deployments list --org <org> --app <app> --env <env> --json` and match its active deployment ID, server version, and access mode to the endpoint being tested.',
    '',
    'For `customers` access, Direct or federated customer auth must advertise the configured tenant issuer; a managed Noodle bridge must advertise the Noodle authorization server. Owner-only access advertises the platform authorization server. If a direct or federated `customers` deployment still advertises the platform issuer, treat it as `customer_auth_state_inconsistent` and escalate with the endpoint, active deployment ID, and sanitized protected-resource metadata. Do not proxy, rewrite, rotate, or redeploy to hide the mismatch. Never share bearer tokens, refresh tokens, client secrets, or credential files.',
    '',
    '## Symptom map',
    '',
    mdTable(['Symptom', 'Likely cause', 'Fix'], rows),
  ].join('\n');
}

// ----------------------------------------------------------------------------
// references/inspect-hosted.md (CURATED)
// ----------------------------------------------------------------------------

export function renderInspectHostedReference(): string {
  return [
    '# Inspect hosted state',
    '',
    'Read hosted evidence without changing target, credentials, configuration, access, host wiring, revisions, or directory state.',
    '',
    '## Use when',
    '',
    '- The user asks for hosted status, deployment metadata, health, logs, events, metrics, audit evidence, or diagnosis.',
    '- The request is inspect-only, diagnose-only, or asks whether an existing deployment works.',
    '',
    '## Authority boundary',
    '',
    'This route is read-only. `deploy preflight` inspects authored deployment inputs with existing access; it is not `deploy` publication. This route never authorizes `login`, `logout`, `link`, `target set`, hosted secret/variable/config/access changes, publication, `rollback`, host configuration writes, or directory submission. If evidence shows one of those actions is needed, report the exact proposed action and target, then stop for a new explicit user request.',
    '',
    '## Workflow',
    '',
    '1. Resolve the requested org, app, environment, and deployment from existing non-secret context. Do not change the effective target to make inspection easier.',
    '2. Choose the narrowest read-only command: `noodle target show`, `noodle status`, `noodle inspect`, `noodle smoke`, `noodle metrics --agent-output`, `noodle events --json`, `noodle logs`, or `noodle audit`.',
    '3. Prefer machine output when the selected command supports it. Record the target, revision/deployment ID, timestamp, result, and any request ID without exposing secrets or customer payloads.',
    'For authored deployment readiness, select `deploy preflight` from the generated CLI command reference and supply the intended target. It does not configure, import dotenv, upload assets, save a retry key or publish. Routine login refresh may renew credentials. Missing-config actions are suggestions requiring separate authorization. A ready report is not backend, host or deployment evidence; publication always checks again.',
    '4. When the installed Developer MCP is available, call `get_context` to read the signed-in user’s current organizations and roles. Resolve the intended organization from the request or project context, then pass that explicit `org` to every scoped inspection or diagnosis tool. Never infer a remote default, and never ask the user to preselect organizations during OAuth. Treat the connection as live evidence gathering, not mutation authority.',
    '5. If a command fails, distinguish missing authentication/access from unhealthy application behavior. Do not repair, relink, redeploy, rotate config, or roll back under this route.',
    '',
    '## Stop conditions',
    '',
    '- Stop complete when the requested hosted fact is supported by current evidence and higher untested levels are named.',
    '- Stop blocked when existing access cannot read the target or the requested evidence requires a host/user journey unavailable in scope.',
    '- Stop for authorization when the next useful action would mutate local targeting, hosted state, host configuration, or directory state.',
  ].join('\n');
}

// ----------------------------------------------------------------------------
// references/deploy-and-ops.md (CURATED)
// ----------------------------------------------------------------------------

export function renderDeployAndOpsReference(): string {
  return [
    '# Hosted mutation authorization',
    '',
    '> This route changes hosted or external state. Use it only when the current user request explicitly authorizes the exact mutation and target.',
    '',
    '## Route boundary',
    '',
    '- Select this route only for the exact hosted mutation the user requested.',
    '- Route inspection, diagnosis, preparation, validation, testing, and other read-only work to their read-only references. Those requests do not authorize a mutation.',
    '- Authentication, target binding, configuration, access changes, deployment, connection writes, and rollback are separate mutations. Authorization for one does not imply another.',
    '',
    '## Authorization check',
    '',
    'Before any mutation, require the current request to name both the action and its complete target. A mutation-capable target consists of an explicit organization, application, and environment. When the environment is absent, stop and ask for it instead of applying a default, reusing local state, or selecting a target implicitly.',
    '',
    'Do not broaden a request to prepare, inspect, diagnose, or validate into permission to authenticate, bind a target, change configuration or access, deploy, connect, submit, or roll back.',
    '',
    '## Command and service contract',
    '',
    'Use `references/cli-commands.md` as the generated command, flag, and exit-code contract. Consult the live command catalog before acting, and treat the service response as the authority for resulting hosted state. For an authorized deployment, use the one canonical public flow and follow its structured configuration actions and resume command; do not replace it with an internal script or a hand-built sequence. This reference intentionally does not duplicate operational command sequences, defaults, or status semantics.',
    '',
    '## Evidence and stop conditions',
    '',
    '- Stop before execution when the action or complete target is missing.',
    '- After an authorized mutation, report only the state evidenced by the command and service response.',
    '- Do not claim host behavior, production health, or successful external registration without direct evidence at that layer.',
  ].join('\n');
}

// ----------------------------------------------------------------------------
// references/publishing.md (CURATED)
// ----------------------------------------------------------------------------

export function renderPublishingReference(): string {
  return [
    '# Publish to app directories',
    '',
    '> Preparation is read-only unless the current user request explicitly authorizes the exact deploy, access change, host write, or submission target. A request to prepare must report missing readiness work and stop before mutation.',
    '',
    'Directory requirements evolve. Identify the requested directory first and verify its current official requirements before preparing directory-specific evidence.',
    '',
    '## Contents',
    '',
    '- Shared readiness gate',
    '- Distribution metadata source',
    '- Hosted immutable distribution',
    '- Directory-specific evidence',
    '- Submission boundary',
    '',
    '## Shared readiness gate',
    '',
    'Before any submission:',
    '',
    `Use \`${APP_DIRECTORY_COMPLIANCE_REFERENCE}\` as this route’s canonical shared compliance checklist.`,
    '',
    'Prepare evidence for a reachable production MCP endpoint, accurate capability descriptions and schemas, useful fallback behavior, realistic positive and negative tests, data minimization, privacy disclosures, support ownership, and any interactive surface the directory will review.',
    '',
    '## Distribution metadata source',
    '',
    'When the user explicitly prepares host packaging, author the host-neutral `distribution` option in the same `server.ts`; do not add it during an ordinary build that has no distribution goal. It contains listing, publisher, support, legal, assets, and review facts that cannot be derived safely from MCP capability descriptions.',
    '',
    'Reference real packaged images with `asset(...)`, write useful alt text, and include realistic positive and negative review scenarios. Name the exact expected MCP tools in each positive scenario’s `tools` array. A negative scenario is a non-invocation case: set `shouldInvoke: false` and do not define `tools`. For each MCP App screenshot, add the separate user `prompt` that produces that exact state. Capture only the rendered MCP App response—never the enclosing website, Devtools shell, host conversation, or an unrelated product photo—and meet the selected directory’s current format, dimension, and count limits. Keep reviewer credentials, tokens, secrets, personal data, and test-account passwords out of metadata and source control; supply any authorized reviewer credential out of band.',
    '',
    '`distribution` is projected separately. It leaves the canonical App Package and Runtime Artifact unchanged, so editing listing copy cannot change deployment execution or product-skill identity. A product package still needs the separately judged `agentGuide`; do not duplicate capability schemas or workflow truth in listing metadata.',
    '',
    'The shared framework can validate metadata and resolved image bytes, run an available target adapter, and create a reproducible archive. Target-specific availability and exact flags live in `references/cli-commands.md` and the live command catalog (`noodle commands --json`); never invent an unlisted target, bundle, filename, or acceptance claim.',
    '',
    'When a directory has separate installable-plugin and remote-connector submission projections, generate each with its own exact live-catalog command. Never combine their archives or describe an operator dossier as directly portal-uploadable.',
    '',
    'Local or repository testing and public-directory submission are distinct packaging states with distinct required inputs. An export command only compiles local source and writes the requested archive. It does not deploy, register, upload, submit, review, or publish the package.',
    '',
    'When an export reports `uploadArtifacts`, treat its output archive as an outer review kit. Extract it, follow the generated instructions, and upload only the named inner artifacts to their matching fields. Never substitute the outer kit for a nested single-purpose upload.',
    '',
    '## Hosted immutable distribution',
    '',
    'Publishing a deployment-bound archive is a hosted mutation. Run it only when the current request explicitly authorizes that exact deployment and target: `noodle distributions publish <deployment-id> [server.ts] --target <target>`. The command compiles local TypeScript and requires its package snapshot to exactly match the selected deployment before it uploads anything. It uses the endpoint and package identity returned by the service; never substitute a local URL or a different deployment.',
    '',
    'Use `noodle distributions list <deployment-id>` to discover immutable versions, `noodle distributions inspect <distribution-id>` to inspect one, and `noodle distributions download <distribution-id> --output <archive.zip>` to retrieve its exact archive. Download verifies the service length and digest before an atomic local write; a failed verification must leave no output file.',
    '',
    'Lifecycle and delivery are separate mutations. Run `readiness`, `review`, `release`, `rollback`, `deprecate`, `revoke`, or `grant` only when the request explicitly authorizes that exact distribution and action. Inspect first when the active state or version is not already known.',
    '',
    'Set readiness from evidence you can verify. Record `review` only from a real human-observed host status; never infer submission, approval, or publication from a generated archive or a successful Noodle command, and never put reviewer credentials or secrets in feedback.',
    '',
    '`release --visibility private` creates or advances a stable Noodle channel without anonymous discovery; `release --visibility public` enables Noodle public delivery only. Both still require the underlying MCP deployment to use exact public access. Neither action publishes to an external directory.',
    '',
    '`grant` returns one short-lived, exact-version bearer URL. Treat the complete URL as a secret, disclose it only to the authorized reviewer, and do not paste it into source, logs, issues, or durable docs. `rollback` moves only the channel pointer to an older ready version; `deprecate` stops delivery and `revoke` is terminal.',
    '',
    'A hosted archive is still a submission candidate. Creating, listing, inspecting, downloading, releasing, or granting it does not submit it to an external directory, satisfy review, or publish a host listing.',
    '',
    '## Directory-specific evidence',
    '',
    'Read the selected directory’s current official submission documentation at review time. Record each additional requirement separately from the shared checklist, including listing fields, identity verification, test credentials, screenshots, policy declarations, review limits, and appeal or resubmission steps. Never project one directory’s requirements onto another.',
    '',
    'When a requirement cannot be verified from the selected directory’s current documentation or direct review evidence, mark it unknown instead of borrowing a rule from another host.',
    '',
    '## Submission boundary',
    '',
    'Preparation is read-only. Reverify current official requirements immediately before public submission. Deployment, access changes, directory registration, credential entry, final submission, and publication each remain separate human-operated mutations that require explicit authorization for the exact target. Report remaining evidence gaps and stop when that authority or required directory access is absent.',
  ].join('\n');
}

// ----------------------------------------------------------------------------
// references/app-directory-compliance.md (CURATED)
// ----------------------------------------------------------------------------

export function renderAppDirectoryComplianceReference(): string {
  return [
    '# App directory compliance (pre-submission)',
    '',
    'Use this shared checklist against the built integration before preparing a directory submission. It',
    'covers evidence common to app and connector directories without assuming a particular host, review',
    'portal, client framework, or vendor policy.',
    '',
    '## Contents',
    '',
    '- Validation evidence',
    '- Capability and interaction quality',
    '- Safety, privacy, and data handling',
    '- Reliability and accessibility',
    '- Directory-specific delta',
    '',
    '## Validation evidence',
    '',
    'A clean local validation result proves only the checks that actually ran. Record server validation,',
    'behavior tests, protocol conformance, production reachability, and interactive rendering as separate',
    'evidence levels. Never treat metadata readiness as proof of host rendering or directory acceptance.',
    '',
    '## Capability and interaction quality',
    '',
    '1. **User value** — each exposed capability solves a concrete user job and cites built behavior rather',
    '   than an aspiration.',
    '2. **Grounded capability** — knowledge, actions, and presentation come from authoritative application',
    '   data or bounded operations instead of invented state.',
    '3. **Atomic interfaces** — every action has a focused purpose, explicit input and output schemas, honest',
    '   effect annotations, and useful failure output.',
    '4. **Helpful UI only** — every interactive surface earns its place and preserves a useful text or',
    '   structured fallback when rendering is unavailable.',
    '5. **Meaningful completion** — the user can complete the promised task within the declared boundary,',
    '   with any external handoff clearly identified.',
    '',
    '## Safety, privacy, and data handling',
    '',
    '- Minimize model-visible and UI-visible data; remove secrets, internal identifiers, unnecessary personal',
    '  data, and continuation credentials from results and logs.',
    '- Document authentication, authorization scopes, retention, deletion, subprocessors, and external',
    '  handoffs accurately in the public privacy and support material.',
    '- Make mutations explicit, bounded, and confirmation-aware. Never imply that a read or preparation',
    '  request authorizes a write.',
    '- For regulated or consequential workflows, show source provenance, uncertainty, cautions, and the',
    '  boundary between information and a professional decision.',
    '',
    '## Reliability and accessibility',
    '',
    '- Exercise representative positive, negative, empty, loading, error, and recovery cases against the',
    '  production-shaped endpoint.',
    '- Preserve keyboard access, readable contrast, responsive layout, concise status feedback, and graceful',
    '  degradation when an interactive surface is unsupported.',
    '- State latency, availability, rate-limit, and support expectations using observed evidence rather than',
    '  unverified claims.',
    '',
    '## Directory-specific delta',
    '',
    'After the shared checklist passes, read the selected directory’s current official documentation and add',
    'only its verified requirements. Keep directory-specific metadata, screenshots, test accounts, policy',
    'statements, and review procedures in that submission evidence—not in this shared skill reference. Mark',
    'unknown or untested requirements explicitly, and never reuse another directory’s checklist as a proxy.',
  ].join('\n');
}
