import { describe, expect, it } from 'vitest';
import { BUNDLED_EXAMPLE_FILES, BUNDLED_EXAMPLE_NAMES } from '../src/generated/example-files.js';
import {
  CLI_COMMANDS,
  COMPILE_ERROR_CODES,
  REACT_HOOKS,
  SDK_EXPORTS,
} from '../src/generated/surface.js';
import {
  AGENT_KIT_VERSION,
  BEHAVIOR_SKILLS,
  contentHash,
  contentSha256,
  EXECUTING_NOODLE_PLANS_SKILL,
  EXPECTED_BEHAVIOR_SKILL_NAMES,
  MANAGED_BEGIN,
  MANAGED_END,
  reconcileManagedBlock,
  renderAgentFiles,
  renderAgentKitManifest,
  renderManagedBlock,
  renderPublishableSkills,
  skillFileMappings,
} from '../src/index.js';
import { INSTALLED_SKILL_ROOT_BY_TARGET } from '../src/skill-registry.js';

const SKILL_BASE = {
  codex: `${INSTALLED_SKILL_ROOT_BY_TARGET.codex}/noodle-seed`,
  'claude-code': `${INSTALLED_SKILL_ROOT_BY_TARGET['claude-code']}/noodle-seed`,
} as const;

const REFERENCE_NAMES = [
  'product-agent-guides',
  'sdk-surface',
  'cli-commands',
  'agent-contract',
  'compile-errors',
  'build-an-mcp-server',
  'authoring-workflow',
  'tool-design',
  'embedded-assistant',
  'connect-an-api',
  'wrap-existing-app',
  'build-an-mcp-app',
  'experience-design',
  'widgets-and-apps',
  'test-in-hosts',
  'verify-and-recover',
  'troubleshooting',
  'inspect-hosted',
  'deploy-and-ops',
  'publishing',
  'app-directory-compliance',
  'examples',
  'feedback',
] as const;

function expectedTreeFor(base: string): string[] {
  return [`${base}/SKILL.md`, ...REFERENCE_NAMES.map((n) => `${base}/references/${n}.md`)];
}

function skillBody(content: string): string {
  const lines = content.split('\n');
  const close = lines.indexOf('---', 1);
  return lines.slice(close + 1).join('\n');
}

