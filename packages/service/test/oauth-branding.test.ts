import { describe, expect, it } from 'vitest';
import { renderOAuthErrorPage, renderOAuthPage } from '../src/oauth/branding.js';
import { renderConsentPage } from '../src/oauth/consent.js';

const consent = (over: Partial<Parameters<typeof renderConsentPage>[0]> = {}): string =>
  renderConsentPage({
    clientName: 'Claude Code',
    resourceHost: 'acme.mcp.noodleseed.dev',
    redirectHost: 'claude.ai',
    userEmail: 'dev@acme.com',
    consentToken: 'tok-123',
    consentAction: '/oauth/consent',
    ...over,
  });

describe('branded consent page', () => {
  it('preserves the OAuth form contract the flow depends on', () => {
    const html = consent();
    // The end-to-end flow parses this exact attribute pair to POST the decision.
    expect(html).toContain('name="consent_token" value="tok-123"');
    expect(html).toMatch(/name="decision" value="approve"/);
    expect(html).toMatch(/name="decision" value="deny"/);
    expect(html).toContain('action="/oauth/consent"');
    expect(html).toContain('Claude Code');
    expect(html).toContain('dev@acme.com');
    expect(html).toContain('acme.mcp.noodleseed.dev');
    expect(html).not.toContain('value="switch_account"');
  });

  it('offers account switching only when the signed WorkOS flow allows it', () => {
    const html = consent({ allowAccountSwitch: true });

    expect(html).toContain('<button type="submit" name="decision" value="switch_account"');
    expect(html).toContain('Use another account');
  });

  it('carries the Noodle Seed website branding', () => {
    const html = consent();
    expect(html).toContain('Noodle Seed'); // wordmark (logo aria-label)
    expect(html).toContain('viewBox="0 0 250 39"'); // the actual site wordmark SVG
    expect(html).toContain('family=Geist'); // single Geist typeface
    expect(html).not.toContain('Instrument Serif'); // no second font
    expect(html).toContain('#F97316'); // warm brand orange from the "Mars" ramp
    expect(html).toContain('id="ns-canvas"'); // inline WebGL grain-gradient canvas
    expect(html).toContain('gl_FragColor'); // our own GLSL shader, inlined (no CDN/import)
    expect(html).not.toContain('paper-design'); // reverted off the CDN shader
    expect(html).toContain('rel="icon"'); // Noodle Seed favicon
    expect(html).toContain('btn-primary'); // premium glow CTA on Approve
  });

  it('escapes untrusted client-supplied values (no HTML injection)', () => {
    const html = consent({ clientName: '<img src=x onerror=alert(1)>' });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });
});

describe('branded shell + error page', () => {
  it('renders a titled, kicker-led card around caller content', () => {
    const html = renderOAuthPage({
      title: 'Hello — Noodle Seed',
      kicker: 'Test',
      heading: 'A heading',
      contentHtml: '<p class="ns-lede">Body copy.</p>',
    });
    expect(html).toContain('<title>Hello — Noodle Seed</title>');
    expect(html).toContain('A heading');
    expect(html).toContain('Body copy.');
    expect(html).toContain('class="ns-card"');
  });

  it('appends an optional script block before </body>', () => {
    const html = renderOAuthPage({
      title: 't',
      kicker: 'k',
      heading: 'h',
      contentHtml: '',
      scriptHtml: '<script>window.__x=1</script>',
    });
    expect(html).toContain('<script>window.__x=1</script>');
    expect(html.indexOf('<script>window.__x=1</script>')).toBeLessThan(html.indexOf('</body>'));
  });

  it('appends optional page-specific styles inside the document head', () => {
    const html = renderOAuthPage({
      title: 't',
      kicker: 'k',
      heading: 'h',
      contentHtml: '',
      additionalStyles: '.developer-grant{display:block}',
    });

    expect(html).toContain('.developer-grant{display:block}</style>');
  });

  it('keeps tall authorization cards reachable', () => {
    const html = renderOAuthPage({
      title: 't',
      kicker: 'k',
      heading: 'h',
      contentHtml: '',
    });

    expect(html).toContain('overflow:auto');
    expect(html).toContain('margin:auto 0');
    expect(html).not.toContain('place-items:center;padding:24px;position:relative;overflow:hidden');
  });

  it('renders a branded error interstitial', () => {
    const html = renderOAuthErrorPage();
    expect(html).toContain('Noodle Seed');
    expect(html).toContain('ns-bg');
    expect(html).toContain('We hit a snag');
  });
});
