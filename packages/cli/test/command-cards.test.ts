import { describe, expect, it } from 'vitest';
import { renderStatusCard, type StatusResponse } from '../src/commands/deploy-status-ops.js';
import { type InspectResponse, renderInspectCard } from '../src/commands/diagnostics-ops.js';
import { renderGithubStatusCard } from '../src/commands/github-ops.js';
import { renderTargetShowCard, renderWhoamiCard } from '../src/commands/session.js';

/**
 * The pure per-command detail-card renderers (`status`, `inspect`, `whoami`, `target show`,
 * `github status`), exercised directly with explicit color/glyph options — command-level tests run
 * under spied non-TTY stdout where color is always 'none', so tone SGR assertions live here.
 */

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const strip = (s: string): string => s.replace(ANSI, '');

const GREEN = '38;2;34;197;94';
const AMBER = '38;2;245;158;11';
const ROSE = '38;2;244;63;94';
const DIM = '38;2;115;115;115';
const ORANGE = '38;2;249;115;22';

const NOW = Date.parse('2026-07-06T12:00:00.000Z');

const STATUS_BODY: StatusResponse = {
  ok: true,
  target: { org: 'acme', app: 'support-bot', env: 'prod' },
  deployment: {
    deploymentId: 'support-bot-prod-8f31c2',
    endpointUrl: 'https://svc.example/o/acme/support-bot/prod/mcp',
    serverVersion: '3',
    active: true,
    serverName: 'support_bot',
    createdAt: '2026-07-06T10:00:00.000Z',
    createdByEmail: 'owner@acme.test',
    accessMode: 'org-members',
    ownerSubject: 'oauth-human',
  },
  health: { state: 'ready' },
  config: { ok: true, missingSecrets: [] },
};

describe('renderStatusCard', () => {
  it('renders the org/app/env title, semantic rows, provenance notes, and the NEXT footer', () => {
    const out = renderStatusCard(
      STATUS_BODY,
      'https://svc.example',
      {
        color: 'none',
        glyph: 'unicode',
      },
      NOW,
    );
    const lines = out.split('\n');
    expect(lines[0]).toBe('acme/support-bot/prod');
    expect(out).toMatch(/deployment\s+support-bot-prod-8f31c2 \(v3\)/);
    expect(out).toMatch(/state\s+● active/);
    expect(out).toMatch(/endpoint\s+https:\/\/svc\.example\/o\/acme\/support-bot\/prod\/mcp/);
    expect(out).toMatch(/access\s+org-members —/);
    expect(out).toMatch(/owner\s+oauth-human/);
    expect(out).toMatch(/deployed\s+2h ago by owner@acme\.test/);
    expect(out).toMatch(/health\s+ready/);
    expect(out).toMatch(/service\s+https:\/\/svc\.example/);
    expect(out).toContain('NEXT  noodle logs --tail · noodle metrics · noodle github runs');
  });

  it('tones: active green + orange title + amber access under truecolor; inactive is dim', () => {
    const colored = renderStatusCard(
      STATUS_BODY,
      'https://svc.example',
      {
        color: 'truecolor',
        glyph: 'unicode',
      },
      NOW,
    );
    expect(colored).toContain(ORANGE);
    expect(colored).toContain(`${GREEN}m● active`);
    expect(colored).toContain(`${AMBER}morg-members`);
    expect(strip(colored)).toBe(
      renderStatusCard(
        STATUS_BODY,
        'https://svc.example',
        { color: 'none', glyph: 'unicode' },
        NOW,
      ),
    );

    const inactive = renderStatusCard(
      {
        ...STATUS_BODY,
        deployment: { ...STATUS_BODY.deployment, active: false },
        health: { state: 'failing' },
      },
      'https://svc.example',
      { color: 'truecolor', glyph: 'unicode' },
      NOW,
    );
    expect(inactive).toContain(`${DIM}minactive`);
    expect(inactive).toContain(`${ROSE}mfailing`);
  });

  it('surfaces missing secrets as a bad-tone row', () => {
    const out = renderStatusCard(
      { ...STATUS_BODY, config: { ok: false, missingSecrets: ['API_TOKEN'] } },
      'https://svc.example',
      { color: 'none', glyph: 'unicode' },
      NOW,
    );
    expect(out).toMatch(/secrets\s+missing API_TOKEN/);
  });
});

