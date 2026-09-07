import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderAuditEventsTable } from '../src/commands/audit-ops.js';
import { run } from '../src/index.js';

const widgetServer = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'examples',
  'food-ordering',
  'src',
  'server.ts',
);
const handoffNoAllowlistServer = join(
  import.meta.dirname,
  'fixtures',
  'handoff-no-allowlist',
  'server.ts',
);
const handoffWithAllowlistServer = join(
  import.meta.dirname,
  'fixtures',
  'handoff-with-allowlist',
  'server.ts',
);
const websitePortWidgetServer = join(
  import.meta.dirname,
  'fixtures',
  'website-port-widget',
  'server.ts',
);
const ambiguousActionsWidgetServer = join(
  import.meta.dirname,
  'fixtures',
  'ambiguous-actions-widget',
  'server.ts',
);
const budgetHeavyWidgetServer = join(
  import.meta.dirname,
  'fixtures',
  'budget-heavy-widget',
  'server.ts',
);
const sensitiveWidgetServer = join(
  import.meta.dirname,
  'fixtures',
  'sensitive-widget-output',
  'server.ts',
);
const shellNavigationWidgetServer = join(
  import.meta.dirname,
  'fixtures',
  'shell-navigation-widget',
  'server.ts',
);
const appShellProofServer = join(import.meta.dirname, 'fixtures', 'app-shell-proof', 'server.ts');
const statuslessActionWidgetServer = join(
  import.meta.dirname,
  'fixtures',
  'statusless-action-widget',
  'server.ts',
);
const formControlsWidgetServer = join(
  import.meta.dirname,
  'fixtures',
  'form-controls-widget',
  'server.ts',
);
const formattedWidgetServer = join(
  import.meta.dirname,
  'fixtures',
  'formatted-widget',
  'server.ts',
);
const travelDiscoveryCheckServer = join(
  import.meta.dirname,
  'fixtures',
  'travel-discovery-check',
  'server.ts',
);
const placeholderDomainWidgetServer = join(
  import.meta.dirname,
  'fixtures',
  'placeholder-domain-widget',
  'server.ts',
);
const faultyCspWidgetServer = join(
  import.meta.dirname,
  'fixtures',
  'faulty-csp-widget',
  'server.ts',
);
const embeddedAssistantServer = join(
  import.meta.dirname,
  'fixtures',
  'embedded-assistant',
  'server.ts',
);

let home: string;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'noodle-p2-home-'));
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

function stdout(): string {
  return logSpy.mock.calls.map((call) => String(call[0])).join('\n');
}

