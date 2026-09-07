import { describe, expect, it } from 'vitest';
import { renderAgentFiles } from '../src/index.js';

function serverPlaybook(): string {
  const content = renderAgentFiles({}).find((file) =>
    file.path.endsWith('/references/build-an-mcp-server.md'),
  )?.content;
  expect(content).toBeDefined();
  return content ?? '';
}

describe('build an MCP server playbook', () => {
  it('uses the shared capability-playbook contract', () => {
    const playbook = serverPlaybook();
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

  it('routes discovery details to the owning workflow and preserves stopping criteria', () => {
    const playbook = serverPlaybook();
    expect(playbook).toContain('references/authoring-workflow.md');
    expect(playbook).not.toMatch(/URL or website|OpenAPI document|Focused interview/i);
    expect(playbook).toMatch(/do not (?:guess|invent).*(?:schema|endpoint)/i);
    expect(playbook).toMatch(/evidence is missing.*stop/i);
  });

  it('builds a conversational product instead of an endpoint wrapper', () => {
    const playbook = serverPlaybook();
    expect(playbook).toMatch(/conversational (?:fit|surface)/i);
    expect(playbook).toMatch(/intent[- ]shaped|user intent/i);
    expect(playbook).toMatch(/not .*1:1.*endpoint/i);
    expect(playbook).toMatch(/TypeScript-only/i);
  });

  it('requires the product-guide decision while leaving its criteria in the canonical reference', () => {
    const playbook = serverPlaybook();

    expect(playbook).toContain('references/product-agent-guides.md');
    expect(playbook).toMatch(/decide product-guide coverage/i);
    expect(playbook).toMatch(/record.*decision.*reason/i);
    expect(playbook).not.toMatch(/product skill.*App Package.*plugin.*agent distribution/i);
    expect(playbook).not.toMatch(/single.*self-explanatory.*capability.*omit/i);
    expect(playbook).not.toMatch(/tool count.*signal, not a rule/i);
  });

  it('keeps MCP protocol negotiation on the platform serving seam', () => {
    const playbook = serverPlaybook();
    expect(playbook).toMatch(/protocol versions? (?:are|is) platform-owned/i);
    expect(playbook).toMatch(/do not add.*(?:server options|noodle\\.json)/i);
  });

  it('requires local proof and a real connector read without forcing deployment', () => {
    const playbook = serverPlaybook();
    expect(playbook).toContain('noodle validate --json');
    expect(playbook).toContain('noodle test --json');
    expect(playbook).toContain('noodle tools call');
    expect(playbook).toMatch(/populated.*mapped fields/i);
    expect(playbook).toMatch(/deploy only when|do not deploy unless/i);
    expect(playbook).toMatch(/report.*not run/i);
  });

  it('routes technical detail to existing references instead of duplicating it', () => {
    const playbook = serverPlaybook();
    for (const reference of ['references/authoring-workflow.md', 'references/sdk-surface.md']) {
      expect(playbook).toContain(reference);
    }
    expect(playbook).not.toContain('references/examples.md');
    expect(playbook).not.toContain('references/compile-errors.md');
    expect(playbook).not.toContain('## SDK exports');
    expect(playbook).not.toContain('## Command catalog');
  });
});
