import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../../..');
const read = (...parts: string[]) => readFileSync(resolve(repoRoot, ...parts), 'utf8');

describe('public signup-continuity guidance', () => {
  it('teaches the conversion-safe end-to-end sequence and completion boundary', () => {
    const guide = read('apps', 'docs', 'content', 'guides', 'signup-continuity.mdx');

    for (const required of [
      'useful result before asking for an account',
      'publicWebsite({',
      'signIn: true',
      'authenticatedWebsite({',
      'claimOnAuthentication: true',
      'assistant-sign-in-requested',
      'createAssistantSession',
      'complete_onboarding',
      'confirm: true',
      'idempotent',
      'signup_completed',
      'onboarding_completed',
    ]) {
      expect(guide).toContain(required);
    }
    expect(guide).toContain('Signing up is not completed onboarding');
    expect(guide).toContain('does not guarantee a conversion lift');
  });

  it('keeps the guide discoverable from public docs and the flagship example', () => {
    const index = read('apps', 'docs', 'content', 'index.mdx');
    const navigation = read('apps', 'docs', 'content', 'guides', 'meta.json');
    const example = read('examples', 'stateful-draft', 'README.md');

    expect(index).toContain('href="/docs/guides/signup-continuity"');
    expect(navigation).toContain('"signup-continuity"');
    expect(example).toContain('https://docs.noodleseed.dev/docs/guides/signup-continuity');
    expect(example).toContain("Start with the visitor's goal");
    expect(example).toContain('Compare onboarding completion and first useful product outcome');
  });
});
