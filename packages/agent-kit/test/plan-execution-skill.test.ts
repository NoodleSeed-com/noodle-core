import { describe, expect, it } from 'vitest';
import { renderAgentFiles, renderPublishableSkills } from '../src/index.js';
import {
  EXECUTING_NOODLE_PLANS_SKILL,
  renderExecutingNoodlePlansSkill,
} from '../src/plan-execution-skill.js';
import { renderPluginBundle } from '../src/plugin-bundle.js';

describe('executing-noodle-plans skill', () => {
  it('defines a bounded first-party execution contract', () => {
    expect(EXECUTING_NOODLE_PLANS_SKILL).toMatchObject({
      name: 'executing-noodle-plans',
      description: expect.stringMatching(/^Use when /),
    });

    const body = renderExecutingNoodlePlansSkill();
    for (const section of [
      '## Preconditions',
      '## Task loop',
      '## Review and recovery',
      '## Completion',
      '## Stop conditions',
    ]) {
      expect(body).toContain(section);
    }
    expect(body).toMatch(/test.*first/i);
    expect(body).toMatch(/one task at a time/i);
    expect(body).toMatch(/independent review/i);
    expect(body).toMatch(/resume.*plan.*git/i);
  });

  it('installs and publishes the skill for every supported project host', () => {
    for (const host of ['codex', 'claude-code'] as const) {
      const root = host === 'codex' ? '.agents' : '.claude';
      expect(
        renderAgentFiles({ targets: [host] }).some(
          (file) => file.path === `${root}/skills/executing-noodle-plans/SKILL.md`,
        ),
      ).toBe(true);
      expect(
        renderPublishableSkills().some(
          (file) =>
            file.agentTarget === host &&
            file.path === `skills/${host}/executing-noodle-plans/SKILL.md`,
        ),
      ).toBe(true);
    }
  });

  it('does not enlarge the cold-start plugin bootstrap', () => {
    expect(renderPluginBundle().some((file) => file.path.includes('executing-noodle-plans'))).toBe(
      false,
    );
  });
});
