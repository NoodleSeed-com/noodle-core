import { describe, expect, it } from 'vitest';
import { BEHAVIOR_SKILLS, renderBehaviorSkillBody } from '../src/behavior-skills.js';
import { renderAgentFiles } from '../src/index.js';

describe('embedded assistant routing guidance', () => {
  it('requires one decision-complete architecture recommendation before code', () => {
    const skill = BEHAVIOR_SKILLS.find(
      (candidate) => candidate.name === 'embedding-mcp-assistants',
    );
    expect(skill, 'missing embedding behavior skill').toBeDefined();
    if (skill === undefined) throw new Error('missing embedding behavior skill');

    const entrypoint = renderBehaviorSkillBody(skill, 'codex');
    expect(entrypoint).toMatch(/named end user.*conversational job.*one to three workflows/is);
    expect(entrypoint).toMatch(/access mode/i);
    expect(entrypoint).toMatch(/renderer/i);
    expect(entrypoint).toMatch(/host framework/i);
    expect(entrypoint).toMatch(/identity.*routing.*model owner.*evidence level/is);

    const reference = renderAgentFiles({}).find((candidate) =>
      candidate.path.endsWith('/references/embedded-assistant.md'),
    );
    expect(reference, 'missing embedded assistant reference').toBeDefined();
    expect(reference?.content).toContain('## Select the architecture before code');
    expect(reference?.content).toMatch(/two code ownership roots.*two local processes/is);
    expect(reference?.content).toMatch(/exactly one recommended topology.*unranked menu/is);
    expect(reference?.content).toMatch(/public.*authenticated.*mixed/is);
    expect(reference?.content).toMatch(/hand off to `designing-mcp-products`.*before code/is);
    expect(reference?.content).toMatch(/blocked architecture brief.*do not edit either codebase/is);
  });

  it('teaches backend-derived customer endpoint routing and its trust boundary', () => {
    const reference = renderAgentFiles({}).find((candidate) =>
      candidate.path.endsWith('/references/embedded-assistant.md'),
    );
    expect(reference, 'missing embedded assistant reference').toBeDefined();
    expect(reference?.content).toContain('routing: {');
    expect(reference?.content).toContain('customer_api: account.clusterApiBaseUrl');
    expect(reference?.content).toContain('The browser does not send `routing`');
    expect(reference?.content).toContain('connector_route_unavailable');
    expect(reference?.content).toContain('invalid assistant routing');
    expect(reference?.content).toContain(
      'unknown endpoint name or a malformed/policy-disallowed URL',
    );
    expect(reference?.content).toContain(
      'assistant doctor does not supply application-specific routes',
    );
  });

  it('teaches the authenticated host boundary and links the framework-specific Django/Vue guide', () => {
    const reference = renderAgentFiles({}).find((candidate) =>
      candidate.path.endsWith('/references/embedded-assistant.md'),
    );
    expect(reference, 'missing embedded assistant reference').toBeDefined();
    expect(reference?.content).toContain('JSON `401`');
    expect(reference?.content).toContain('exact configured Origin');
    expect(reference?.content).toContain('server-owned membership');
    expect(reference?.content).toContain('Forward the helper response unchanged');
    expect(reference?.content).toContain('same-origin cookies');
    expect(reference?.content).toContain('HTML login redirect');
    expect(reference?.content).toContain('CSRF');
    expect(reference?.content).toContain(
      'https://docs.noodleseed.dev/docs/guides/embedded-assistant-django-vue',
    );
  });

  it('provides one complete mixed-mode redirect and elevation sequence', () => {
    const reference = renderAgentFiles({}).find((candidate) =>
      candidate.path.endsWith('/references/embedded-assistant.md'),
    );
    expect(reference, 'missing embedded assistant reference').toBeDefined();
    expect(reference?.content).toContain('Complete mixed-mode handoff');
    expect(reference?.content).toContain('assistant-sign-in-requested');
    expect(reference?.content).toContain('single-use `signInTicket`');
    expect(reference?.content).toContain('short-lived login transaction');
    expect(reference?.content).toContain('full-page redirect');
    expect(reference?.content).toContain('origin the conversation will continue on');
    expect(reference?.content).toContain('createAssistantSession({ ..., signInTicket })');
    expect(reference?.content).toContain('same-origin session endpoint');
    expect(reference?.content).toContain('bounded visible transcript');
    expect(reference?.content).toContain('never tool internals or a spent ticket');
  });

  it('recommends dual-surface continuous onboarding as the first account-growth workflow', () => {
    const reference = renderAgentFiles({}).find((candidate) =>
      candidate.path.endsWith('/references/embedded-assistant.md'),
    );
    expect(reference, 'missing embedded assistant reference').toBeDefined();
    const content = reference?.content ?? '';
    const start = content.indexOf('### First-workflow default: continuous onboarding');
    const end = content.indexOf('## Install into the existing application', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const guidance = content.slice(start, end);

    expect(guidance).toMatch(/not limited to B2B SaaS/i);
    expect(guidance).toMatch(
      /public visitor surface.*signup or sign-in.*useful result before account creation.*authenticated product outcome/is,
    );
    expect(guidance).toContain('publicWebsite({ signIn: true })');
    expect(guidance).toContain('authenticatedWebsite(...)');
    expect(guidance).toMatch(/one assistant.*two customer-owned surfaces/is);
    expect(guidance).toMatch(/both mounts.*one first-workflow delivery scope/is);
    expect(guidance).toMatch(/only the public or only the authenticated.*partial/is);
    expect(guidance).toMatch(/do not recommend.*no genuine pre-account value/is);
    expect(guidance).toContain('../examples/stateful-draft/README.md');
    expect(guidance).toContain('https://docs.noodleseed.dev/docs/guides/signup-continuity');
    expect(guidance).toMatch(/does not guarantee.*conversion lift/i);
  });

  it('teaches automatic authorization-aware product-guide projection without a browser API', () => {
    const reference = renderAgentFiles({}).find((candidate) =>
      candidate.path.endsWith('/references/embedded-assistant.md'),
    );
    expect(reference, 'missing embedded assistant reference').toBeDefined();
    expect(reference?.content).toContain('automatically projects the typed guide');
    expect(reference?.content).toContain('exact model-visible tools');
    expect(reference?.content).toContain('backend-verified roles and scopes');
    expect(reference?.content).toContain('A member and an administrator');
    expect(reference?.content).toContain('No renderer prop, browser package field');
    expect(reference?.content).toContain('never enter session responses or browser events');
  });

  it('teaches the presentation-only confirmation-details option', () => {
    const reference = renderAgentFiles({}).find((candidate) =>
      candidate.path.endsWith('/references/embedded-assistant.md'),
    );
    expect(reference, 'missing embedded assistant reference').toBeDefined();
    expect(reference?.content).toContain('showConfirmationDetails: false');
    expect(reference?.content).toContain('defaults to `false`');
    expect(reference?.content).toContain('set it to `true` only when the audience needs');
    expect(reference?.content).toContain(
      'keeps technical action details out of the default review',
    );
    expect(reference?.content).toContain('`confirm: true` still suspends until acceptance');
    expect(reference?.content).toContain('headless/BYO `data-confirmation` stays unchanged');
  });

  it('makes the copied custom-renderer skeleton explicitly complete or fail closed', () => {
    const reference = renderAgentFiles({}).find((candidate) =>
      candidate.path.endsWith('/references/embedded-assistant.md'),
    );
    expect(reference, 'missing embedded assistant reference').toBeDefined();
    const content = reference?.content ?? '';
    const start = content.indexOf('### Minimal fail-closed custom renderer skeleton');
    const end = content.indexOf('### Framework-neutral DOM client', start);
    expect(start, 'missing custom renderer skeleton heading').toBeGreaterThanOrEqual(0);
    expect(end, 'missing custom renderer skeleton boundary').toBeGreaterThan(start);
    const skeleton = content.slice(start, end);

    expect(skeleton).toContain('suggestions');
    expect(skeleton).toContain('data-sign-in');
    expect(skeleton).toContain('signInTicket');
    expect(skeleton).toContain('requestedSchema');
    expect(skeleton).toContain('{ action: "decline" }');
    expect(skeleton).toContain('{ action: "cancel" }');
    expect(skeleton).toContain('data-tool-result');
    expect(skeleton).toContain('data-view');
    expect(skeleton).toContain('NoodleAppView');
    expect(skeleton).toContain('Unsupported assistant content');
    expect(skeleton).toContain('session_expired');
    expect(skeleton).toContain('role="status"');
    expect(skeleton).toContain('role="alert"');
    expect(skeleton).toContain('does not undo a started action');
    expect(skeleton).toContain('pendingSignInTicket');
    expect(skeleton).toContain('Promise<"started" | "cancelled">');
    expect(skeleton).toContain('Promise.resolve()');
    expect(skeleton).toMatch(/\.then\(\(\) =>[\s\S]{0,100}onSignInRequested/);
    expect(skeleton).toContain('pendingSignInTicket !== undefined');
    expect(skeleton.match(/setPendingSignInTicket\(undefined\)/g)).toHaveLength(2);
    expect(skeleton).toMatch(/do not send a first turn on mount by default/is);
    expect(skeleton).toMatch(/does not render Confirm.*schema-aware review/is);
    expect(skeleton).toMatch(/never.*generic.*retry/is);

    expect(content).toMatch(/never call.*respond.*while scanning/is);
    expect(content).toMatch(/separate public.*authenticated.*client/is);
    expect(content).not.toMatch(/await assistant\.sendMessage[\s\S]{0,500}action: 'accept'/);
    expect(content).toContain('type NoodleAppViewElement');
    expect(content).toContain('type AssistantViewAvailableDetail');
    expect(content).toContain('new Map<string, NoodleAppViewElement>()');
    expect(content).toMatch(/appViews\.append\(appView\);[\s\S]*appView\.theme =/);
    expect(content).toContain('new MutationObserver(syncResolvedTheme)');
    expect(content).toContain('const activeViewKeys = new Set<string>()');
    expect(content).toContain('activeViewKeys.add(key)');
    expect(content).toMatch(
      /for \(const \[key, mountedView\] of mountedViews\)[\s\S]*mountedView\.remove\(\)[\s\S]*mountedViews\.delete\(key\)/,
    );
    const frameworkNeutral = content.slice(
      end,
      content.indexOf('## Host readiness and promotion', end),
    );
    expect(frameworkNeutral).not.toMatch(/in Vue, Angular, or plain DOM/);
  });

  it('teaches the host evidence ladder and stops at the first unproven level', () => {
    const reference = renderAgentFiles({}).find((candidate) =>
      candidate.path.endsWith('/references/embedded-assistant.md'),
    );
    expect(reference, 'missing embedded assistant reference').toBeDefined();
    const content = reference?.content ?? '';
    const start = content.indexOf('## Host readiness and promotion');
    const end = content.indexOf('## Toolchain requirements', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const readiness = content.slice(start, end);

    expect(readiness).toMatch(
      /static host.*local contract.*hosted session.*production browser.*operations/is,
    );
    expect(readiness).toContain('firstUnproven');
    expect(readiness).toContain('partial');
    expect(readiness).toContain('mcp-endpoint');
    expect(readiness).toContain('html-redirect-risk');
    expect(readiness).toContain('ssr-risk');
    expect(readiness).toContain('cross-origin-risk');
    expect(readiness).toMatch(/static.*never.*production-browser proof/is);
    expect(readiness).toMatch(/no live or browser flag/is);
  });

  it('proves launch operations and qualified customer outcomes separately from traffic', () => {
    const reference = renderAgentFiles({}).find((candidate) =>
      candidate.path.endsWith('/references/embedded-assistant.md'),
    );
    expect(reference, 'missing embedded assistant reference').toBeDefined();
    const content = reference?.content ?? '';
    const start = content.indexOf('## Launch and qualified-usage proof');
    const end = content.indexOf('## Toolchain requirements', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const launch = content.slice(start, end);

    expect(launch).toMatch(/pre-launch[\s\S]*post-launch/is);
    for (const command of [
      'noodle assistant embed --check --json',
      'noodle assistant doctor',
      'noodle assistant appearance show',
      'noodle assistant clients list',
      'noodle assistant clients rotate',
      'noodle assistant budget set',
      'noodle assistant usage --window 7d',
      'noodle rollback <previous-deployment-id>',
    ]) {
      expect(launch).toContain(command);
    }
    expect(launch).toMatch(
      /normal[\s\S]*ambiguous[\s\S]*missing-data[\s\S]*unauthorized[\s\S]*tenant-switch[\s\S]*confirmation[\s\S]*recovery/is,
    );
    expect(launch).toMatch(
      /task completion[\s\S]*refusal correctness[\s\S]*repeat usage[\s\S]*safety[\s\S]*latency[\s\S]*abandonment/is,
    );
    expect(launch).toMatch(/raw turn volume.*not.*outcome/is);
    expect(launch).toMatch(/platform-owned completion event.*human-approved/is);
  });

  it('keeps the flagship launch note brief and links to the owned public guide', () => {
    const readme = renderAgentFiles({}).find((candidate) =>
      candidate.path.endsWith('/examples/customer-auth/README.md'),
    )?.content;
    expect(readme).toContain('## Launch and qualified-usage proof');
    expect(readme).toContain('https://docs.noodleseed.dev/docs/guides/embedded-assistant');
    expect(readme).not.toContain('https://docs.noodleseed.dev/guides/embedded-assistant');
    expect(readme).not.toContain('references/embedded-assistant.md');
    expect(readme).not.toContain('noodle assistant usage --window 7d');
    expect(readme).not.toContain('noodle rollback <previous-deployment-id>');
    expect(readme).toContain("let resolvedTheme: 'light' | 'dark'");
    expect(readme).toContain('for (const mountedView of mountedViews.values())');
    expect(readme).toContain('new MutationObserver(syncResolvedTheme)');
    expect(readme).toContain('const activeViewKeys = new Set<string>()');
    expect(readme).toContain('mountedView.remove()');
    expect(readme).toContain('mountedViews.delete(key)');
  });
});
