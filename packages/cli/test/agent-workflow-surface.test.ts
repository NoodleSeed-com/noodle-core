import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AGENTS_MD_MAX_WORDS,
  DECISION_SKILL_MAX_WORDS,
} from '../../../scripts/lib/agent-docs-audit.mjs';

const root = join(import.meta.dirname, '..', '..', '..');
const read = (relative: string) => readFileSync(join(root, relative), 'utf8');
const wordCount = (value: string) => value.trim().split(/\s+/u).length;

describe('lean agent workflow surface', () => {
  it('keeps planning repo-specific without mandatory external consensus', () => {
    const skill = read('.agents/skills/plan-mode-defaults/SKILL.md');

    for (const required of [
      'strategy gates',
      'tests before',
      'acceptance criteria',
      'docs reconciliation',
    ]) {
      expect(skill.toLowerCase()).toContain(required);
    }
    for (const redundant of ['Perplexity', 'agy', 'OpenCode', 'second opinions']) {
      expect(skill).not.toContain(redundant);
    }
  });

  it('uses nested CLIs only through explicit, fail-closed read-only workflows', () => {
    const shared = read('.agents/skills/agent-cli-workflow/SKILL.md');
    const openCode = read('.agents/skills/opencode-cli/SKILL.md');
    const codex = read('.agents/skills/codex-cli/SKILL.md');

    expect(shared).toContain('explicitly requests');
    expect(shared).toContain('Do not edit files');
    expect(shared).not.toContain('For non-trivial planning');
    expect(openCode).toContain('fail closed');
    expect(openCode).not.toContain('Falling back to default agent');
    expect(openCode).not.toContain('deepseek-v4-pro');
    expect(codex).toContain('diagnostic');
    expect(codex).not.toContain('independent code review');
  });

  it('keeps narrow automation and dual-era protocol triggers', () => {
    const subtraction = read('.agents/skills/evidence-backed-subtraction/SKILL.md');
    const inspector = read('.agents/skills/mcp-inspector/SKILL.md');

    expect(subtraction).toContain('personal Claude Code Routine');
    expect(subtraction).toContain('Claude Opus 5');
    expect(inspector).toContain('2025-11-25');
    expect(inspector).toContain('2026-07-28');
    expect(inspector).toContain('modern-era-routing.md');
  });

  it('preserves hard repository invariants while reducing instruction weight', () => {
    const instructions = read('AGENTS.md');
    const decisions = read('.agents/skills/design-decision-workflow/SKILL.md');

    for (const invariant of [
      'TypeScript-only',
      '2025-11-25',
      '2026-07-28',
      'Never work, commit, or push directly in the primary checkout',
      'pnpm dev:ready --fix',
      'pnpm agent:pr',
      'Never forward inbound MCP/OAuth bearer tokens',
      'Tenant Isolation',
      'design-decision workflow',
    ]) {
      expect(instructions).toContain(invariant);
    }
    for (const doctrine of [
      'qualified unit of usage',
      'customer-controlled distribution path',
      'same-source-many-businesses test',
      'typed service API and a complete CLI command',
      'Aesthetic quality is the final tiebreaker',
    ]) {
      expect(decisions).toContain(doctrine);
    }
    expect(wordCount(instructions)).toBeLessThanOrEqual(AGENTS_MD_MAX_WORDS);
    expect(wordCount(decisions)).toBeLessThanOrEqual(DECISION_SKILL_MAX_WORDS);
  });

  it('cuts generic workflow prose and configures a lean repo catalog', () => {
    const workflowFiles = [
      '.agents/skills/plan-mode-defaults/SKILL.md',
      '.agents/skills/agent-cli-workflow/SKILL.md',
      '.agents/skills/agy-cli/SKILL.md',
      '.agents/skills/opencode-cli/SKILL.md',
      '.agents/skills/codex-cli/SKILL.md',
    ];
    const workflowWords = workflowFiles.reduce((total, file) => total + wordCount(read(file)), 0);
    const config = read('.codex/config.toml');

    expect(workflowWords).toBeLessThanOrEqual(3250);
    for (const disabled of [
      'mcp-server-dev@claude-plugins-official',
      'github@openai-curated',
      'superpowers:using-superpowers',
      'chatgpt-apps',
      'find-skills',
      'playwright-interactive',
      'Noodle Builder',
    ]) {
      expect(config).toContain(disabled);
    }
    for (const retained of [
      'mcp-apps@claude-plugins-official',
      'openai-developers@openai-curated',
      'noodle-seed@noodleseed',
    ]) {
      expect(config).toContain(retained);
    }
  });
});
