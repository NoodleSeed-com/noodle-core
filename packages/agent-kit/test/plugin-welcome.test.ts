import { describe, expect, it } from 'vitest';
import { renderPluginBundle } from '../src/plugin-bundle.js';
import { renderOfficialDirectoryPlugin } from '../src/plugin-directory-bundle.js';

describe('plugin first-use welcome', () => {
  it('ships the same user-visible wordmark before project handoff in both projections', () => {
    const skills = [renderPluginBundle(), renderOfficialDirectoryPlugin()].map(
      (files) => files.find((file) => file.path === 'skills/noodle-seed/SKILL.md')?.content ?? '',
    );
    expect(skills[0]).toBe(skills[1]);
    for (const skill of skills) {
      expect(skill).toContain('## First-use welcome');
      expect(skill).toContain('```text\n███╗   ██╗ ██████╗');
      expect(skill).toContain('Welcome to Noodle Seed!');
      expect(skill).toContain('once per conversation');
      expect(skill).toContain('Never put the wordmark in command output or JSON');
      expect(skill.indexOf('## First-use welcome')).toBeLessThan(skill.indexOf('## Defer'));
      expect(skill).not.toContain('\u001b');
    }
  });
});
