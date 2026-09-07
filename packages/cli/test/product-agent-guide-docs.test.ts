import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const guideUrl = new URL(
  '../../../apps/docs/content/guides/product-agent-guides.mdx',
  import.meta.url,
);
const navUrl = new URL('../../../apps/docs/content/guides/meta.json', import.meta.url);
const sdkReferenceUrl = new URL(
  '../../../apps/docs/content/guides/sdk-reference.mdx',
  import.meta.url,
);

describe('public product agent-guide documentation', () => {
  it('is discoverable from the guide navigation and SDK server options', () => {
    const nav = JSON.parse(readFileSync(navUrl, 'utf8')) as { pages: string[] };
    const sdkReference = readFileSync(sdkReferenceUrl, 'utf8');

    expect(nav.pages).toContain('product-agent-guides');
    expect(sdkReference).toContain('`agentGuide`');
    expect(sdkReference).toContain('/docs/guides/product-agent-guides');
  });

  it('documents the complete product-guide journey and current marketplace boundaries', () => {
    const guide = readFileSync(guideUrl, 'utf8');

    expect(guide).toMatch(/Noodle workflow skills/i);
    expect(guide).toMatch(/app product skill/i);
    expect(guide).toMatch(/marketplace plugin/i);
    expect(guide).toMatch(/local-first journey/i);
    expect(guide).toContain('noodle validate');
    expect(guide).toContain('noodle agents setup --json');
    expect(guide).toContain('noodle deploy');
    expect(guide).toContain('Console Package');
    expect(guide).toMatch(/embedded assistant/i);
    expect(guide).toMatch(/direct skill-aware agent/i);
    expect(guide).toContain('noodle export plugin openai');
    expect(guide).toContain('noodle export plugin claude');
    expect(guide).toContain('noodle export connector claude');
    expect(guide).toContain('noodle distributions publish');
    expect(guide).toMatch(/access mode is `public`[\s\S]{0,80}anonymous access/i);
    expect(guide).toContain('Scan Tools');
    expect(guide).toMatch(/submission-time snapshot/i);
    expect(guide).toMatch(/chatgpt-app-submission\.json[\s\S]{0,180}review reference/i);
    expect(guide).toContain(
      'https://developers.openai.com/apps-sdk/schemas/chatgpt-app-submission.v1.json',
    );
    expect(guide).not.toMatch(/upload `submission\/chatgpt-app-submission\.json`/i);
    expect(guide).toMatch(/does not deploy[\s\S]{0,120}submit for review[\s\S]{0,80}publish/i);
    expect(guide).toMatch(/single self-explanatory capability[\s\S]{0,120}omit/i);
    expect(guide).toContain('agentGuide:');
    expect(guide).toContain('noodle agents setup --write');
    expect(guide).toContain('noodle agents setup --write --regenerate-app-skill');
  });
});