const INSPECT_BODY: InspectResponse = {
  ok: true,
  target: { org: 'acme', app: 'hello', env: 'prod' },
  deployment: {
    deploymentId: 'hello-12345678',
    endpointUrl: 'https://svc.example/o/acme/hello/mcp',
    active: true,
    accessMode: 'owner-only',
    ownerSubject: 'oauth-human',
    serverName: 'hello',
    createdAt: '2026-06-29T00:00:00.000Z',
  },
  health: { state: 'ready', missingSecrets: [] },
  surface: {
    tools: [{ name: 'greet' }],
    resources: [{ uri: 'docs://hello' }],
    prompts: [{ name: 'brief' }],
    widgets: [],
    widgetLinkedTools: [],
    appOnlyTools: [],
    compatibility: { mcpApps: 'pass', chatgpt: 'pass', claude: 'pass' },
  },
  findings: [{ level: 'warn', code: 'widget_csp', message: 'no CSP metadata' }],
};

describe('renderInspectCard', () => {
  it('maps every printed field onto rows — nothing dropped — with findings as toned rows', () => {
    const out = renderInspectCard(INSPECT_BODY, 'https://svc.example', {
      color: 'none',
      glyph: 'unicode',
    });
    expect(out.split('\n')[0]).toBe('acme/hello/prod');
    expect(out).toMatch(/deployment\s+hello-12345678/);
    expect(out).toMatch(/state\s+● active/);
    expect(out).toMatch(/access\s+owner-only —/);
    expect(out).toMatch(/owner\s+oauth-human/);
    expect(out).toMatch(/health\s+ready/);
    expect(out).toMatch(/tools\s+greet/);
    expect(out).toMatch(/resources\s+docs:\/\/hello/);
    expect(out).toMatch(/prompts\s+brief/);
    expect(out).toMatch(/widgets\s+\(none\)/);
    expect(out).toMatch(/compat\s+mcpApps=pass chatgpt=pass claude=pass/);
    expect(out).toMatch(/service\s+https:\/\/svc\.example/);
    expect(out).toMatch(/WARN\s+widget_csp: no CSP metadata/);
    expect(out).toContain('NEXT  noodle smoke · noodle open');
  });

  it('tones findings (warn amber, fail rose) and missing secrets rose under truecolor', () => {
    const colored = renderInspectCard(
      {
        ...INSPECT_BODY,
        health: { state: 'ready', missingSecrets: ['API_TOKEN'] },
        findings: [
          { level: 'warn', code: 'w', message: 'warn finding' },
          { level: 'fail', code: 'f', message: 'fail finding' },
        ],
      },
      'https://svc.example',
      { color: 'truecolor', glyph: 'unicode' },
    );
    expect(colored).toContain(`${AMBER}mw: warn finding`);
    expect(colored).toContain(`${ROSE}mf: fail finding`);
    expect(colored).toContain(`${ROSE}mmissing API_TOKEN`);
  });
});

describe('renderWhoamiCard', () => {
  it('titles with the identity email and lists service/token/subject/admin/orgs rows', () => {
    const out = renderWhoamiCard(
      {
        serviceUrl: 'https://cloud.noodleseed.dev',
        token: 'fake-token-for-test',
        identity: { email: 'owner@acme.test', subject: 'sub-1', superAdmin: false },
        orgs: ['acme', 'beta'],
      },
      { color: 'none', glyph: 'unicode' },
    );
    expect(out.split('\n')[0]).toBe('owner@acme.test');
    expect(out).toMatch(/service\s+https:\/\/cloud\.noodleseed\.dev/);
    expect(out).toMatch(/token\s+fake…st/);
    expect(out).not.toContain('fake-token-for-test');
    expect(out).toMatch(/subject\s+sub-1/);
    expect(out).toMatch(/admin\s+no/);
    expect(out).toMatch(/orgs\s+acme, beta/);
    expect(out).toContain('NEXT  noodle target show');
  });

  it('signed-out renders a not-signed-in card pointing at noodle login', () => {
    const out = renderWhoamiCard(
      { serviceUrl: 'https://cloud.noodleseed.dev', token: undefined },
      { color: 'none', glyph: 'unicode' },
    );
    expect(out.split('\n')[0]).toBe('not signed in');
    expect(out).toMatch(/token\s+\(none\)/);
    expect(out).toContain('NEXT  noodle login');
  });
});

