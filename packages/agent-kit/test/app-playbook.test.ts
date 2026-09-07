import { describe, expect, it } from 'vitest';
import { renderAgentFiles } from '../src/index.js';

function appPlaybook(): string {
  const content = renderAgentFiles({}).find((file) =>
    file.path.endsWith('/references/build-an-mcp-app.md'),
  )?.content;
  expect(content).toBeDefined();
  return content ?? '';
}

describe('build an MCP App playbook', () => {
  it('uses the shared capability-playbook contract', () => {
    const playbook = appPlaybook();
    for (const heading of [
      '# Outcome',
      '## Use when',
      '## Do not use when',
      '## Required inputs',
      '## Workflow',
      '## Verification evidence',
      '## Recovery paths',
      '## Stop conditions',
    ]) {
      expect(playbook).toContain(heading);
    }
  });

  it('makes the UI prove a user benefit before implementation', () => {
    const playbook = appPlaybook();
    expect(playbook).toMatch(/UI fit|UI earn|visual interaction/i);
    expect(playbook).toMatch(/before (?:authoring|implementation|writing)/i);
    expect(playbook).toMatch(/design spec/i);
    expect(playbook).toMatch(/user benefit/i);
  });

  it('routes platform component defaults to the canonical widget reference', () => {
    const playbook = appPlaybook();
    expect(playbook).toContain('references/widgets-and-apps.md');
    expect(playbook).not.toMatch(/Noodle Design|@noodleseed\/one\/react|semantic tokens/i);
  });

  it('separates model output from widget data and preserves text fallback', () => {
    const playbook = appPlaybook();
    expect(playbook).toMatch(/model-visible|model output/i);
    expect(playbook).toMatch(/widget-only|widget data/i);
    expect(playbook).toMatch(/text fallback|useful text/i);
    expect(playbook).toMatch(/widget.*unavailable|without the widget/i);
  });

  it('requires the product-guide decision while leaving its criteria in the canonical reference', () => {
    const playbook = appPlaybook();

    expect(playbook).toContain('references/product-agent-guides.md');
    expect(playbook).toMatch(/decide product-guide coverage/i);
    expect(playbook).toMatch(/record.*decision.*reason/i);
    expect(playbook).not.toMatch(/multiple capabilities.*workflow/i);
    expect(playbook).not.toMatch(/single.*self-explanatory.*capability.*omit/i);
    expect(playbook).not.toMatch(/tool count.*signal, not a rule/i);
  });

  it('runs checks by evidence level and keeps host/compliance work conditional', () => {
    const playbook = appPlaybook();
    expect(playbook).toContain('noodle check --json');
    expect(playbook).toContain('noodle devtools');
    expect(playbook).toMatch(/host test.*only when|only when.*host test/i);
    expect(playbook).toMatch(/compliance.*only when|only when.*compliance/i);
    expect(playbook).toMatch(/report.*not run/i);
  });

  it('routes detail to the existing design and widget references', () => {
    const playbook = appPlaybook();
    expect(playbook).toContain('references/experience-design.md');
    expect(playbook).toContain('references/widgets-and-apps.md');
    expect(playbook).not.toContain('references/test-in-hosts.md');
  });
});
