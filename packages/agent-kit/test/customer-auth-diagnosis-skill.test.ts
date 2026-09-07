import { describe, expect, it } from 'vitest';
import { renderAgentFiles } from '../src/index.js';

function reference(name: string): string {
  const file = renderAgentFiles({}).find((candidate) =>
    candidate.path.endsWith(`/references/${name}.md`),
  );
  expect(file, `missing ${name} reference`).toBeDefined();
  return file?.content ?? '';
}

function example(name: string): string {
  const file = renderAgentFiles({}).find((candidate) =>
    candidate.path.endsWith(`/examples/${name}/README.md`),
  );
  expect(file, `missing ${name} example`).toBeDefined();
  return file?.content ?? '';
}

describe('customer-auth diagnosis guidance', () => {
  it('prefers same-origin authorization UI and explains the cross-site boundary', () => {
    const authoring = reference('authoring-workflow');

    expect(authoring).toContain(
      'The MCP client, or Devtools during local testing, opens the configured `authorization_endpoint`',
    );
    expect(authoring).toContain(
      "Noodle does not submit the login form or manage the authorization server's session or CSRF cookies.",
    );
    expect(authoring).toContain(
      'Keep the login and consent UI plus credential POST on the same origin as the authorization endpoint.',
    );
    expect(authoring).toContain('Cookies cannot be shared across unrelated registrable domains.');
    expect(authoring).toContain('`SameSite=None; Secure`');
  });

  it('teaches provider-neutral readiness, interactive sign-in, and authenticated tool evidence', () => {
    const authoring = reference('authoring-workflow');
    const verification = reference('verify-and-recover');
    const rendered = `${authoring}\n${verification}`;

    expect(rendered).toContain('noodle auth doctor src/server.ts --json');
    expect(rendered).toContain('metadata and JWKS readiness');
    expect(rendered).toContain('does not prove that registration or token issuance succeeds');
    expect(rendered).toContain('run `noodle devtools src/server.ts`');
    expect(rendered).toContain('one authenticated `tools/list` request');
    expect(rendered).toContain('issuer, signature, stable audience, and exact-resource binding');
    expect(rendered).not.toMatch(/supabase/iu);
  });

  it('keeps local OIDC sign-in separate from development-only delegated assertion trust', () => {
    const authoring = reference('authoring-workflow');

    expect(authoring).toContain(
      'Local customer OIDC sign-in and delegated-exchange assertion trust are two distinct boundaries.',
    );
    expect(authoring).toContain(
      'Start Devtools, complete customer sign-in, and copy the displayed `{ issuer, jwks }` from **Local delegated exchange**.',
    );
    expect(authoring).toContain(
      'Pin both values only in the customer-owned development RFC 8693 token endpoint.',
    );
    expect(authoring).toContain(
      'Do not add the Devtools assertion key to OIDC issuer metadata or change its signing keys.',
    );
    expect(authoring).toContain(
      'Never trust the Devtools issuer in production: anyone holding the local private key could impersonate a customer.',
    );
    expect(authoring).toContain(
      'Use hosted preview or `noodle auth doctor --live` to prove the production platform issuer.',
    );
  });

  it('requires a real customer identity producer before delegated token exchange can deploy', () => {
    const authoring = reference('authoring-workflow');
    const readme = example('customer-auth');

    for (const rendered of [authoring, readme]) {
      const normalized = rendered.replace(/\s+/gu, ' ');
      expect(normalized).toContain(
        '`delegatedTokenExchange` consumes a verified customer caller; an MCP access mode does not create one.',
      );
      expect(normalized).toContain('`delegated_token_exchange_identity_required`');
      expect(normalized).toContain('`customerAuth.*(...)` or `embeddedAssistant(...)`');
      expect(normalized).toContain(
        'A successful local Devtools exchange is not evidence that the hosted server has an identity source.',
      );
    }
  });

  it('bundles the one canonical local delegated-exchange setup path without a new surface', () => {
    const readme = example('customer-auth');

    expect(readme).toContain(
      'At both connector and operation level, auth must be omitted or use `delegatedTokenExchange`.',
    );
    expect(readme).toContain(
      'Local customer OIDC sign-in and delegated-exchange assertion trust are two distinct boundaries.',
    );
    expect(readme).toContain(
      'Start Devtools, complete customer sign-in, and copy the displayed `{ issuer, jwks }` from **Local delegated exchange**.',
    );
    expect(readme).toContain(
      'Pin both values only in the customer-owned development RFC 8693 token endpoint.',
    );
    expect(readme).toContain(
      'Never trust the Devtools issuer in production: anyone holding the local private key could impersonate a customer.',
    );
    expect(readme).toContain(
      'Use hosted preview or `noodle auth doctor --live` to prove the production platform issuer.',
    );
    expect(readme).not.toMatch(/--(?:local|devtools)-delegated/iu);
    expect(readme).not.toMatch(/NOODLE_(?:LOCAL|DEVTOOLS)_DELEGATED/iu);
  });

  it('bundles a client-specific audience map for the Supabase example', () => {
    const readme = example('customer-auth');

    expect(readme).toContain('mcp_oauth_client_audiences');
    expect(readme).toContain('where mapping.client_id = oauth_client_id');
    expect(readme).toContain('if mapped_audience is not null then');
    expect(readme).toContain('Unrelated or unknown OAuth client');
    expect(readme).toContain('Browser session');
  });

  it('diagnoses unexpected protected-resource issuers before changing auth', () => {
    const troubleshooting = reference('troubleshooting');

    expect(troubleshooting).toContain(
      'noodle deployments list --org <org> --app <app> --env <env> --json',
    );
    expect(troubleshooting).toContain('exact active deployment');
    expect(troubleshooting).toContain(
      'does not select the MCP access mode or authorization server',
    );
    expect(troubleshooting).toContain(
      'Direct or federated customer auth must advertise the configured tenant issuer',
    );
    expect(troubleshooting).toContain(
      'a managed Noodle bridge must advertise the Noodle authorization server',
    );
    expect(troubleshooting).toContain('customer_auth_state_inconsistent');
    expect(troubleshooting).toContain('Do not proxy, rewrite, rotate, or redeploy');
    expect(troubleshooting).toContain(
      'Never share bearer tokens, refresh tokens, client secrets, or credential files',
    );
  });

  it('keeps embedded-assistant auth separate and routes detailed diagnosis once', () => {
    const embeddedAssistant = reference('embedded-assistant');

    expect(embeddedAssistant).toContain(
      'does not select direct MCP access or protected-resource discovery',
    );
    expect(embeddedAssistant).toContain('references/troubleshooting.md');
    expect(embeddedAssistant).not.toContain('customer_auth_state_inconsistent');
  });
});