describe('agent kit hierarchical rendering', () => {
  it('renders the managed block, the skill tree, and bundled examples for both targets', () => {
    const files = renderAgentFiles({
      project: { name: 'demo', entrypoint: 'server.ts', env: 'dev', accessMode: 'owner-only' },
    });
    const paths = files.map((file) => file.path);

    // Managed host file leads each target, followed by its SKILL.md + references, then examples.
    expect(paths[0]).toBe('AGENTS.md');
    expect(paths).toContain('CLAUDE.md');
    for (const base of [SKILL_BASE.codex, SKILL_BASE['claude-code']]) {
      for (const treePath of expectedTreeFor(base)) expect(paths).toContain(treePath);
      for (const example of BUNDLED_EXAMPLE_FILES) {
        expect(paths).toContain(`${base}/${example.relPath}`);
      }
    }
    expect(files.every((file) => file.content.trim().length > 0)).toBe(true);
  });

  it('routes platform component defaults from both App playbooks to the canonical reference', () => {
    const appPlaybooks = renderAgentFiles({}).filter(
      (file) =>
        file.skill === 'noodle-seed' && file.path.endsWith('/references/build-an-mcp-app.md'),
    );
    expect(appPlaybooks).toHaveLength(2);
    for (const file of appPlaybooks) {
      expect(file.content).toContain('references/widgets-and-apps.md');
      expect(file.content).not.toMatch(
        /Noodle Design|@noodleseed\/one\/react|semantic tokens|third-party components/i,
      );
    }
  });

  it('keeps skill files to SKILL.md, one-level references, or examples/<name>/** paths', () => {
    for (const mapping of skillFileMappings()) {
      const skillBase =
        mapping.skill === 'noodle-seed'
          ? SKILL_BASE[mapping.agentTarget]
          : `${SKILL_BASE[mapping.agentTarget].replace(/\/noodle-seed$/, '')}/${mapping.skill}`;
      const rel = mapping.installedPath.replace(`${skillBase}/`, '');
      expect(rel).toMatch(/^(SKILL\.md|references\/[a-z-]+\.md|examples\/[a-z0-9-]+\/.+)$/);
    }
  });

  it('keeps each SKILL.md router body under 500 lines', () => {
    for (const file of renderAgentFiles({})) {
      if (!file.path.endsWith('/SKILL.md')) continue;
      expect(skillBody(file.content).split('\n').length).toBeLessThan(500);
    }
  });

  it('opens any reference longer than 100 lines with a Contents table', () => {
    for (const file of renderAgentFiles({})) {
      if (!file.path.includes('/references/')) continue;
      const lines = file.content.split('\n');
      if (lines.length > 100) expect(file.content).toContain('## Contents');
    }
  });

  it('renders the public developer CLI and routes exhaustive discovery to commands --json', () => {
    const ref = renderAgentFiles({}).find((f) =>
      f.path.endsWith('/references/cli-commands.md'),
    )?.content;
    expect(ref).toBeDefined();
    for (const cmd of CLI_COMMANDS) {
      if (['billing', 'keys', 'list', 'platform-auth'].includes(cmd)) {
        expect(ref).not.toContain(`noodle ${cmd}`);
      } else {
        expect(ref).toContain(`noodle ${cmd}`);
      }
    }
    expect(ref).not.toContain('## Deprecated');
    expect(ref).toContain('noodle commands --json');
  });

  it('keeps private operations and obsolete implementation history out of public skill prose', () => {
    const prose = renderAgentFiles({})
      .filter((file) => file.path.endsWith('/SKILL.md') || file.path.includes('/references/'))
      .map((file) => file.content)
      .join('\n');
    expect(prose).not.toMatch(/billing migration|platform-auth|super-admin|WorkOS/i);
    expect(prose).not.toMatch(/Core[- ]?v[12]|before the 2026-|Deprecated/i);
  });

  it('requires informed user consent before product feedback crosses the project boundary', () => {
    const files = renderAgentFiles({});
    const router = files.find((file) => file.path.endsWith('/SKILL.md'))?.content ?? '';
    const feedback =
      files.find((file) => file.path.endsWith('/references/feedback.md'))?.content ?? '';
    for (const text of [router, feedback]) {
      expect(text).toMatch(/explicit (?:user )?approval/i);
      expect(text).toMatch(
        /show (?:the user )?(?:the )?(?:normalized submission|exact .*proposal)/i,
      );
      expect(text).toMatch(/do not (?:run|submit|send).*until/i);
      expect(text).not.toMatch(/without asking the user|skip silently|submitting is expected/i);
    }
    expect(feedback).toContain('noodle feedback --help');
    expect(feedback).toContain('noodle commands --json');
    expect(feedback).toContain('--dry-run --json');
    expect(feedback).toContain('Noodle Seed private feedback tracker');
    expect(feedback).toContain('"willSubmit":false');
    expect(feedback).toMatch(/structured arguments/i);
    expect(feedback).toMatch(/never a shell wrapper/i);
    expect(feedback).toContain('--agent');
    expect(feedback).toContain('--model');
    expect(feedback).toMatch(/known coding-agent identity/i);
    expect(feedback).toMatch(/client-reported/i);
    expect(feedback).toMatch(/exact (?:previewed )?(?:proposal|submission|payload)/i);
    expect(feedback).toMatch(/submit.*once/i);
    expect(feedback).toMatch(/never (?:auto-)?login/i);
    expect(feedback).toMatch(/never .*retry-loop/i);
    expect(feedback).toMatch(/feedback_recording_failed.*outcome may be unknown/i);
    expect(feedback).toMatch(/no reference was returned/i);
  });

  it('ships the same feedback preview and approval workflow to both project targets and publication', () => {
    const installed = renderAgentFiles({})
      .filter((file) => file.path.endsWith('/references/feedback.md'))
      .map((file) => skillBody(file.content));
    expect(installed).toHaveLength(4);
    expect(new Set(installed).size).toBe(1);

    const published = renderPublishableSkills()
      .filter((file) => file.path.endsWith('/references/feedback.md'))
      .map((file) => skillBody(file.content));
    expect(published).toHaveLength(4);
    expect(new Set(published).size).toBe(1);
    expect(published[0]).toBe(installed[0]);
  });

  it('renders every generated SDK export in the sdk-surface reference', () => {
    const ref = renderAgentFiles({}).find((f) =>
      f.path.endsWith('/references/sdk-surface.md'),
    )?.content;
    expect(ref).toBeDefined();
    for (const name of SDK_EXPORTS) expect(ref).toContain(`\`${name}`);
  });

  it('teaches worked resource/prompt/tool recipes in the sdk-surface reference', () => {
    const ref = renderAgentFiles({}).find((f) =>
      f.path.endsWith('/references/sdk-surface.md'),
    )?.content;
    expect(ref).toBeDefined();
    // Resource recipe: a builder call with a fulfil, both a fixed URI and a {var} template.
    expect(ref).toMatch(/resource\('/);
    expect(ref).toContain('fulfil');
    expect(ref).toContain("uri: 'tickets://{id}'");
    // The recipe teaches the bare return shape (a content entry), and its prose warns against the
    // `{ contents: [...] }` double-wrap wrapper rather than teaching it.
    expect(ref).toContain(
      "fulfil: () => ({ uri: 'docs://changelog', mimeType: 'text/markdown', text:",
    );
    expect(ref).toContain('Do **not** return a `{ contents: [...] }` wrapper');
    // Prompt recipe: real arguments + the returned messages shape.
    expect(ref).toMatch(/prompt\('/);
    expect(ref).toContain('arguments: z.object(');
    expect(ref).toContain('messages');
    // Non-trivial tool: async fulfil, the ctx connector call, annotations, and visibility.
    expect(ref).toContain('async ({ input })');
    expect(ref).toContain('connectors.crm.get_ticket');
    expect(ref).toContain('annotations.readOnly()');
    expect(ref).toContain('annotations.action()');
    expect(ref).toContain('visibility');
    expect(ref).toContain('modelVisibility');
    expect(ref).toContain("latestMessageIncludesAny: ['show ticket', 'open ticket']");
    expect(ref).toContain('oncePerSession');
    expect(ref).toContain('requiredWhenVisible');
  });

  it('teaches concrete SDK signatures and authoring patterns', () => {
    const ref = renderAgentFiles({}).find((f) =>
      f.path.endsWith('/references/sdk-surface.md'),
    )?.content;
    expect(ref).toBeDefined();
    expect(ref).toContain('customerAuth');
    expect(ref).toContain('@noodleseed/one/platform');
    expect(ref).toContain('server(name, options, definitions)');
    expect(ref).toContain('fulfil({ input, connectors, user })');
    expect(ref).toContain('branding');
    expect(ref).toContain('state');
    expect(ref).toContain('handoff');
    expect(ref).toContain('Dynamic Client Registration');
    expect(ref).toContain('code_challenge_methods_supported');
    expect(ref).toContain('token_endpoint_auth_methods_supported');
    expect(ref).toContain('noodle auth doctor src/server.ts');
    expect(ref).not.toContain('.bridge(...)');
    expect(ref).toContain('view: { component, entry }');
    expect(ref).toContain('visibility: ["app"]');
    expect(ref).toContain('modelVisibility.latestMessageIncludesAny');
    expect(ref).toContain('modelVisibility');
    expect(ref).toContain('oncePerSession');
    expect(ref).toContain('requiredWhenVisible');

    const rendered = renderAgentFiles({})
      .map((file) => file.content)
      .join('\n');
    expect(rendered).not.toContain('toolForWidget');
    expect(rendered).not.toContain('toolWithWidget');
  });

  it('renders every generated compile-error code in the compile-errors reference', () => {
    const ref = renderAgentFiles({}).find((f) =>
      f.path.endsWith('/references/compile-errors.md'),
    )?.content;
    expect(ref).toBeDefined();
    for (const code of COMPILE_ERROR_CODES) expect(ref).toContain(`\`${code}\``);
  });

  it('documents the real validate failure envelope and fix-prompt in compile-errors', () => {
    const ref = renderAgentFiles({}).find((f) =>
      f.path.endsWith('/references/compile-errors.md'),
    )?.content;
    expect(ref).toBeDefined();
    // The documented shape matches the actual CLI envelope: per-field detail under error.errors[].
    expect(ref).toContain('error.errors');
    expect(ref).toContain('path');
    expect(ref).toContain('didYouMean');
    expect(ref).toContain('docAnchor');
    expect(ref).toContain('--fix-prompt');
  });

  it('renders every generated React hook in the widgets-and-apps reference', () => {
    const ref = renderAgentFiles({}).find((f) =>
      f.path.endsWith('/references/widgets-and-apps.md'),
    )?.content;
    expect(ref).toBeDefined();
    expect(REACT_HOOKS.length).toBeGreaterThanOrEqual(6);
    for (const hook of REACT_HOOKS) expect(ref).toContain(`\`${hook}`);
  });

  it('keeps every rendered markdown table rectangular (cell pipes escaped)', () => {
    for (const file of renderAgentFiles({})) {
      if (!file.path.includes('/references/')) continue;
      let expected: number | undefined;
      for (const line of file.content.split('\n')) {
        if (!line.startsWith('| ')) {
          expected = undefined;
          continue;
        }
        // Split on unescaped pipes only; a raw `|` inside a cell breaks the column grid.
        const cells = line.split(/(?<!\\)\|/).length;
        expected ??= cells;
        expect(cells, `${file.path}: ${line}`).toBe(expected);
      }
    }
  });

  it('routes to every reference file from the SKILL.md router', () => {
    for (const file of renderAgentFiles({})) {
      if (file.skill !== 'noodle-seed' || !file.path.endsWith('/SKILL.md')) continue;
      for (const name of REFERENCE_NAMES) {
        expect(file.content).toContain(`references/${name}.md`);
      }
    }
  });

  it('teaches real-host connection flows in the test-in-hosts reference', () => {
    const ref = renderAgentFiles({}).find((f) =>
      f.path.endsWith('/references/test-in-hosts.md'),
    )?.content;
    expect(ref).toBeDefined();
    expect(ref).toContain('noodle connect');
    expect(ref).toMatch(/developer mode/i);
    expect(ref).toMatch(/chatgpt/i);
    expect(ref).toMatch(/inspector/i);
    expect(ref).toContain('--tunnel');
  });

  it('maps runtime symptoms to fixes in the troubleshooting reference', () => {
    const ref = renderAgentFiles({}).find((f) =>
      f.path.endsWith('/references/troubleshooting.md'),
    )?.content;
    expect(ref).toBeDefined();
    expect(ref).toContain('resourceDomains');
    expect(ref).toContain('handoff.allowedDomains');
    expect(ref).toContain('noodle check --target chatgpt');
    expect(ref).toMatch(/images/i);
    expect(ref).toMatch(/safe.?link|external link/i);
  });

  it('teaches host-neutral directory submission in the publishing reference', () => {
    const ref = renderAgentFiles({}).find((f) =>
      f.path.endsWith('/references/publishing.md'),
    )?.content;
    expect(ref).toBeDefined();
    expect(ref).toContain('references/app-directory-compliance.md');
    expect(ref).toMatch(/current official requirements/i);
    expect(ref).toMatch(/privacy disclosures/i);
    expect(ref).toMatch(/positive and negative tests/i);
    expect(ref).toMatch(/explicit authorization/i);
  });

  it('does not teach unsafe or internal authoring surfaces in the skill prose', () => {
    const files = renderAgentFiles({});
    // Prose-policy checks target what the skill TEACHES (SKILL.md + references), not bundled example
    // code/docs: real apps legitimately contain tokens like `task-list` (matches a loose `sk-`) and
    // negative "does not use caller-key mechanisms" security disclaimers. Real-secret and
    // client/competitor scans below still cover the whole tree, examples included.
    const skillProse = files
      .filter((file) => file.path.endsWith('/SKILL.md') || file.path.includes('/references/'))
      .map((file) => file.content)
      .join('\n');
    const allText = files.map((file) => file.content).join('\n');

    expect(skillProse).not.toMatch(/caller key|caller-key/i);
    expect(skillProse).not.toMatch(
      /create a manifest|write a runtime artifact|author connector IR/i,
    );
    // Real secret values must not appear anywhere, including bundled examples (anchored to actual
    // key shapes so app words like `task-list` do not false-positive).
    expect(allText).not.toMatch(/NOODLE_AUTH_TOKEN|oauthRefreshToken|\brefreshToken\b/);
    expect(allText).not.toMatch(/\bnbk_[A-Za-z0-9]/);
    expect(allText).not.toMatch(/\bsk-[a-z0-9]{16,}\b/i);
    expect(allText).toContain('Do not hand-author manifest JSON/YAML');
    expect(allText).toContain('hosted asset metadata');
  });

  it('teaches input paths and the repair loop in the authoring-workflow reference', () => {
    const ref = renderAgentFiles({}).find((f) =>
      f.path.endsWith('/references/authoring-workflow.md'),
    )?.content;
    expect(ref).toBeDefined();
    expect(ref).toMatch(/website.*scrape|scrape.*website/i);
    expect(ref).toMatch(/openapi/i);
    expect(ref).toMatch(/interview/i);
    expect(ref).toMatch(/re-validate|repair/i);
    // Connectors recipe: a real, compile-verified HTTP connector with auth, response mapping,
    // a `use` binding, and openapi generation — not just the philosophy.
    expect(ref).toContain('.http({');
    expect(ref).toContain('operations:');
    expect(ref).toContain("secret('CRM_TOKEN')");
    expect(ref).toMatch(/\$\{response|\$\{args/);
    // The corrected mapping shapes: operation-level query array + bracket array index.
    expect(ref).toContain("query: ['email']");
    expect(ref).toContain('${response.data[0].id}');
    expect(ref).toContain('use: { crm }');
    expect(ref).toContain('import openapi');
    expect(ref).toContain('## Per-tool authorization');
    expect(ref).toContain("requiredScopes: ['org_apps:read']");
    expect(ref).toContain("allowedRoles: ['org_admin', 'org_member']");
    expect(ref).toContain('explicitly configured claim path');
  });

  it('teaches product-workflow tool altitude and name-over-id resolvers', () => {
    const ref = renderAgentFiles({}).find((f) =>
      f.path.endsWith('/references/authoring-workflow.md'),
    )?.content;
    expect(ref).toBeDefined();
    // Tool altitude has its own route now; the workflow keeps a pointer, not a copy.
    const toolDesign = renderAgentFiles({}).find((f) =>
      f.path.endsWith('/references/tool-design.md'),
    )?.content;
    expect(ref).toContain('Design tools for the model');
    expect(ref).toContain('`references/tool-design.md`');
    expect(toolDesign).toMatch(/1:1|one-to-one|per-endpoint|wrapper/i);
    // Name-over-id: pair an id-taking action with a find/search resolver, gate-verified.
    expect(toolDesign).toContain('find_tasks');
    expect(toolDesign).toMatch(/\bids?\b/i);
    expect(ref).toContain('ctx.elicit');
    expect(ref).toContain("id: 'choose_team'");
    expect(ref).toContain('invalid_elicitation_schema');
    expect(ref).toContain('invalid_elicitation_flow');
    expect(ref).toContain('invalid_confirmation_flow');
    expect(ref).toContain('annotations.action({ confirm: false })');
    expect(ref).toContain('elicitation/create');
    expect(ref).toContain('contextProvider: true');
    expect(ref).toContain('does not create a hidden context tool');
    expect(ref).toContain('context.location.latitude');
    expect(ref).toContain('context.location.longitude');
    expect(ref).toMatch(/optional.*untrusted.*client hint/i);
    expect(ref).toMatch(/explicit tool input.*override/i);
  });

  it('teaches the complete external embedded-assistant integration workflow', () => {
    const router = renderAgentFiles({}).find((file) => file.path.endsWith('/SKILL.md'))?.content;
    const ref = renderAgentFiles({}).find((file) =>
      file.path.endsWith('/references/embedded-assistant.md'),
    )?.content;
    expect(router).toContain('references/embedded-assistant.md');
    expect(ref).toContain('@noodleseed/assistant/client');
    expect(ref).toContain('@noodleseed/assistant/app-view');
    expect(ref).toContain('@noodleseed/assistant/react/client');
    expect(ref).toContain('NoodleAppView');
    expect(ref).toContain('<noodle-app-view>');
    expect(ref).toContain('useNoodleAssistant');
    expect(ref).toContain(
      'const { client, messages, suggestions, status, error } = useNoodleAssistant',
    );
    expect(ref).toContain('principalKey');
    expect(ref).toContain('client.sendMessage');
    expect(ref).toContain('client.respond');
    expect(ref).toContain('client.abort');
    expect(ref).toContain('complete schema-aware review');
    expect(ref).toContain('action: "decline"');
    expect(ref).toContain('has not implemented the requested schema form');
    expect(ref).toContain('Never inject `part.data.html`');
    expect(ref).toContain('assign it to `srcdoc`');
    expect(ref).toContain('fetch a `ui://` URI');
    expect(ref).toContain('subscribeChat');
    expect(ref).toContain('UIMessage');
    expect(ref).toContain('`data-confirmation`');
    expect(ref).not.toContain('@ai-sdk/react');
    expect(ref).toContain('action: "decline"');
    expect(ref).toContain('action: "cancel"');
    expect(ref).toContain('preferences:');
    expect(ref).toContain('clientContext:');
    expect(ref).toContain('updateModelContext({');
    expect(ref).toContain('`user.locale` and `user.timeZone`');
    expect(ref).toContain('contextProvider: true');
    expect(ref).toContain('Keep ambient facts compact');
    expect(ref).toContain('input_requested');
    expect(ref).toContain('Never call `respond` while scanning a transcript snapshot');
    expect(ref).toContain('Elicitation gathers an input');
    expect(ref).toContain('every eligible `input_requested` precedes `tool_proposed`');
    expect(ref).toContain('linked MCP App presents the same normal-user form');
    expect(ref).toContain("part.type === 'data-view'");
    expect(ref).toContain('appViewFor(part.data).view = part.data');
    expect(ref).toContain('requests standard App teardown');
    expect(ref).toContain('semantic view identity');
    expect(ref).toContain('client + `view.id` + `view.resourceUri`');
    expect(ref).toContain('tool_started');
    expect(ref).toContain('application-owned slot');
    expect(ref).toContain('viewSlots.get(event.data.resourceUri)');
    expect(ref).toContain('prefers-reduced-motion');
    expect(ref).toContain('Do not send a first turn on mount by default');
    expect(ref).toContain('role="status"');
    expect(ref).toContain('operating-system preference');
    expect(ref).toContain('resolved application theme');
    expect(ref).toContain('theme={resolvedTheme}');
    expect(ref).toContain('CSS custom properties inherit through the assistant host');
    expect(ref).toContain('an advertised reserved retry field');
    expect(ref).toContain('sole exact connector version/operation/resolved arguments');
    expect(ref).toContain('candidate actions and later reads');
    expect(ref).toContain('invalid_confirmation_flow');
    expect(ref).toContain('truncating or omitting any non-sensitive action field fails closed');
    expect(ref).toContain('only after every elicited field is collected');
    expect(ref).toContain('annotations.action({ confirm: false })');
    expect(ref).toContain('omitted or `false` preserves direct execution');
    expect(ref).toContain('every call replaces the prior snapshot');
    expect(ref).toContain('interaction_outcome_unknown');
    expect(ref).toContain('never auto-retries interaction decisions');
    expect(ref).toContain('durable stored outcome without re-execution');
    expect(ref).toBeDefined();
    expect(ref).toContain('http://localhost');
    expect(ref).toContain('server_auth_required');
    expect(ref).toContain('Troubleshooting: symptom to diagnosis');
    expect(ref).toContain('invalid_response');
    expect(ref).toContain('ASSISTANT_MODEL_API_KEY');
    expect(ref).toContain('NOODLE_ASSISTANT_CLIENT_SECRET');
    expect(ref).toContain('scopes: user.scopes');
    expect(ref).toMatch(
      /delegated connector returns[\s\S]*noodle assistant doctor --user-id <real-test-user>/i,
    );
    expect(ref).toContain('noodle assistant embed --check --json');
    expect(ref).toContain('--require-env');
    expect(ref).toMatch(
      /recommend the managed renderer.*concrete UI or integration benefit.*headless/is,
    );
    expect(ref).toMatch(/exactly one recommended topology.*do not return an unranked menu/is);
    expect(ref).toContain('generated environment bindings');
    expect(ref).toContain('production-equivalent host build');
    expect(ref).toContain('secret allowlist');
    expect(ref).toContain('synthetic');
    expect(ref).toMatch(/external model/i);
    expect(ref).toContain('HEAD');
    expect(ref).toContain('listen EPERM');
    expect(ref).toContain('session 503');
    expect(ref).toContain('keyboard');
    expect(ref).toMatch(/deploy[\s\S]*assistant clients create/i);
    expect(ref).toContain('@noodleseed/assistant/server');
    expect(ref).toContain('@noodleseed/assistant/react');
    expect(ref).toContain('noodle commands --json');
    expect(ref).not.toMatch(/dev --tunnel[\s\S]*SaaS|SaaS[\s\S]*dev --tunnel/i);

    const customerAuthReadme = BUNDLED_EXAMPLE_FILES.find(
      (file) => file.relPath === 'examples/customer-auth/README.md',
    )?.content;
    expect(customerAuthReadme).toContain('@noodleseed/assistant/react/client');
    expect(customerAuthReadme).toContain('@noodleseed/assistant/app-view');
    expect(customerAuthReadme).toContain('NoodleAppView');
    expect(customerAuthReadme).toContain('<noodle-app-view>');
    expect(customerAuthReadme).toContain('appViewFor(part.data).view = part.data');
    expect(customerAuthReadme).toContain('useNoodleAssistant');
    expect(customerAuthReadme).toContain('suggestions');
    expect(customerAuthReadme).toContain('data-sign-in');
    expect(customerAuthReadme).toContain('complete schema-aware review');
    expect(customerAuthReadme).toContain("action: 'decline'");
    expect(customerAuthReadme).toContain('Never inject `part.data.html`');
    expect(customerAuthReadme).toContain('noodle assistant doctor --user-id <real-test-user>');
    expect(customerAuthReadme).toContain('noodle assistant embed --check --json');
    expect(customerAuthReadme).toContain('production-equivalent host build');
    expect(customerAuthReadme).toContain('synthetic');
  });

  it('routes hosted command semantics to the generated CLI contract', () => {
    const authoring = renderAgentFiles({}).find((f) =>
      f.path.endsWith('/references/authoring-workflow.md'),
    )?.content;
    const deploy = renderAgentFiles({}).find((f) =>
      f.path.endsWith('/references/deploy-and-ops.md'),
    )?.content;
    const cliCommands = renderAgentFiles({}).find((f) =>
      f.path.endsWith('/references/cli-commands.md'),
    )?.content;
    const troubleshooting = renderAgentFiles({}).find((f) =>
      f.path.endsWith('/references/troubleshooting.md'),
    )?.content;
    expect(authoring).toBeDefined();
    expect(deploy).toBeDefined();
    expect(cliCommands).toBeDefined();
    expect(troubleshooting).toBeDefined();
    expect(authoring).toContain("method: 'GET'");
    expect(authoring).toContain('request:');
    expect(authoring).toContain('response:');
    expect(authoring).toContain('${args.');
    expect(authoring).toContain('${response.');
    expect(authoring).toContain('clientCredentials');
    expect(authoring).toContain('googleWorkloadIdentity');
    expect(authoring).toContain('delegatedOAuth');
    expect(authoring).toContain('delegatedSessionCookie');
    expect(authoring).toContain('callOperation');
    expect(authoring).toContain('when(');
    expect(authoring).toContain('vitest');
    expect(authoring).toContain('noodle test --json');
    expect(deploy).toContain('references/cli-commands.md');
    expect(deploy).toMatch(/exact mutation and target/i);
    expect(deploy).not.toMatch(/noodle (?:secrets|variables|deploy|agents)\b/i);
    expect(cliCommands).toContain('noodle secrets');
    expect(cliCommands).toContain('noodle variables');
    expect(cliCommands).toContain('noodle deploy');
    expect(cliCommands).toContain('noodle agents');
    expect(cliCommands).toContain('auth google');
    expect(troubleshooting).toContain('not a general MCP client');
    expect(troubleshooting).toContain('@mcpjam/cli');
    expect(troubleshooting).toContain('noodle events --session');
    expect(troubleshooting).toContain('noodle logs');
    expect(troubleshooting).toContain('npm install --save-dev vite');
  });

  it('keeps project test discovery separate from bundled example references', () => {
    const authoring = renderAgentFiles({}).find((file) =>
      file.path.endsWith('/references/authoring-workflow.md'),
    )?.content;
    expect(authoring).toMatch(/project-owned `test\/` directory/i);
    expect(authoring).toMatch(/skill-local example tests are reference material/i);

    const helloPackage = BUNDLED_EXAMPLE_FILES.find(
      (file) => file.relPath === 'examples/hello/package.json',
    )?.content;
    expect(JSON.parse(helloPackage ?? '{}').scripts.test).toBe('vitest run --dir test');
  });

  it('routes connection writes to the generated CLI contract', () => {
    const deploy = renderAgentFiles({}).find((f) =>
      f.path.endsWith('/references/deploy-and-ops.md'),
    )?.content;
    const cliCommands = renderAgentFiles({}).find((f) =>
      f.path.endsWith('/references/cli-commands.md'),
    )?.content;
    expect(deploy).toBeDefined();
    expect(cliCommands).toBeDefined();
    expect(deploy).toContain('references/cli-commands.md');
    expect(deploy).not.toContain('noodle connect');
    expect(deploy).not.toContain('mcpServers');
    expect(cliCommands).toContain('noodle connect');
  });

  it('teaches a compile-verified widget recipe and ChatGPT App equivalence in widgets-and-apps', () => {
    const ref = renderAgentFiles({}).find((f) =>
      f.path.endsWith('/references/widgets-and-apps.md'),
    )?.content;
    expect(ref).toBeDefined();
    // (1) A real React `view` component authored with generateHelpers + the typed host hooks.
    expect(ref).toContain('generateHelpers<ServerDefinition>()');
    expect(ref).toMatch(/useCallTool\(|useViewState\(/);
    expect(ref).toContain('useOpenExternal');
    expect(ref).toContain('data-llm'); // model-facing context annotation
    expect(ref).toContain('useUpdateModelContext');
    expect(ref).toContain('useWidgetLifecycle');
    expect(ref).toContain('supports?.modelContext');
    expect(ref).toContain('automatically publishes `mounted`');
    expect(ref).toContain('replaces the prior snapshot rather than merging fields');
    expect(ref).toMatch(/empty (?:result )?envelope.*pending/is);
    expect(ref).toContain('isError');
    expect(ref).toMatch(/validate every required field and identifier/is);
    expect(ref).toMatch(/dependent actions.*only after validation succeeds/is);
    expect(ref).not.toContain("publishLifecycle('mounted'");
    // (2) The tool declaration wiring the view, csp, domain, and output.
    expect(ref).toContain('tool(');
    expect(ref).toContain('view: {');
    expect(ref).toContain('domain:');
    // (3) A ChatGPT App is the same widget + a domain, verified by noodle check --target chatgpt.
    expect(ref).toMatch(/ChatGPT App[\s\S]*this widget \+ a domain/i);
    expect(ref).toContain('handoff.allowedDomains');
    expect(ref).toContain('redirect_domains');
    expect(ref).toContain('noodle check --target chatgpt');
    expect(ref).toContain('npm install --save-dev vite');
    // (4) Tool annotations are modeled (a submission requirement) and the claim is honest.
    expect(ref).toContain('annotations.readOnly()');
    expect(ref).toContain('annotations.action({ confirm: false })');
    expect(ref).toMatch(/metadata-ready/i);
    // (5) The ChatGPT knowledge-app search/fetch shape is taught with the exact signatures.
    expect(ref).toContain("tool('search'");
    expect(ref).toContain("tool('fetch'");
    expect(ref).toContain('results:');
  });

  it('makes Noodle Design the default in the installed widgets-and-apps skill reference', () => {
    const ref = renderAgentFiles({}).find((file) =>
      file.path.endsWith('/references/widgets-and-apps.md'),
    )?.content;
    expect(ref).toBeDefined();
    expect(ref).toContain('@noodleseed/one/react');
    expect(ref).toMatch(/must start with.*primitives and semantic tokens/is);
    expect(ref).toMatch(
      /custom React\/CSS or third-party components remain valid.*explicitly requests them/is,
    );
    expect(ref).toContain('one primary action');
    expect(ref).toContain('at most two visible actions');
    expect(ref).toContain('280px');
    expect(ref).toContain('progressive disclosure');
    expect(ref).toContain('loading, empty, partial, stale, error, retry, and success');
    expect(ref).toContain('Never author against `ns-*`, `nsr-*`, or example-local `--nw-*`');
    expect(ref).toContain('<Frame');
    expect(ref).toContain('<AsyncBoundary');
    expect(ref).toContain('<ActionBar');
  });

  it('indexes every current flagship example needed for pattern discovery', () => {
    const ref = renderAgentFiles({}).find((f) =>
      f.path.endsWith('/references/examples.md'),
    )?.content;
    expect(ref).toBeDefined();
    for (const name of [
      'hello',
      'weather',
      'food-ordering',
      'customer-auth',
      'stateful-draft',
      'perplexity',
      'internal-ops-demo',
      'sharepoint',
      'bitcoin',
    ]) {
      expect(ref).toContain(`\`${name}\``);
    }
  });

  it('points bundled examples at their skill-local read path', () => {
    const ref = renderAgentFiles({}).find((f) =>
      f.path.endsWith('/references/examples.md'),
    )?.content;
    expect(ref).toBeDefined();
    expect(ref).toMatch(/read (them )?locally/i);
    for (const name of BUNDLED_EXAMPLE_NAMES) {
      expect(ref).toContain(`examples/${name}/src/server.ts`);
    }
  });

  it('keeps the customization-routing note in the SKILL.md router', () => {
    for (const file of renderAgentFiles({})) {
      if (file.skill !== 'noodle-seed' || !file.path.endsWith('/SKILL.md')) continue;
      expect(file.content).toMatch(/separate skill|do not edit this file|regenerated/i);
    }
  });

  it('teaches the shared pre-submission checklist in the app-directory-compliance reference', () => {
    const ref = renderAgentFiles({}).find((f) =>
      f.path.endsWith('/references/app-directory-compliance.md'),
    )?.content;
    expect(ref).toBeDefined();
    expect(ref).toMatch(/metadata readiness/i);
    expect(ref).toMatch(/user value/i);
    expect(ref).toMatch(/grounded capability/i);
    expect(ref).toMatch(/helpful ui|helpful-ui/i);
    expect(ref).toMatch(/meaningful completion/i);
    expect(ref).toMatch(/minimize.*data/i);
    expect(ref).toMatch(/directory-specific delta/i);
  });

  it('teaches the API-key loop in the connect-an-api reference', () => {
    const ref = renderAgentFiles({}).find((f) =>
      f.path.endsWith('/references/connect-an-api.md'),
    )?.content;
    expect(ref).toBeDefined();
    expect(ref).toMatch(/secret\(/); // secure the key as a managed secret, never inline
    expect(ref).toMatch(/probe|curl|tools call/i); // probe the live API to learn the real shape
    expect(ref).toMatch(/connector\(/); // model the connector from the observed shape
    expect(ref).toMatch(/\$\{response/); // map the real payload
    expect(ref).toMatch(/populated|not `undefined`|prove real output/i); // prove real output
  });

  it('teaches returning a live list, scoped local secrets, and CRUD in connect-an-api', () => {
    const ref = renderAgentFiles({}).find((f) =>
      f.path.endsWith('/references/connect-an-api.md'),
    )?.content;
    expect(ref).toBeDefined();
    // Return a list: whole-array bind, narrowing via a compute connector (NOT Zod/response-mapping),
    // and the pagination aggregate. This is the #1 friction primitive cold agents reverse-engineered.
    expect(ref).toContain('${response.results}');
    expect(ref).toMatch(/compute connector/i);
    expect(ref).toMatch(/does not strip/i);
    expect(ref).toContain('pagination:');
    expect(ref).toContain('${response.items}');
    // One local target + fail-before-empty-endpoint behavior (the #2 friction sink).
    expect(ref).toContain('--runtime local --from-env SOME_API_KEY');
    expect(ref).toMatch(/stop before exposing an empty endpoint/i);
    expect(ref).toContain('exact project-root `.env`');
    expect(ref).toMatch(/default-No import/i);
    expect(ref).toMatch(/agents and non-interactive runs use the value-free recovery commands/i);
    // CRUD / 204 no-content.
    expect(ref).toContain("responseType: 'empty'");
    // Non-JSON request bodies stay object-authored and use the one explicit encoding switch.
    expect(ref).toContain("requestEncoding: 'form-urlencoded'");
    expect(ref).toContain("'from airport id'");
    expect(ref).toMatch(/URLSearchParams/i);
    expect(ref).toContain('maxResponseBytes');
    expect(ref).toMatch(/1 MiB.*6 MiB/is);
    expect(ref).toMatch(/narrow.*before.*rais/is);

    const weatherReadme = BUNDLED_EXAMPLE_FILES.find(
      (file) => file.relPath === 'examples/weather/README.md',
    )?.content;
    expect(weatherReadme).toContain("requestEncoding: 'form-urlencoded'");
    expect(weatherReadme).toMatch(/maxResponseBytes.*6 MiB/is);
  });

  it('teaches the design-first concepts in the experience-design reference', () => {
    const ref = renderAgentFiles({}).find((f) =>
      f.path.endsWith('/references/experience-design.md'),
    )?.content;
    expect(ref).toBeDefined();
    expect(ref).toMatch(/handoff/i); // funnel / handoff boundary
    expect(ref).toMatch(/ground(ed|ing)/i); // grounded, never guessing
    expect(ref).toMatch(/two users|human and (the )?model|human \+ model/i);
    expect(ref).toMatch(/display mode/i); // display-mode restraint
    expect(ref).toMatch(/wireframe/i); // the design artifact
  });

  it('instructs a design spec before server.ts with the required fields', () => {
    const ref = renderAgentFiles({}).find((f) =>
      f.path.endsWith('/references/experience-design.md'),
    )?.content;
    expect(ref).toBeDefined();
    expect(ref).toMatch(/before .*server\.ts/i);
    for (const field of [
      /funnel boundary/i,
      /tools/i,
      /widgets/i,
      /display mode/i,
      /grounding/i,
      /handoff domains/i,
      /exception/i,
    ]) {
      expect(ref).toMatch(field);
    }
  });

  it('never names a competitor build stack anywhere in the tree (noodle SDK only)', () => {
    const text = renderAgentFiles({})
      .map((file) => file.content)
      .join('\n');
    expect(text).not.toMatch(/skybridge|alpic|apps-sdk|@openai\/apps-sdk/i);
  });

  it('never leaks real client names or commercial engagement details', () => {
    const text = renderAgentFiles({})
      .map((file) => file.content)
      .join('\n');
    expect(text).not.toMatch(/layla|jettly|hub71|heymate|sol-?ark|todoist|name\.com/i);
    expect(text).not.toMatch(/stakeholder|commission split|deal cadence|\$\d+\/mo/i);
  });

  it('surfaces experience design inside the App route', () => {
    const routers = renderAgentFiles({}).filter(
      (file) => file.skill === 'noodle-seed' && file.path.endsWith('/SKILL.md'),
    );
    // Guard against a vacuous pass: a SKILL.md router must actually exist for each target.
    expect(routers.length).toBe(2);
    for (const file of routers) {
      expect(file.content).toContain('references/experience-design.md');
      expect(file.content).toMatch(
        /Build or change an MCP App[^\n]+references\/experience-design\.md/,
      );
    }
  });

  it('mandates route-first progressive disclosure in the router and managed block', () => {
    const routers = renderAgentFiles({}).filter(
      (file) => file.skill === 'noodle-seed' && file.path.endsWith('/SKILL.md'),
    );
    expect(routers.length).toBe(2);
    for (const file of routers) {
      expect(file.content).toMatch(/choose (?:exactly )?one primary route/i);
      const discover = file.content.search(/choose (?:exactly )?one primary route/i);
      const handoff = file.content.indexOf('load the selected sibling skill');
      const commonLoop = file.content.indexOf('## Common machine loop');
      expect(discover).toBeGreaterThanOrEqual(0);
      expect(handoff).toBeGreaterThanOrEqual(0);
      expect(commonLoop).toBeGreaterThanOrEqual(0);
      expect(discover).toBeLessThan(handoff);
      expect(handoff).toBeLessThan(commonLoop);
      expect(file.content).toMatch(/supporting references only/i);
      expect(file.content).not.toMatch(/scan all|scan the .*index/i);
    }
    for (const target of ['codex', 'claude-code'] as const) {
      const block = renderManagedBlock({ target });
      expect(block).toMatch(/choose (?:exactly )?one primary route/i);
      expect(block).toMatch(/supporting references only/i);
      expect(block).not.toMatch(/scan all|scan its .*index/i);
    }
  });

  it('leaves experience design conditional on the selected app route', () => {
    for (const target of ['codex', 'claude-code'] as const) {
      const block = renderManagedBlock({ target, project: { name: 'demo' } });
      expect(block).not.toContain('references/experience-design.md');
      expect(block).not.toMatch(/design the experience before authoring/i);
      expect(block).not.toContain('## Widget design default');
    }
  });

  it('leads the injected managed block with the agent-native machine loop', () => {
    const block = renderManagedBlock({ target: 'codex' });
    expect(block).toContain('noodle commands --json');
    expect(block).toContain('noodle validate --json');
    // Repair rule points at the real per-field location (error.errors[].path), not a human list.
    expect(block).toContain('error.errors');
    expect(block).toMatch(/re-run validate/i);
    expect(block).toMatch(/never freeform re-edit/i);
    // Points at the machine contract; keeps the refresh line.
    expect(block).toContain('references/agent-contract.md');
    expect(block).toContain('noodle agents setup --write');
  });

  it('rewrites the SKILL.md router golden path as the same machine loop', () => {
    const skill = renderAgentFiles({}).find((f) => f.path.endsWith('/SKILL.md'))?.content;
    expect(skill).toBeDefined();
    expect(skill).toContain('noodle commands --json');
    expect(skill).toContain('noodle validate --json');
    expect(skill).toContain('error.errors');
    expect(skill).toMatch(/re-run `noodle validate/i);
    expect(skill).toContain('references/agent-contract.md');
  });

  it('golden path requires a live tools-call proof of real connector output', () => {
    const skill = renderAgentFiles({}).find((f) => f.path.endsWith('/SKILL.md'))?.content;
    expect(skill).toBeDefined();
    // validate + test compile the manifest and register tools, but neither proves a connector's
    // response mapping returns real data. The loop must run a live tools call before trusting it.
    expect(skill).toContain('noodle tools call');
    expect(skill).toMatch(/undefined|real (?:output|data)|useful output/i);
  });

  it('troubleshooting steers to a local tools call to prove connector output', () => {
    const ref = renderAgentFiles({}).find((f) =>
      f.path.endsWith('/references/troubleshooting.md'),
    )?.content;
    expect(ref).toBeDefined();
    // Local live execution IS available (in-process runtime) and is how you prove mapped output.
    expect(ref).toContain('noodle tools call');
    // The empty/undefined-output symptom (validate + test both green) must be mapped, pointing at
    // the response-mapping expression root.
    expect(ref).toMatch(/empty|undefined/i);
    expect(ref).toContain('${response');
  });

  it('documents the --json envelope, exit codes, and output modes in agent-contract', () => {
    const ref = renderAgentFiles({}).find((f) =>
      f.path.endsWith('/references/agent-contract.md'),
    )?.content;
    expect(ref).toBeDefined();
    // (a) envelope: success + failure shape, multi-error nesting, prose isolation.
    expect(ref).toContain('ok: true');
    expect(ref).toContain('ok: false');
    expect(ref).toContain('error.errors[]');
    expect(ref).toContain('error.fixPrompt');
    expect(ref).toMatch(/exactly one.*stdout/i);
    expect(ref).toMatch(/stderr stays empty/i);
    expect(ref).toMatch(/NDJSON/i);
    expect(ref).toMatch(/snapshot.*event.*terminal failure/i);
    // (b) exit-code taxonomy: 0 ok · 1 failure · 2 usage · 3 auth · 4 unreachable.
    expect(ref).toMatch(/usage/);
    expect(ref).toMatch(/auth/);
    expect(ref).toMatch(/unreachable/);
    // (c) three disjoint output modes.
    expect(ref).toContain('--json');
    expect(ref).toContain('--fix-prompt');
    expect(ref).toContain('--agent-output');
    // (d) repair loop: parse code + path, fix that field, re-validate.
    expect(ref).toMatch(/error\.code[\s\S]*path/);
  });
});

describe('managed block reconcile', () => {
  it('creates, updates, and preserves content outside the managed block', () => {
    const block = renderManagedBlock({ target: 'codex', project: { name: 'demo' } });
    const created = reconcileManagedBlock({ block });
    expect(created.action).toBe('created');
    expect(created.content).toContain(MANAGED_BEGIN);
    expect(created.content).toContain(MANAGED_END);

    const existing = `# Mine\n\n${created.content}Tail\n`;
    const nextBlock = renderManagedBlock({ target: 'codex', project: { name: 'demo2' } });
    const updated = reconcileManagedBlock({ existing, block: nextBlock });
    expect(updated.action).toBe('updated');
    expect(updated.content).toContain('# Mine');
    expect(updated.content).toContain('Tail');
    expect(updated.content.match(/BEGIN NOODLE AGENT CONTEXT/g)).toHaveLength(1);
    expect(updated.content).toContain('name: demo2');
  });

  it('skips user-edited managed blocks unless forced', () => {
    const block = renderManagedBlock({ target: 'codex', project: { name: 'demo' } });
    const edited = block.replace('Build this project', 'Build this edited project');
    const nextBlock = renderManagedBlock({ target: 'codex', project: { name: 'demo2' } });

    const skipped = reconcileManagedBlock({ existing: edited, block: nextBlock });
    expect(skipped.action).toBe('skipped');
    expect(skipped.reason).toBe('user-edited-managed-block');
    expect(skipped.content).toBe(edited);

    const overwritten = reconcileManagedBlock({ existing: edited, block: nextBlock, force: true });
    expect(overwritten.action).toBe('overwritten');
    expect(overwritten.content).toContain('name: demo2');
  });
});

describe('publishable skills (self-checking)', () => {
  // SKILL.md + references + bundled example files, per target.
  const EXPECTED_PUBLISH_COUNT =
    2 *
    (1 +
      REFERENCE_NAMES.length +
      BUNDLED_EXAMPLE_FILES.length +
      EXPECTED_BEHAVIOR_SKILL_NAMES.length +
      BEHAVIOR_SKILLS.reduce((count, skill) => count + 1 + skill.supportingReferences.length, 0) +
      1);

  it('publishes the full tree per target with correct paths', () => {
    const skills = renderPublishableSkills();
    expect(skills).toHaveLength(EXPECTED_PUBLISH_COUNT);
    const expectedPaths = (['codex', 'claude-code'] as const)
      .flatMap((t) => [
        `skills/${t}/SKILL.md`,
        ...REFERENCE_NAMES.map((n) => `skills/${t}/references/${n}.md`),
        ...BUNDLED_EXAMPLE_FILES.map((ex) => `skills/${t}/${ex.relPath}`),
        ...BEHAVIOR_SKILLS.flatMap((skill) => [
          `skills/${t}/${skill.name}/SKILL.md`,
          ...[skill.primaryReference, ...skill.supportingReferences].map(
            (reference) => `skills/${t}/${skill.name}/${reference}`,
          ),
        ]),
        `skills/${t}/${EXECUTING_NOODLE_PLANS_SKILL.name}/SKILL.md`,
      ])
      .sort();
    expect(skills.map((s) => s.path).sort()).toEqual(expectedPaths);
  });

  it('keeps SKILL.md frontmatter spec-valid and stores self-check metadata in the body', () => {
    for (const skill of renderPublishableSkills()) {
      if (skill.path.endsWith('/SKILL.md')) {
        const lines = skill.content.split('\n');
        expect(lines[0]).toBe('---');
        const close = lines.indexOf('---', 1);
        const frontmatter = lines.slice(1, close).join('\n');
        expect(frontmatter.split('\n').map((line) => line.split(':', 1)[0])).toEqual([
          'name',
          'description',
        ]);
        expect(lines[close + 2]).toMatch(
          new RegExp(`^<!-- noodle-skill version:${AGENT_KIT_VERSION} hash:[a-f0-9]{16} -->$`),
        );
      } else if (skill.path.includes('/references/')) {
        // References are plain markdown (no frontmatter): manifest sha256 covers integrity.
        expect(skill.content.startsWith('---')).toBe(false);
        expect(skill.content.startsWith('# ')).toBe(true);
      } else {
        // Bundled example files are verbatim source (server.ts, .tsx, .css, .json, .md); they carry
        // no skill frontmatter and are covered by the manifest sha256 and the bundled-examples tests.
        expect(skill.path).toMatch(/\/examples\/[a-z0-9-]+\//);
      }
    }
  });

  it('keeps the SKILL.md metadata hash matching its body (self-identifying)', () => {
    for (const skill of renderPublishableSkills()) {
      if (!skill.path.endsWith('/SKILL.md')) continue;
      const lines = skill.content.split('\n');
      const close = lines.indexOf('---', 1);
      const body = lines
        .slice(close + 4)
        .join('\n')
        .replace(/\n$/, '');
      const match = /hash:([a-f0-9]{16})/.exec(lines[close + 2] ?? '');
      expect(match?.[1]).toBe(contentHash(body));
    }
  });

  it('renders a manifest with packageVersion and per-file full sha256', () => {
    const manifest = renderAgentKitManifest();
    const skills = renderPublishableSkills();
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.packageVersion).toBe(AGENT_KIT_VERSION);
    expect(manifest.files).toHaveLength(EXPECTED_PUBLISH_COUNT);
    for (const entry of manifest.files) {
      expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(['codex', 'claude-code']).toContain(entry.agentTarget);
      expect(entry.installedPath).toMatch(/^\.(?:agents|claude)\/skills\/[a-z0-9-]+\//);
      const skill = skills.find((s) => s.path === entry.path);
      if (skill === undefined) throw new Error(`missing publishable skill for ${entry.path}`);
      expect(entry.sha256).toBe(contentSha256(skill.content));
    }
  });

  it('maps every installed file back to its publishable source with identical content', () => {
    const installed = renderAgentFiles({});
    const skills = renderPublishableSkills();
    const mappings = skillFileMappings();
    expect(mappings).toHaveLength(EXPECTED_PUBLISH_COUNT);
    for (const mapping of mappings) {
      const installedFile = installed.find((f) => f.path === mapping.installedPath);
      const publishFile = skills.find((s) => s.path === mapping.publishPath);
      if (installedFile === undefined)
        throw new Error(`missing installed ${mapping.installedPath}`);
      if (publishFile === undefined) throw new Error(`missing publish ${mapping.publishPath}`);
      expect(installedFile.content).toBe(publishFile.content);
    }
  });
});

describe('bundled flagship examples', () => {
  const PER_FILE_MAX_BYTES = 96_000;
  const TOTAL_MAX_BYTES = 600_000;
  const DESIGN_FIRST = ['acme-discovery', 'acme-tasks', 'acme-bistro'] as const;

  it('bundles the design-first + starter flagship set, each with a server.ts', () => {
    expect([...BUNDLED_EXAMPLE_NAMES]).toEqual([
      'hello',
      'weather',
      'food-ordering',
      'acme-discovery',
      'acme-tasks',
      'acme-bistro',
      'customer-auth',
      'stateful-draft',
      'gmail-multi-account',
      'google-bigquery',
    ]);
    for (const name of BUNDLED_EXAMPLE_NAMES) {
      expect(
        BUNDLED_EXAMPLE_FILES.some((f) => f.relPath === `examples/${name}/src/server.ts`),
      ).toBe(true);
    }
  });

  it('ships a design/ set for every design-first flagship', () => {
    for (const name of DESIGN_FIRST) {
      expect(
        BUNDLED_EXAMPLE_FILES.some((f) => f.relPath.startsWith(`examples/${name}/design/`)),
      ).toBe(true);
    }
  });

  it('omits binary assets and lockfiles from the bundle', () => {
    for (const file of BUNDLED_EXAMPLE_FILES) {
      expect(file.relPath).not.toMatch(
        /\.(jpg|jpeg|png|gif|webp|svg|ico|woff2?|ttf|otf|eot|mp4|mov|pdf|zip|gz|wasm)$/i,
      );
      expect(file.relPath).not.toMatch(/(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/);
    }
  });

  it('keeps every file within the per-file cap and the corpus within the total cap', () => {
    let total = 0;
    for (const file of BUNDLED_EXAMPLE_FILES) {
      const bytes = Buffer.byteLength(file.content, 'utf-8');
      expect(bytes, file.relPath).toBeLessThanOrEqual(PER_FILE_MAX_BYTES);
      total += bytes;
    }
    expect(total).toBeLessThanOrEqual(TOTAL_MAX_BYTES);
  });

  it('contains no client, competitor, or secret leakage', () => {
    const text = BUNDLED_EXAMPLE_FILES.map((f) => f.content).join('\n');
    expect(text).not.toMatch(/layla|jettly|hub71|heymate|sol-?ark|todoist|name\.com/i);
    expect(text).not.toMatch(/skybridge|alpic|apps-sdk/i);
    expect(text).not.toMatch(
      /NOODLE_AUTH_TOKEN|oauthRefreshToken|\brefreshToken\b|\bnbk_[A-Za-z0-9]|\bsk-[a-z0-9]{16,}/i,
    );
    expect(text).not.toMatch(/stakeholder|commission split|deal cadence/i);
  });

  it('lists every bundled example in the examples.md index (no silent doc drift)', () => {
    const ref = renderAgentFiles({}).find((f) =>
      f.path.endsWith('/references/examples.md'),
    )?.content;
    expect(ref).toBeDefined();
    for (const name of BUNDLED_EXAMPLE_NAMES) {
      expect(ref).toContain(`\`${name}\``);
    }
  });

  it('installs every bundled file identically under both agent skill trees', () => {
    const files = renderAgentFiles({});
    for (const base of ['.agents/skills/noodle-seed', '.claude/skills/noodle-seed']) {
      for (const example of BUNDLED_EXAMPLE_FILES) {
        const installed = files.find((f) => f.path === `${base}/${example.relPath}`);
        expect(installed?.content, `${base}/${example.relPath}`).toBe(example.content);
      }
    }
  });
});
