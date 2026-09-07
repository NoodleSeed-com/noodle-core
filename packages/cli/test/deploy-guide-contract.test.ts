import { readFileSync } from 'node:fs';
import { ACCESS_MODES } from '@noodle-borg/wire-contracts';
import { describe, expect, it } from 'vitest';

const guide = readFileSync(
  new URL('../../../apps/docs/content/guides/deploy.mdx', import.meta.url),
  'utf8',
);

describe('published deploy guide contract', () => {
  it('uses canonical org-subdomain endpoints instead of the legacy tenant route', () => {
    expect(guide).toContain('https://acme.cloud.noodleseed.dev/support/v1/mcp');
    expect(guide).toContain('https://acme.cloud.noodleseed.dev/support/mcp');
    expect(guide).toContain('https://acme.cloud.noodleseed.dev/support/env/staging/v1/mcp');
    expect(guide).not.toContain('/o/{org}/{app}/mcp');
  });

  it('distinguishes version-pinned endpoints from the unversioned follow-latest endpoint', () => {
    expect(guide).toMatch(/version-pinned/i);
    expect(guide).toMatch(/unversioned[\s\S]{0,80}follow-latest/i);
    expect(guide).toContain('noodle deploy --version 2');
  });

  it('documents every canonical hosted access mode', () => {
    for (const mode of ACCESS_MODES) {
      expect(guide).toContain(`| \`${mode}\` |`);
    }
  });

  it.each([
    'noodle target show',
    'noodle deploy',
    'noodle status',
    'noodle logs --tail',
    'noodle metrics',
    'noodle events',
    'noodle deployments list',
    'noodle deployments inspect',
    'noodle rollback',
    'noodle archive',
    'noodle restore',
  ])('covers the %s lifecycle command', (command) => {
    expect(guide).toContain(command);
  });
});
