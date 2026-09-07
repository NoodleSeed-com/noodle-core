import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const guideUrl = new URL('../../../apps/docs/content/guides/machine-auth.mdx', import.meta.url);
const navUrl = new URL('../../../apps/docs/content/guides/meta.json', import.meta.url);
const deployGuideUrl = new URL('../../../apps/docs/content/guides/deploy.mdx', import.meta.url);

describe('published machine-auth guide contract', () => {
  const guide = existsSync(guideUrl) ? readFileSync(guideUrl, 'utf8') : '';
  const nav = JSON.parse(readFileSync(navUrl, 'utf8')) as { readonly pages: readonly string[] };
  const deployGuide = readFileSync(deployGuideUrl, 'utf8');

  it('is discoverable from guide navigation and the deploy journey', () => {
    expect(guide).not.toBe('');
    expect(nav.pages).toContain('machine-auth');
    expect(nav.pages.indexOf('customer-auth')).toBeLessThan(nav.pages.indexOf('machine-auth'));
    expect(nav.pages.indexOf('machine-auth')).toBeLessThan(nav.pages.indexOf('deploy'));
    expect(deployGuide).toContain('/docs/guides/machine-auth');
  });

  it('states the product boundary and current maturity', () => {
    expect(guide).toMatch(/Preview/i);
    expect(guide).toMatch(/organization-owned/i);
    expect(guide).toMatch(/one app and one environment/i);
    expect(guide).toMatch(/no (?:app-code|application-code|code) change/i);
    expect(guide).toMatch(/no redeploy/i);
    expect(guide).toMatch(/existing deployments/i);
    expect(guide).toMatch(/interactive OAuth clients/i);
  });

  it('documents the safe credential and token contract', () => {
    for (const term of [
      'private_key_jwt',
      'client_secret_basic',
      'grant_type=client_credentials',
      'resource-bound',
      'short-lived',
      'RS256',
      'ES256',
    ]) {
      expect(guide).toContain(term);
    }
    expect(guide).not.toContain('client_secret_post');
    expect(guide).toMatch(/never forwarded/i);
  });

  it.each([
    'noodle auth service-principals create',
    'noodle auth service-principals grant',
    'noodle auth service-principals add-jwk',
    'noodle auth service-principals create-secret',
    'noodle auth service-principals revoke-credential',
    'noodle auth service-principals revoke-grant',
    'noodle auth service-principals revoke',
    'pnpm smoke:mcp-client-credentials',
  ])('covers the %s lifecycle command', (command) => {
    expect(guide).toContain(command);
  });

  it('uses the automatic dual-era client path and a read-only example', () => {
    expect(guide).toContain("versionNegotiation: { mode: 'auto' }");
    expect(guide).toContain("scope: 'reports.read'");
    expect(guide).toContain("name: 'generate_report'");
    expect(guide).toMatch(/read-only/i);
  });

  it('distinguishes machine access from human, customer, and connector authentication', () => {
    expect(guide).toMatch(/ChatGPT[\s\S]{0,120}interactive/i);
    expect(guide).toMatch(/customer auth/i);
    expect(guide).toMatch(/connector credential/i);
  });
});
