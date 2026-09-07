import { describe, expect, it } from 'vitest';
import { renderAgentFiles } from '../src/index.js';

function apiPlaybook(): string {
  const content = renderAgentFiles({}).find((file) =>
    file.path.endsWith('/references/connect-an-api.md'),
  )?.content;
  expect(content).toBeDefined();
  return content ?? '';
}

describe('connect a live API playbook', () => {
  it('uses the shared capability-playbook contract', () => {
    const playbook = apiPlaybook();
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

  it('keeps credentials in the environment and managed secret path', () => {
    const playbook = apiPlaybook();
    expect(playbook).toMatch(/environment variable/i);
    expect(playbook).toContain('secret("SOME_API_KEY")');
    expect(playbook).toContain('--runtime local --from-env SOME_API_KEY');
    expect(playbook).toMatch(/same effective (?:local )?target/i);
    expect(playbook).toMatch(/never (?:inline|log|print).*(?:key|credential|secret)/i);
  });

  it('models only an observed live response and distinguishes empty from missing fields', () => {
    const playbook = apiPlaybook();
    expect(playbook).toMatch(/representative (?:safe )?(?:live )?read/i);
    expect(playbook).toMatch(/observed (?:response|shape)|actually returned/i);
    expect(playbook).toMatch(/empty result/i);
    expect(playbook).toContain('undefined');
    expect(playbook).toMatch(/do not (?:guess|invent).*(?:field|schema|endpoint)/i);
  });

  it('designs intent tools and requires approval before a live write', () => {
    const playbook = apiPlaybook();
    expect(playbook).toMatch(/intent[- ]shaped|user intent/i);
    expect(playbook).toMatch(/not .*1:1.*endpoint/i);
    expect(playbook).toMatch(/live write.*explicit.*approval|explicit.*approval.*live write/i);
  });

  it('requires real mapped output and separates local from hosted proof', () => {
    const playbook = apiPlaybook();
    expect(playbook).toContain('noodle tools call');
    expect(playbook).toMatch(/populated.*mapped fields/i);
    expect(playbook).toMatch(/local proof/i);
    expect(playbook).toMatch(/hosted.*not (?:proven|run)|does not prove hosted/i);
  });
});
