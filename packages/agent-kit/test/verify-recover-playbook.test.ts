import { describe, expect, it } from 'vitest';
import { renderAgentFiles } from '../src/index.js';

function verificationPlaybook(): string {
  const content = renderAgentFiles({}).find((file) =>
    file.path.endsWith('/references/verify-and-recover.md'),
  )?.content;
  expect(content).toBeDefined();
  return content ?? '';
}

describe('verify and recover playbook', () => {
  it('uses the shared capability-playbook contract', () => {
    const playbook = verificationPlaybook();
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

  it('uses an ordered evidence ladder from compile through production', () => {
    const playbook = verificationPlaybook();
    const evidence = [
      'compile',
      'validate',
      'local smoke',
      'real API',
      'App compliance',
      'host',
      'deploy',
      'production health',
    ];
    let cursor = -1;
    for (const label of evidence) {
      const next = playbook.toLowerCase().indexOf(label.toLowerCase(), cursor + 1);
      expect(next).toBeGreaterThan(cursor);
      cursor = next;
    }
  });

  it('parses machine failure data before editing and reruns the failed layer', () => {
    const playbook = verificationPlaybook();
    expect(playbook).toMatch(/exit (?:code|status).*first/i);
    expect(playbook).toContain('error.errors[]');
    expect(playbook).toMatch(/reported `path`|path.*reported/i);
    expect(playbook).toMatch(/rerun (?:only )?the (?:same|failed) (?:evidence )?layer/i);
    expect(playbook).toMatch(/do not freeform|without freeform/i);
  });

  it('bounds recovery and stops for missing authority or external state', () => {
    const playbook = verificationPlaybook();
    expect(playbook).toMatch(/two evidence-backed repair attempts.*same failure signature/i);
    expect(playbook).toMatch(/authority/i);
    expect(playbook).toMatch(/external state/i);
    expect(playbook).toMatch(/exact next action/i);
  });

  it('prevents evidence overclaiming', () => {
    const playbook = verificationPlaybook();
    expect(playbook).toMatch(/claim only/i);
    expect(playbook).toMatch(/compile.*does not prove.*runtime/i);
    expect(playbook).toMatch(/local.*does not prove.*hosted|local.*not hosted/i);
    expect(playbook).toMatch(/report.*not run/i);
    expect(playbook).toContain('--tool <read_tool> --args <json>');
    expect(playbook).toContain('output-schema mismatch');
    expect(playbook).toContain('`input_required` is not completion');
    expect(playbook).toContain('does not prove a write was rolled back');
  });

  it('routes symptom-specific detail to existing references', () => {
    const playbook = verificationPlaybook();
    expect(playbook).toContain('references/agent-contract.md');
    expect(playbook).toContain('references/compile-errors.md');
    expect(playbook).not.toContain('references/troubleshooting.md');
  });
});
