import { describe, expect, it } from 'vitest';
import { BEHAVIOR_SKILLS } from '../src/behavior-skills.js';
import {
  contentSha256,
  renderAgentFiles,
  renderAgentKitManifest,
  renderPublishableSkills,
  skillFileMappings,
} from '../src/index.js';
import { PLUGIN_NAME, renderMarketplaceRepo, renderPluginBundle } from '../src/plugin-bundle.js';
import { SKILL_REFERENCES } from '../src/skill-content.js';
import { SKILL_ROUTES } from '../src/skill-router.js';

const PLAYBOOKS = [
  'references/build-an-mcp-server.md',
  'references/connect-an-api.md',
  'references/wrap-existing-app.md',
  'references/build-an-mcp-app.md',
  'references/verify-and-recover.md',
] as const;

const PLAYBOOK_HEADINGS = [
  '# Outcome',
  '## Use when',
  '## Do not use when',
  '## Required inputs',
  '## Workflow',
  '## Verification evidence',
  '## Recovery paths',
  '## Stop conditions',
] as const;

describe('agent behavior distribution', () => {
  it('ships every route and playbook byte-identically to both installed and publishable targets', () => {
    const installed = new Map(renderAgentFiles({}).map((file) => [file.path, file.content]));
    const published = new Map(renderPublishableSkills().map((file) => [file.path, file.content]));

    for (const target of ['codex', 'claude-code'] as const) {
      const installedBase =
        target === 'codex' ? '.agents/skills/noodle-seed' : '.claude/skills/noodle-seed';
      const publishedBase = `skills/${target}`;
      const router = installed.get(`${installedBase}/SKILL.md`) ?? '';

      const generatedSkillPaths = [
        'SKILL.md',
        ...SKILL_REFERENCES.map((reference) => reference.relPath),
        ...PLAYBOOKS,
      ];
      for (const relPath of new Set(generatedSkillPaths)) {
        const installedContent = installed.get(`${installedBase}/${relPath}`);
        const publishedContent = published.get(`${publishedBase}/${relPath}`);
        expect(installedContent, `${target} installed ${relPath}`).toBeDefined();
        expect(publishedContent, `${target} published ${relPath}`).toBe(installedContent);
      }

      for (const route of SKILL_ROUTES) {
        const skill = BEHAVIOR_SKILLS.find((candidate) => candidate.name === route.skill);
        expect(skill).toBeDefined();
        expect(router).toContain(skill?.primaryReference);
      }
      for (const playbook of PLAYBOOKS) {
        const installedContent = installed.get(`${installedBase}/${playbook}`);
        for (const heading of PLAYBOOK_HEADINGS) expect(installedContent).toContain(heading);
      }
    }
  });

  it('covers every registered reference with one mapping and one verified manifest entry per target', () => {
    const mappings = skillFileMappings();
    const published = new Map(renderPublishableSkills().map((file) => [file.path, file.content]));
    const manifest = renderAgentKitManifest();
    const referencePaths = SKILL_REFERENCES.map((reference) => reference.relPath);
    expect(new Set(referencePaths).size).toBe(referencePaths.length);

    for (const target of ['codex', 'claude-code'] as const) {
      for (const reference of referencePaths) {
        const publishPath = `skills/${target}/${reference}`;
        const matchingMappings = mappings.filter(
          (mapping) => mapping.agentTarget === target && mapping.publishPath === publishPath,
        );
        expect(matchingMappings, publishPath).toHaveLength(1);
        const content = published.get(publishPath);
        expect(content, publishPath).toBeDefined();
        expect(
          manifest.files.find((entry) => entry.agentTarget === target && entry.path === publishPath)
            ?.sha256,
        ).toBe(contentSha256(content ?? ''));
      }
    }
  });

  it('keeps the generated marketplace plugin a byte-identical lean bootstrap', () => {
    const marketplace = new Map(renderMarketplaceRepo().map((file) => [file.path, file.content]));
    for (const file of renderPluginBundle()) {
      expect(marketplace.get(`plugins/${PLUGIN_NAME}/${file.path}`), file.path).toBe(file.content);
    }

    const bootstrap =
      marketplace.get(`plugins/${PLUGIN_NAME}/skills/${PLUGIN_NAME}/SKILL.md`) ?? '';
    expect(bootstrap).toContain('noodle-readiness.setup_project');
    expect(bootstrap).toContain('From this skill directory');
    expect(bootstrap).toContain('node scripts/noodle-plugin.mjs <args>');
    expect(bootstrap).not.toContain('resolve the installed plugin root privately');
    expect(bootstrap).not.toContain('${CLAUDE_PLUGIN_ROOT}');
    expect(bootstrap).not.toContain('bin/noodle-plugin.mjs');
    expect(bootstrap).toContain('scripts/noodle-plugin.mjs');
    expect(bootstrap).not.toMatch(/<managed-launcher>|plugin-cache/i);
    expect(bootstrap).toMatch(/project-local skill owns/i);
    expect(bootstrap).toMatch(/follow it instead|instead of this one/i);
    expect(bootstrap).not.toMatch(/references\//);
    expect(bootstrap).not.toMatch(/docs\/decisions|\bADR\s+\d+/i);
  });

  it('keeps installed plugin execution on supported tools with public CLI recovery text', () => {
    const installed = new Map(renderAgentFiles({}).map((file) => [file.path, file.content]));
    for (const target of ['codex', 'claude-code'] as const) {
      const base = target === 'codex' ? '.agents/skills/noodle-seed' : '.claude/skills/noodle-seed';
      const router = installed.get(`${base}/SKILL.md`) ?? '';
      expect(router).toContain('noodle-readiness');
      expect(router).toMatch(/public `noodle \.\.\.` command/i);
      expect(router).not.toMatch(
        /(?:bin|scripts)\/noodle-plugin(?:-cursor)?\.mjs|<managed-launcher>|plugin-cache/i,
      );
      expect(router).not.toMatch(/\b(?:sh -c|sed)\b/i);
    }
  });
});