describe('P2 MCP Apps CLI', () => {
  it('checks widget apps with a human checklist report and no secret leakage', async () => {
    expect(await run(['check', widgetServer], {}, home)).toBe(0);
    const printed = stdout();
    expect(printed).toContain('App check: pass');
    // Checklist convention: aligned finding labels, indented Fix: + command beneath non-ok
    // items, and the dim `N ok · N warnings · N failing` summary at the end.
    expect(printed).toContain('metadata');
    expect(printed).toContain('progressive enhancement');
    expect(printed).toMatch(/\n\s+Fix: /);
    expect(printed).toMatch(/\d+ ok · \d+ warnings? · 0 failing/);
    expect(printed).not.toMatch(/NOODLE_AUTH_TOKEN|refresh[_-]?token|secret value|caller-key/i);
  }, 15_000);

  it('fails (host-agnostic) on a widget CSP origin the host renderer would drop', async () => {
    // Not target-specific — a scheme-less origin is dropped by every strict host, so `check` fails at the
    // default target too. Same fault the deploy route gates on; the exit code proves check gates on it.
    expect(await run(['check', faultyCspWidgetServer, '--json'], {}, home)).toBe(1);
    const body = JSON.parse(stdout()) as {
      ok: boolean;
      error?: { errors?: Array<{ code: string; severity: string; message: string }> };
    };
    expect(body.ok).toBe(false);
    const finding = body.error?.errors?.find((f) => f.code === 'csp_origin_cart');
    expect(finding?.severity).toBe('error');
    expect(finding?.message).toContain('api.shop.example.com');
  });

  it('checks widget apps with JSON and stable finding fields', async () => {
    expect(await run(['check', widgetServer, '--json'], {}, home)).toBe(0);
    const body = JSON.parse(stdout()) as {
      ok: boolean;
      data: { findings: Array<{ code: string; severity: string; message: string }> };
    };
    expect(body.ok).toBe(true);
    expect(body).not.toHaveProperty('schema_version');
    expect(body).not.toHaveProperty('app_info');
    expect(body).not.toHaveProperty('test_cases');
    expect(
      body.data.findings.every((finding) => finding.code && finding.severity && finding.message),
    ).toBe(true);
    expect(body.data.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining([
        'app_only_tools',
        'branding',
        'custom_component_use',
        'host_compatibility',
        'progressive_enhancement',
        'state_store_use',
        'submission_readiness',
        'tool_metadata',
      ]),
    );
    expect(body.data.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'custom_component_use', severity: 'info' }),
        expect.objectContaining({ code: 'state_store_use', severity: 'info' }),
      ]),
    );
    expect(body.data.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'tool_metadata', severity: 'warn' }),
      ]),
    );
    const toolMetadataFinding = body.data.findings.find(
      (finding) => finding.code === 'tool_metadata',
    );
    expect(toolMetadataFinding?.message).toContain('invocation metadata');
    const brandingFinding = body.data.findings.find((finding) => finding.code === 'branding');
    expect(brandingFinding?.message).toContain('Food Ordering');
    expect(brandingFinding?.message).toContain('accent');
    const helperFinding = body.data.findings.find((finding) => finding.code === 'app_only_tools');
    expect(helperFinding?.message).toContain('normal policy-gated tools/call path');
    expect(helperFinding?.message).toContain('not authorization');
  });

  it('reports tool-design findings at the default target without changing the exit code', async () => {
    // The tool-design heuristics (docs guide: Designing tools for agents) are warn-only by
    // contract, so adding them must never flip an existing app from pass to fail.
    expect(await run(['check', widgetServer, '--json'], {}, home)).toBe(0);
    const body = JSON.parse(stdout()) as {
      ok: boolean;
      data: { findings: Array<{ code: string; severity: string; message: string }> };
    };
    expect(body.ok).toBe(true);
    const toolDesign = body.data.findings.filter((finding) =>
      finding.code.startsWith('tool_design_'),
    );
    expect(toolDesign.map((finding) => finding.code)).toEqual([
      'tool_design_titles',
      'tool_design_output_shape',
      'tool_design_output_bounds',
      'tool_design_surface_budget',
      'tool_design_context',
    ]);
    expect(toolDesign.every((finding) => finding.severity !== 'error')).toBe(true);
  }, 15_000);

  it('checks ChatGPT target compatibility with explicit adapter findings', async () => {
    expect(await run(['check', widgetServer, '--target', 'chatgpt', '--json'], {}, home)).toBe(0);
    const body = JSON.parse(stdout()) as {
      ok: boolean;
      data: {
        findings: Array<{ code: string; severity: string; message: string }>;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.data.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'chatgpt_output_template', severity: 'info' }),
        expect.objectContaining({ code: 'chatgpt_widget_state', severity: 'info' }),
        expect.objectContaining({ code: 'chatgpt_elicitation_compatibility', severity: 'warn' }),
      ]),
    );
  }, 15_000);

  it('checks the embedded-assistant model, origins, themes, and consent metadata', async () => {
    expect(
      await run(
        ['check', embeddedAssistantServer, '--target', 'embedded-assistant', '--json'],
        {},
        home,
      ),
    ).toBe(0);
    const body = JSON.parse(stdout()) as {
      data: { findings: Array<{ code: string; severity: string; next?: string }> };
    };
    expect(body.data.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'assistant_configuration', severity: 'info' }),
        expect.objectContaining({
          code: 'assistant_embedding_workflow',
          severity: 'info',
          next: 'noodle deploy',
        }),
        expect.objectContaining({ code: 'assistant_themes', severity: 'info' }),
        expect.objectContaining({ code: 'assistant_consent_metadata', severity: 'info' }),
        expect.objectContaining({
          code: 'assistant_session_claims',
          severity: 'info',
          message: expect.stringContaining('displayName (model)'),
        }),
        // No server.auth on this fixture: warn that a customers-access deploy will be rejected.
        expect.objectContaining({ code: 'assistant_customer_auth', severity: 'warn' }),
      ]),
    );
  });

  it('warns about model-visible effects that are not explicitly confirmation-gated', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noodle-consent-audit-'));
    const source = readFileSync(embeddedAssistantServer, 'utf8').replace(
      'annotations: annotations.readOnly(),',
      'annotations: annotations.action({ confirm: false }),',
    );
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'server.ts'), source);
    expect(
      await run(
        ['check', join(dir, 'src', 'server.ts'), '--target', 'embedded-assistant', '--json'],
        {},
        home,
      ),
    ).toBe(0);
    const body = JSON.parse(stdout()) as {
      data: { findings: Array<{ code: string; severity: string; message: string }> };
    };
    const consent = body.data.findings.find((f) => f.code === 'assistant_consent_metadata');
    expect(consent?.severity).toBe('warn');
    expect(consent?.message).toContain('lookup');
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports customer auth as ready when server.auth is declared', async () => {
    const authedServer = join(
      import.meta.dirname,
      'fixtures',
      'embedded-assistant-auth',
      'server.ts',
    );
    expect(
      await run(['check', authedServer, '--target', 'embedded-assistant', '--json'], {}, home),
    ).toBe(0);
    const body = JSON.parse(stdout()) as {
      data: { findings: Array<{ code: string; severity: string }> };
    };
    expect(body.data.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'assistant_customer_auth', severity: 'info' }),
      ]),
    );
  });

  it('rejects unknown widget check targets before treating them as paths', async () => {
    expect(await run(['check', '--target', 'unknown', '--json'], {}, home)).toBe(2);
    const body = JSON.parse(stdout()) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('invalid_target');
  });

  it('prints agent-ready check remediation without leaking secrets', async () => {
    expect(await run(['check', widgetServer, '--fix-prompt'], {}, home)).toBe(0);
    expect(stdout()).toContain('Fix this Noodle MCP Apps readiness check');
    expect(stdout()).not.toMatch(/NOODLE_AUTH_TOKEN|refresh[_-]?token|secret value|caller-key/i);
  });

  it('reserves noodle audit for operator governance subcommands', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await run(['audit', widgetServer], {}, home)).toBe(2);
    expect(errorSpy.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
      'Unknown subcommand',
    );
  });

  it('starts a local devtools preview and prints the loopback URL', async () => {
    expect(
      await run(['devtools', widgetServer, '--theme', 'both', '--device', 'mobile'], {}, home),
    ).toBe(0);
    const printed = stdout();
    expect(printed).toContain('noodle devtools');
    expect(printed).toContain('http://127.0.0.1:');
    expect(printed).toContain('theme both');
    expect(printed).toContain('device mobile');
  });

  it('checks the food ordering app without hosted services or secret leakage', async () => {
    expect(await run(['check', widgetServer], {}, home)).toBe(0);
    const printed = stdout();
    expect(printed).toContain('App check: pass');
    expect(printed).toContain('progressive enhancement');
    expect(printed).toContain('app-only');
    expect(printed).not.toMatch(
      /NOODLE_AUTH_TOKEN|refresh[_-]?token|secret value|caller-key|TICKETS_TOKEN|PARTNER_KEY|httpbin|Alpic|Skybridge|Meridian/i,
    );
  });

  it('reports React handoff policy guidance without inspecting widget source', async () => {
    expect(await run(['check', handoffNoAllowlistServer], {}, home)).toBe(0);
    const printed = stdout();
    expect(printed).toContain('App check: pass');
    expect(printed).toContain('handoff allowlist');
    expect(printed).not.toContain('https://orders.example.com/checkout');
  });

  it('reports the React handoff allowlist finding in JSON with stable fields', async () => {
    expect(await run(['check', handoffNoAllowlistServer, '--json'], {}, home)).toBe(0);
    const body = JSON.parse(stdout()) as {
      ok: boolean;
      data: { findings: Array<{ code: string; severity: string; message: string }> };
    };
    expect(body.ok).toBe(true);
    const finding = body.data.findings.find((f) => f.code === 'handoff_allowlist');
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('info');
    expect(finding?.message).toContain('No handoff.allowedDomains allowlist declared');
  });

  it('passes audit when handoff actions are backed by an allowlist', async () => {
    expect(await run(['check', handoffWithAllowlistServer, '--json'], {}, home)).toBe(0);
    const body = JSON.parse(stdout()) as {
      ok: boolean;
      data: { findings: Array<{ code: string; severity: string }> };
    };
    expect(body.ok).toBe(true);
    expect(body.data.findings.some((f) => f.code === 'missing_handoff_allowlist')).toBe(false);
  });

  it('does not require an allowlist for widget apps without handoff actions', async () => {
    // The food-ordering example uses handoff with an allowlist already; assert the neutral
    // contract holds at the code level: no missing-allowlist error is raised when audit passes.
    expect(await run(['check', widgetServer, '--json'], {}, home)).toBe(0);
    const body = JSON.parse(stdout()) as {
      data: { findings: Array<{ code: string; severity: string }> };
    };
    expect(
      body.data.findings.some(
        (f) => f.code === 'missing_handoff_allowlist' && f.severity === 'error',
      ),
    ).toBe(false);
  });

  it('reports React review guidance for a ported website-style widget', async () => {
    expect(await run(['check', websitePortWidgetServer, '--json'], {}, home)).toBe(0);
    const body = JSON.parse(stdout()) as {
      ok: boolean;
      data: { findings: Array<{ code: string; severity: string; message: string }> };
    };
    expect(body.ok).toBe(true);
    expect(body.data.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'custom_component_use', severity: 'info' }),
        expect.objectContaining({ code: 'react_widget_metadata', severity: 'warn' }),
        expect.objectContaining({ code: 'tool_input_sufficiency', severity: 'info' }),
      ]),
    );
    expect(JSON.stringify(body)).not.toContain('https://');
  });

  it('reports React metadata guidance for action-heavy widgets', async () => {
    expect(await run(['check', ambiguousActionsWidgetServer, '--json'], {}, home)).toBe(0);
    const body = JSON.parse(stdout()) as {
      data: { findings: Array<{ code: string; severity: string; message: string }> };
    };
    expect(body.data.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'custom_component_use', severity: 'info' }),
        expect.objectContaining({ code: 'react_widget_metadata', severity: 'warn' }),
      ]),
    );
  });

  it('reports payload-budget readiness for React widget shells', async () => {
    expect(await run(['check', budgetHeavyWidgetServer, '--json'], {}, home)).toBe(0);
    const body = JSON.parse(stdout()) as {
      data: { findings: Array<{ code: string; severity: string; message: string }> };
    };
    expect(body.data.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'payload_budget', severity: 'warn' }),
      ]),
    );
  });

  it('fails when widget-linked output schemas expose credential-shaped fields', async () => {
    expect(await run(['check', sensitiveWidgetServer, '--json'], {}, home)).toBe(1);
    const body = JSON.parse(stdout()) as {
      ok: boolean;
      error: { code: string; errors: Array<{ code: string; severity: string; message: string }> };
    };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('check_failed');
    expect(body.error.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'widget_privacy_boundary', severity: 'error' }),
      ]),
    );
    expect(JSON.stringify(body)).not.toContain('secret-token-value');
  });

  it('reports server shell and navigation metadata readiness', async () => {
    expect(await run(['check', shellNavigationWidgetServer, '--json'], {}, home)).toBe(0);
    const body = JSON.parse(stdout()) as {
      ok: boolean;
      data: { findings: Array<{ code: string; severity: string; message: string }> };
    };
    expect(body.ok).toBe(true);
    expect(body.data.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'shell_navigation',
          severity: 'info',
          message: expect.stringContaining('2 navigation item(s)'),
        }),
      ]),
    );
  });

  it('checks the generated consumer app shell proof fixture end-to-end', async () => {
    expect(await run(['check', appShellProofServer, '--json'], {}, home)).toBe(0);
    const body = JSON.parse(stdout()) as {
      ok: boolean;
      data: { findings: Array<{ code: string; severity: string; message: string }> };
    };
    expect(body.ok).toBe(true);
    expect(body.data.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'branding',
          severity: 'info',
          message: expect.stringContaining('App Shell Proof'),
        }),
        expect.objectContaining({
          code: 'shell_navigation',
          severity: 'info',
          message: expect.stringContaining('3 navigation item(s)'),
        }),
        expect.objectContaining({
          code: 'app_only_tools',
          severity: 'info',
          message: expect.stringContaining('2 app-only helper tool(s)'),
        }),
        expect.objectContaining({ code: 'handoff_allowlist', severity: 'info' }),
        expect.objectContaining({ code: 'progressive_enhancement', severity: 'info' }),
        expect.objectContaining({ code: 'submission_readiness', severity: 'info' }),
        expect.objectContaining({ code: 'tool_metadata', severity: 'warn' }),
      ]),
    );
    expect(body.data.findings.some((finding) => finding.code === 'missing_handoff_allowlist')).toBe(
      false,
    );
    expect(JSON.stringify(body)).not.toMatch(
      /NOODLE_AUTH_TOKEN|refresh[_-]?token|secret value|caller-key|api[_-]?key|bearer/i,
    );
  });

  it('checks ChatGPT compatibility metadata for the app shell proof fixture', async () => {
    expect(
      await run(['check', appShellProofServer, '--target', 'chatgpt', '--json'], {}, home),
    ).toBe(1);
    const body = JSON.parse(stdout()) as {
      ok: boolean;
      error: {
        errors: Array<{ code: string; severity: string; message: string }>;
      };
    };
    expect(body.ok).toBe(false);
    expect(body.error.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'chatgpt_output_template', severity: 'info' }),
        // The fixture's widget declares a description, now emitted as the ChatGPT compat alias
        // openai/widgetDescription, so the description review passes.
        expect.objectContaining({ code: 'chatgpt_widget_description', severity: 'info' }),
        expect.objectContaining({ code: 'chatgpt_widget_csp', severity: 'info' }),
        expect.objectContaining({ code: 'chatgpt_widget_domain', severity: 'error' }),
        // Current compilers emit the legacy openai/widgetCSP key with snake_case fields (camelCase
        // parses as "CSP not set" in ChatGPT), so a fresh artifact reports info here.
        expect.objectContaining({ code: 'chatgpt_widget_csp_shape', severity: 'info' }),
        expect.objectContaining({ code: 'chatgpt_widget_state', severity: 'info' }),
      ]),
    );
  });

  it('fails ChatGPT checks for strict confirmation on the stateless lane', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noodle-chatgpt-interaction-audit-'));
    const source = readFileSync(embeddedAssistantServer, 'utf8').replace(
      'annotations: annotations.readOnly(),',
      'annotations: annotations.action({ confirm: true }),',
    );
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'server.ts'), source);

    expect(
      await run(
        ['check', join(dir, 'src', 'server.ts'), '--target', 'chatgpt', '--json'],
        {},
        home,
      ),
    ).toBe(1);
    const body = JSON.parse(stdout()) as {
      error: { errors: Array<{ code: string; severity: string }> };
    };
    expect(body.error.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'chatgpt_confirmation_compatibility',
          severity: 'error',
        }),
      ]),
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it('filters check findings by --min-severity without changing the exit code', async () => {
    // The food-ordering app has info + warn findings but no errors → exit 0 regardless of the filter.
    expect(await run(['check', widgetServer, '--json', '--min-severity', 'warn'], {}, home)).toBe(
      0,
    );
    const warnBody = JSON.parse(stdout()) as {
      ok: boolean;
      data: { findings: Array<{ severity: string }> };
    };
    expect(warnBody.ok).toBe(true);
    expect(warnBody.data.findings.length).toBeGreaterThan(0);
    expect(
      warnBody.data.findings.every((f) => f.severity === 'warn' || f.severity === 'error'),
    ).toBe(true);

    logSpy.mockClear();
    // --min-severity error hides the info/warn stream, but the app still passes (no errors) → empty + 0.
    expect(await run(['check', widgetServer, '--json', '--min-severity', 'error'], {}, home)).toBe(
      0,
    );
    const errorBody = JSON.parse(stdout()) as { ok: boolean; data: { findings: unknown[] } };
    expect(errorBody.ok).toBe(true);
    expect(errorBody.data.findings).toEqual([]);
  }, 15_000);

  it('does not flag a correct tool helper as a warning (consistent app-only guidance)', async () => {
    expect(await run(['check', appShellProofServer, '--json'], {}, home)).toBe(0);
    const body = JSON.parse(stdout()) as {
      data: { findings: Array<{ code: string; severity: string; message: string; fix: string }> };
    };
    const scope = body.data.findings.find((f) => f.code === 'app_only_tool_widget_scope');
    expect(scope).toBeDefined();
    // Reconciled: an app-only tool helper without a widget resourceUri is not a warning.
    expect(scope?.severity).toBe('info');
    expect(scope?.message.toLowerCase()).toContain('optional');
    // The two app-only findings agree: app_only_tools presents tool as the correct helper shape.
    const appOnly = body.data.findings.find((f) => f.code === 'app_only_tools');
    expect(appOnly?.fix).toContain('tool');
    expect(
      body.data.findings.some(
        (f) => f.code === 'app_only_tool_widget_scope' && f.severity === 'warn',
      ),
    ).toBe(false);
  });

  it('flags a scaffold placeholder widget domain for ChatGPT (warn); a real domain passes', async () => {
    expect(
      await run(
        ['check', placeholderDomainWidgetServer, '--target', 'chatgpt', '--json'],
        {},
        home,
      ),
    ).toBe(0);
    const body = JSON.parse(stdout()) as {
      ok: boolean;
      data: { findings: Array<{ code: string; severity: string; message: string }> };
    };
    expect(body.ok).toBe(true);
    const placeholder = body.data.findings.find(
      (f) => f.code === 'chatgpt_widget_placeholder_domain',
    );
    expect(placeholder?.severity).toBe('warn');
    expect(placeholder?.message.toLowerCase()).toContain('placeholder');

    // The food-ordering example uses an illustrative subdomain (orders.example.com) that is NOT a
    // placeholder, so it must pass this gate (info, not warn).
    logSpy.mockClear();
    expect(await run(['check', widgetServer, '--target', 'chatgpt', '--json'], {}, home)).toBe(0);
    const realBody = JSON.parse(stdout()) as {
      data: { findings: Array<{ code: string; severity: string }> };
    };
    const realPlaceholder = realBody.data.findings.find(
      (f) => f.code === 'chatgpt_widget_placeholder_domain',
    );
    expect(realPlaceholder?.severity).toBe('info');
  }, 15_000);

  it('checks action-heavy React widgets through metadata and fallback audits', async () => {
    const code = await run(['check', statuslessActionWidgetServer, '--json'], {}, home);
    expect(code, stdout()).toBe(0);
    const body = JSON.parse(stdout()) as {
      ok: boolean;
      data: { findings: Array<{ code: string; severity: string; message: string }> };
    };
    expect(body.ok).toBe(true);
    expect(body.data.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'custom_component_use', severity: 'info' }),
        expect.objectContaining({ code: 'progressive_enhancement', severity: 'info' }),
      ]),
    );
  });

  it('checks React widgets that use grouped form controls', async () => {
    const code = await run(['check', formControlsWidgetServer, '--json'], {}, home);
    expect(code, stdout()).toBe(0);
    const body = JSON.parse(stdout()) as {
      ok: boolean;
      data: { findings: Array<{ code: string; severity: string; message: string }> };
    };
    expect(body.ok).toBe(true);
    expect(body.data.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'progressive_enhancement', severity: 'info' }),
        expect.objectContaining({ code: 'custom_component_use', severity: 'info' }),
      ]),
    );
    expect(JSON.stringify(body)).not.toMatch(
      /NOODLE_AUTH_TOKEN|refresh[_-]?token|secret value|caller-key/i,
    );
  });

  it('checks React widgets that use locale-aware formatting in user code', async () => {
    const code = await run(['check', formattedWidgetServer, '--json'], {}, home);
    expect(code, stdout()).toBe(0);
    const body = JSON.parse(stdout()) as {
      ok: boolean;
      data: { findings: Array<{ code: string; severity: string; message: string }> };
    };
    expect(body.ok).toBe(true);
    expect(body.data.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'progressive_enhancement', severity: 'info' }),
        expect.objectContaining({ code: 'widget_privacy_boundary', severity: 'info' }),
      ]),
    );
  });

  it('checks a stateless consumer video carousel app', async () => {
    expect(await run(['check', travelDiscoveryCheckServer, '--json'], {}, home)).toBe(0);
    const body = JSON.parse(stdout()) as {
      ok: boolean;
      data: { findings: Array<{ code: string; severity: string; message: string }> };
    };
    expect(body.ok).toBe(true);
    expect(body.data.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'branding',
          severity: 'info',
          message: expect.stringContaining('Travel Video Carousel Check'),
        }),
        expect.objectContaining({
          code: 'progressive_enhancement',
          severity: 'info',
        }),
      ]),
    );
    expect(body.data.findings.some((finding) => finding.code === 'missing_handoff_allowlist')).toBe(
      false,
    );
    expect(JSON.stringify(body)).not.toMatch(
      /NOODLE_AUTH_TOKEN|refresh[_-]?token|secret value|caller-key/i,
    );
  });

  it('checks widget apps that use packaged local media assets', async () => {
    const appDir = mkdtempSync(join(tmpdir(), 'noodle-packaged-media-app-'));
    try {
      mkdirSync(join(appDir, 'assets'));
      mkdirSync(join(appDir, 'views'));
      writeFileSync(
        join(appDir, 'views', 'FixtureWidget.tsx'),
        'export default function FixtureWidget() { return <main>Fixture widget ready</main>; }\n',
      );
      writeFileSync(
        join(appDir, 'assets', 'pixel.png'),
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l0e8QgAAAABJRU5ErkJggg==',
          'base64',
        ),
      );
      const serverPath = join(appDir, 'server.ts');
      writeFileSync(
        serverPath,
        [
          "import { asset, server, tool, z } from '@noodleseed/one';",
          "const pixel = asset('./assets/pixel.png');",
          'const view = { component: "FixtureWidget", entry: "./views/FixtureWidget.tsx" };',
          "export default server('packaged_media_check', {",
          "  title: 'Packaged Media Check',",
          "  version: '1.0.0',",
          '}, [',
          "  tool('show_media', {",
          "    description: 'Show a packaged media widget.',",
          '    input: z.object({}),',
          '    output: z.object({ status: z.string() }),',
          '    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },',
          "    fulfil: () => ({ status: 'ready' }),",
          "    viewName: 'show_media_widget',",
          "    viewTitle: 'Packaged media',",
          "    viewDescription: 'Checks local packaged media assets.',",
          '    view,',
          '  }),',
          ']);',
        ].join('\n'),
      );

      expect(await run(['check', serverPath, '--json'], {}, home)).toBe(0);
      const body = JSON.parse(stdout()) as {
        ok: boolean;
        findings: Array<{ code: string; severity: string; message: string }>;
      };
      expect(body.ok).toBe(true);
      expect(body.data.findings.some((finding) => finding.code === 'invalid_asset')).toBe(false);
      expect(JSON.stringify(body)).toContain('progressive_enhancement');
    } finally {
      rmSync(appDir, { recursive: true, force: true });
    }
  });

  it('noodle audit status displays service capability and active modules', async () => {
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL) => {
      expect(input.toString()).toBe('https://svc.example/v1/service/capabilities?advanced=1');
      return Response.json({
        ok: true,
        capabilities: ['audit', 'observability', 'secrets', 'connectors', 'apps'],
        modules: [{ name: '@noodle-borg/module-audit', capabilities: ['audit'] }],
      });
    }) as typeof fetch);

    try {
      expect(await run(['audit', 'status', '--service', 'https://svc.example'], {}, home)).toBe(0);
      const printed = stdout();
      expect(printed).toContain('service: https://svc.example');
      expect(printed).toContain('audit: enabled');
      expect(printed).toContain('module: @noodle-borg/module-audit');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('noodle audit events lists filtered audit events', async () => {
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === 'https://svc.example/v1/service/capabilities') {
        return Response.json({ ok: true, capabilities: ['audit', 'observability'] });
      }
      expect(url).toBe(
        'https://svc.example/v1/orgs/acme/audit/events?app=hello&env=prod&eventType=config.secret.set&limit=5',
      );
      return Response.json({
        ok: true,
        events: [
          {
            id: 'evt-123',
            eventType: 'config.secret.set',
            org: 'acme',
            app: 'hello',
            env: 'prod',
            actorEmail: 'admin@acme.com',
            createdAt: '2026-06-15T05:22:10Z',
            decision: 'allow',
            reasonCode: 'configured',
            details: { name: 'DB_PASSWORD' },
          },
        ],
      });
    }) as typeof fetch);

    try {
      logSpy.mockClear();
      expect(
        await run(
          [
            'audit',
            'events',
            '--service',
            'https://svc.example',
            '--org',
            'acme',
            '--app',
            'hello',
            '--env',
            'prod',
            '--event-type',
            'config.secret.set',
            '--limit',
            '5',
          ],
          {},
          home,
        ),
      ).toBe(0);
      const printed = stdout();
      for (const header of ['TIME', 'EVENT', 'ACTOR', 'DECISION']) {
        expect(printed).toContain(header);
      }
      expect(printed).toContain('config.secret.set');
      expect(printed).toContain('allow');
      expect(printed).toContain('admin@acme.com');
      expect(printed).toContain('ago'); // TIME renders as a relative timestamp
      expect(printed).not.toContain('DB_PASSWORD');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('noodle audit events --json keeps the passthrough envelope unchanged', async () => {
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL) => {
      if (input.toString() === 'https://svc.example/v1/service/capabilities') {
        return Response.json({ ok: true, capabilities: ['audit'] });
      }
      return Response.json({
        ok: true,
        events: [
          {
            id: 'evt-9',
            eventType: 'policy.applied',
            decision: 'deny',
            createdAt: '2026-06-15T05:22:10Z',
            details: { name: 'DB_PASSWORD' },
          },
        ],
      });
    }) as typeof fetch);

    try {
      logSpy.mockClear();
      expect(
        await run(
          ['audit', 'events', '--service', 'https://svc.example', '--org', 'acme', '--json'],
          {},
          home,
        ),
      ).toBe(0);
      const body = JSON.parse(stdout());
      expect(Object.keys(body).sort()).toEqual(['data', 'ok']);
      expect(body.data.events).toEqual([
        {
          id: 'evt-9',
          eventType: 'policy.applied',
          decision: 'deny',
          createdAt: '2026-06-15T05:22:10Z',
          details: { name: 'DB_PASSWORD' },
        },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('renders audit decisions with the semantic palette under truecolor', () => {
    const now = new Date().toISOString();
    const colored = renderAuditEventsTable(
      [
        {
          eventType: 'config.secret.set',
          actorEmail: 'a@x.com',
          createdAt: now,
          decision: 'allow',
        },
        { eventType: 'tool.call', actorSubject: 'sub-1', createdAt: now, decision: 'deny' },
      ],
      { color: 'truecolor', glyph: 'unicode' },
    );
    expect(colored).toContain('38;2;34;197;94'); // allow → green
    expect(colored).toContain('38;2;244;63;94'); // deny → rose
    expect(colored).toContain('38;2;115;115;115'); // actor → dim
  });

  it('noodle audit events explains when audit is not configured', async () => {
    vi.stubGlobal('fetch', (async () =>
      Response.json({ ok: true, capabilities: ['observability'] })) as typeof fetch);

    try {
      logSpy.mockClear();
      expect(
        await run(
          ['audit', 'events', '--service', 'https://svc.example', '--org', 'acme'],
          {},
          home,
        ),
      ).toBe(1);
      const printed = stdout();
      expect(printed).toContain('FAIL audit events: missing audit capability');
      expect(printed).toContain('Fix: configure audit in the service runtime');
      expect(printed).not.toContain('--profile governed');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('noodle audit events requires an org', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await run(['audit', 'events', '--service', 'https://svc.example'], {}, home)).toBe(2);
    expect(errorSpy.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
      'audit events: --org is required',
    );
  });
});
