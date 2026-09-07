import type { RuntimeArtifact } from '@noodle-borg/compiler';
import { describe, expect, it } from 'vitest';
import { auditEmbeddedAssistant } from '../src/audit-embedded-assistant.js';

/**
 * The public-surface half of `noodle check --target embedded-assistant`.
 *
 * Reporting, not enforcement. `check` runs a full compile and returns early on failure, and the compiler
 * already refuses a public surface that selects an identity-touching capability or omits its allowlist —
 * so a finding mirroring those invariants could never fire. What is worth reporting is what the compiler
 * cannot decide: what this surface will actually expose to strangers, and what the embedding page must
 * allow for it to work at all.
 */

const MODEL = {
  kind: 'openai-compatible',
  baseUrl: 'https://models.test/v1',
  model: 'm',
  apiKey: 'K',
};

function artifact(assistant: Record<string, unknown> | undefined): RuntimeArtifact {
  return {
    server: {
      name: 'acme',
      ...(assistant ? { assistant: { model: MODEL, allowedOrigins: [], ...assistant } } : {}),
    },
    tools: [],
    resources: [],
  } as unknown as RuntimeArtifact;
}

const PUBLIC_SURFACE = {
  mode: 'public',
  origins: ['https://www.acme.test'],
  capabilities: [
    { kind: 'tool', name: 'ask_product' },
    { kind: 'tool', name: 'request_demo' },
  ],
};

const find = (art: RuntimeArtifact, code: string) =>
  auditEmbeddedAssistant(art).find((finding) => finding.code === code);

describe('public website surface findings', () => {
  it('spells out what a stranger can reach, so the attack surface reads in one line', () => {
    const finding = find(artifact({ surfaces: [PUBLIC_SURFACE] }), 'assistant_public_surface');

    expect(finding?.severity).toBe('info');
    expect(finding?.message).toContain('https://www.acme.test');
    expect(finding?.message).toContain('ask_product, request_demo');
  });

  it('says nothing about public surfaces when the app declares none', () => {
    const authenticatedOnly = artifact({
      surfaces: [{ mode: 'authenticated', origins: ['https://app.acme.test'] }],
    });
    expect(find(authenticatedOnly, 'assistant_public_surface')).toBeUndefined();
    expect(find(authenticatedOnly, 'assistant_public_disclosure')).toBeUndefined();
  });

  it('reports a mixed surface as public-facing too', () => {
    const finding = find(
      artifact({ surfaces: [{ ...PUBLIC_SURFACE, mode: 'mixed' }] }),
      'assistant_public_surface',
    );
    // Sign-in widens what a visitor reaches after elevation; it does not stop strangers arriving.
    expect(finding?.message).toContain('mixed');
  });

  /**
   * A public assistant collects whatever a stranger types. Shipping one with no privacy link is a
   * compliance problem the author will hear about from someone other than us.
   */
  it('warns when a public surface has no privacy link', () => {
    const finding = find(artifact({ surfaces: [PUBLIC_SURFACE] }), 'assistant_public_disclosure');

    expect(finding?.severity).toBe('warn');
    expect(finding?.fix).toContain('privacyUrl');
  });

  it('is satisfied once privacyUrl is declared', () => {
    const finding = find(
      artifact({ surfaces: [PUBLIC_SURFACE], privacyUrl: 'https://acme.test/privacy' }),
      'assistant_public_disclosure',
    );
    expect(finding?.severity).toBe('info');
  });

  /**
   * The undetectable half of a CSP failure: if the page's `script-src` blocks the embed script, no
   * widget code exists to complain. Saying it here, before deploy, is the only place it can be said.
   */
  it('names the CSP directives an embedding page must allow', () => {
    const finding = find(artifact({ surfaces: [PUBLIC_SURFACE] }), 'assistant_public_csp');

    expect(finding?.message).toContain('script-src');
    expect(finding?.message).toContain('connect-src');
    expect(finding?.message).toContain('frame-src');
  });

  it('points at the live budget rather than restating a number that may be overridden', () => {
    const finding = find(artifact({ surfaces: [PUBLIC_SURFACE] }), 'assistant_public_budget');

    expect(finding?.severity).toBe('info');
    // The deployed value can differ from any default this reports, so it sends the reader to the
    // command that knows, instead of printing a number that goes stale the first time it is changed.
    expect(finding?.next).toContain('noodle assistant embeds list');
  });

  it('still reports the existing authenticated findings', () => {
    const codes = auditEmbeddedAssistant(artifact({ surfaces: [PUBLIC_SURFACE] })).map(
      (f) => f.code,
    );
    expect(codes).toContain('assistant_configuration');
    expect(codes).toContain('assistant_consent_metadata');
  });

  it('reports nothing extra for an app with no assistant at all', () => {
    expect(auditEmbeddedAssistant(artifact(undefined)).map((f) => f.code)).toEqual([
      'assistant_configuration',
    ]);
  });
});