describe('renderTargetShowCard', () => {
  const target = {
    runtime: { value: 'cloud', source: 'config' as const },
    service: { value: 'https://cfg.example', source: 'config' as const },
    org: { value: 'acme', source: 'config' as const },
    app: { value: null, source: 'unset' as const },
    env: { value: 'prod', source: 'default' as const },
  };

  it('titles with the effective org/app/env and annotates each row with its dim source', () => {
    const out = renderTargetShowCard(target, { color: 'none', glyph: 'unicode' });
    expect(out.split('\n')[0]).toBe('acme/—/prod');
    expect(out).toMatch(/runtime\s+cloud \(from config\)/);
    expect(out).toMatch(/org\s+acme \(from config\)/);
    expect(out).toMatch(/app\s+—$/m);
    expect(out).toMatch(/env\s+prod \(default\)/);
    expect(out).toContain('NEXT  noodle target set --org <org>');
  });

  it('unset rows render dim under truecolor; ASCII glyphs replace the em dash', () => {
    const colored = renderTargetShowCard(target, { color: 'truecolor', glyph: 'unicode' });
    expect(colored).toContain(`${DIM}m—`);
    const ascii = renderTargetShowCard(target, { color: 'none', glyph: 'ascii' });
    expect(ascii).not.toContain(ESC);
    expect(ascii.split('\n')[0]).toBe('acme/-/prod');
  });
});

describe('renderGithubStatusCard', () => {
  const record = {
    githubRepositoryId: 1001,
    installationId: 111,
    ownerLogin: 'acme-gh',
    repoName: 'acme-gh/widgets',
    defaultBranch: 'main',
    orgSlug: 'acme',
    appSlug: 'support-bot',
    enabled: true,
    createdBySubject: 'sub-1',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  };

  it('connected: repo title, branch → prod, green connected dot, dim installation, toned last run', () => {
    const out = renderGithubStatusCard(
      {
        org: 'acme',
        app: 'support-bot',
        record,
        lastRun: {
          runId: 'r1',
          orgSlug: 'acme',
          appSlug: 'support-bot',
          envName: 'prod',
          sourceEvent: 'push',
          deliveryId: 'd1',
          githubRepositoryId: 1001,
          commitSha: 'abcdef1234567890',
          ref: 'refs/heads/main',
          status: 'failed',
          actorLogin: 'octocat',
          createdAt: '2026-07-06T11:00:00.000Z',
        },
      },
      { color: 'none', glyph: 'unicode' },
      NOW,
    );
    expect(out.split('\n')[0]).toBe('acme-gh/widgets');
    expect(out).toMatch(/target\s+acme\/support-bot/);
    expect(out).toMatch(/branch\s+main → prod/);
    expect(out).toMatch(/state\s+● connected/);
    expect(out).toMatch(/installation\s+111 \(repo #1001\)/);
    expect(out).toMatch(/last run\s+abcdef1 → prod \(failed, 1h ago\)/);
    expect(out).toContain('NEXT  noodle github runs');
  });

  it('tones: connected green, failed run rose, deployed run green; no runs is a dim placeholder', () => {
    const base = { org: 'acme', app: 'support-bot', record };
    const failed = renderGithubStatusCard(
      {
        ...base,
        lastRun: {
          runId: 'r',
          orgSlug: 'acme',
          appSlug: 'support-bot',
          envName: 'prod',
          sourceEvent: 'push' as const,
          deliveryId: 'd',
          githubRepositoryId: 1,
          commitSha: 'abcdef1',
          ref: 'r',
          status: 'failed' as const,
          actorLogin: 'a',
          createdAt: '2026-07-06T11:00:00.000Z',
        },
      },
      { color: 'truecolor', glyph: 'unicode' },
      NOW,
    );
    expect(failed).toContain(`${GREEN}m● connected`);
    expect(failed).toContain(`${ROSE}mabcdef1`);

    const noRuns = renderGithubStatusCard(base, { color: 'none', glyph: 'unicode' }, NOW);
    expect(noRuns).toMatch(/last run\s+— \(no deploy runs yet\)/);
  });

  it('not connected: org/app title with an attention state and the connect pointer', () => {
    const out = renderGithubStatusCard(
      { org: 'acme', app: 'never' },
      { color: 'none', glyph: 'unicode' },
      NOW,
    );
    expect(out.split('\n')[0]).toBe('acme/never');
    expect(out).toMatch(/state\s+not connected/);
    expect(out).toContain('NEXT  noodle github connect');
    const colored = renderGithubStatusCard(
      { org: 'acme', app: 'never' },
      { color: 'truecolor', glyph: 'unicode' },
      NOW,
    );
    expect(colored).toContain(`${AMBER}mnot connected`);
  });
});
