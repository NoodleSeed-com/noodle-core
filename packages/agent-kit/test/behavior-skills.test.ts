import { posix } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BEHAVIOR_SKILLS,
  EXPECTED_BEHAVIOR_SKILL_NAMES,
  renderBehaviorSkillBody,
} from '../src/behavior-skills.js';
import { renderAgentFiles, renderPublishableSkills, SKILL_REGISTRY } from '../src/index.js';
import { SKILL_REFERENCES } from '../src/skill-content.js';

const REQUIRED_SECTIONS = [
  '## Use when',
  '## Do not use when',
  '## Required inputs',
  '## Workflow',
  '## Verification evidence',
  '## Recovery paths',
  '## Stop conditions',
  '## Handoff contract',
] as const;

describe('modular MCP behavior skills', () => {
  it('registers the complete bounded constellation with trigger-only descriptions', () => {
    expect(BEHAVIOR_SKILLS.map((skill) => skill.name)).toEqual(EXPECTED_BEHAVIOR_SKILL_NAMES);
    expect(new Set(BEHAVIOR_SKILLS.map((skill) => skill.name)).size).toBe(12);
    for (const skill of BEHAVIOR_SKILLS) {
      expect(skill.description).toMatch(/^Use when /);
      expect(skill.description).not.toMatch(/then |workflow|steps|by running/i);
      expect(skill.positiveTriggers.length).toBeGreaterThan(0);
      expect(skill.negativeTriggers.length).toBeGreaterThan(0);
    }
  });

  it('gives every skill explicit boundaries, evidence, recovery, stops, and evidence-preserving handoff', () => {
    for (const skill of BEHAVIOR_SKILLS) {
      const body = renderBehaviorSkillBody(skill, 'codex');
      for (const section of REQUIRED_SECTIONS) expect(body).toContain(section);
      for (const trigger of skill.positiveTriggers) expect(body).toContain(trigger);
      for (const trigger of skill.negativeTriggers) expect(body).toContain(trigger);
      expect(body).toContain(skill.primaryReference);
      expect(body).toMatch(/first unproven evidence layer/i);
      expect(body).toMatch(/do not restart discovery/i);
      expect(body).not.toContain('# CLI commands');
    }
  });

  it('keeps existing-application and API-connection trigger metadata aligned with precedence', () => {
    const wrapping = BEHAVIOR_SKILLS.find(
      (skill) => skill.name === 'wrapping-existing-applications',
    );
    const connecting = BEHAVIOR_SKILLS.find((skill) => skill.name === 'connecting-apis-to-mcp');
    expect(wrapping).toBeDefined();
    expect(connecting).toBeDefined();
    if (wrapping === undefined || connecting === undefined)
      throw new Error('missing behavior skill');

    const wrappingBody = renderBehaviorSkillBody(wrapping, 'codex');
    const connectingBody = renderBehaviorSkillBody(connecting, 'codex');
    expect(wrappingBody).toMatch(
      /all four.*API base URL.*authentication scheme.*representative safe read.*observed response/i,
    );
    expect(wrappingBody).toMatch(
      /stale, inaccessible, undocumented-only, or otherwise unusable.*wrapping-existing-applications/i,
    );
    expect(wrappingBody).toMatch(
      /stable origin.*no safe stable HTTP boundary.*smallest application-owned stable HTTPS adapter over existing business functions/i,
    );
    expect(wrappingBody).toMatch(
      /safe live verification input or working credential.*explicitly unproven.*exact prerequisite/i,
    );
    expect(wrappingBody).not.toMatch(/stop with.*stable HTTP seam|stop with.*safe evidence/i);

    expect(connecting.description).toMatch(
      /all four.*API base URL.*authentication scheme.*representative safe read.*observed response/i,
    );
    expect(connectingBody).toContain(
      'Connect this API after confirming its base URL, authentication scheme, safe read, and observed response.',
    );
  });

  it('makes the account-growth first workflow independently discoverable', () => {
    const embedding = BEHAVIOR_SKILLS.find((skill) => skill.name === 'embedding-mcp-assistants');
    expect(embedding).toBeDefined();
    if (embedding === undefined) throw new Error('missing embedding behavior skill');

    expect(embedding.description).toMatch(
      /improving signup or onboarding conversion.*public-to-product onboarding/i,
    );
    expect(embedding.positiveTriggers).toContain(
      'Choose a first Noodle workflow for software where more signed-in users are valuable.',
    );
    expect(embedding.requiredInputs.join(' ')).toMatch(
      /public visitor surface.*account boundary.*useful pre-account result.*authenticated outcome/i,
    );
  });

  it('keeps factual references single-authored while rendering each sibling self-contained', () => {
    const canonical = new Map(
      SKILL_REFERENCES.map((reference) => [reference.relPath, reference] as const),
    );
    for (const skill of BEHAVIOR_SKILLS) {
      expect(canonical.has(skill.primaryReference)).toBe(true);
      for (const reference of skill.supportingReferences)
        expect(canonical.has(reference)).toBe(true);
      const registered = SKILL_REGISTRY.definitions.find(
        (definition) => definition.name === skill.name,
      );
      expect(registered?.files.map((file) => file.relPath)).toEqual([
        skill.primaryReference,
        ...skill.supportingReferences,
      ]);
      for (const file of registered?.files ?? []) {
        expect(file.render()).toBe(canonical.get(file.relPath)?.render());
      }
    }
  });

  it('renders and publishes every sibling for both hosts without changing the lean global bootstrap', () => {
    for (const host of ['codex', 'claude-code'] as const) {
      const root = host === 'codex' ? '.agents' : '.claude';
      const installed = renderAgentFiles({ targets: [host] });
      const published = renderPublishableSkills().filter((file) => file.agentTarget === host);
      for (const name of EXPECTED_BEHAVIOR_SKILL_NAMES) {
        expect(installed.some((file) => file.path === `${root}/skills/${name}/SKILL.md`)).toBe(
          true,
        );
        expect(published.some((file) => file.path === `skills/${host}/${name}/SKILL.md`)).toBe(
          true,
        );
      }
    }
  });

  it('publishes every modular skill as an independently resolvable artifact', () => {
    for (const host of ['codex', 'claude-code'] as const) {
      const published = renderPublishableSkills().filter((file) => file.agentTarget === host);
      for (const skill of BEHAVIOR_SKILLS) {
        const isolated = published.filter((file) => file.skill === skill.name);
        const entrypoint = isolated.find((file) => file.path.endsWith(`/${skill.name}/SKILL.md`));
        expect(entrypoint, `${host}/${skill.name} is missing SKILL.md`).toBeDefined();

        const declaredPaths = [...(entrypoint?.content.matchAll(/ at `([^`]+)`/g) ?? [])].map(
          (match) => posix.normalize(match[1]),
        );
        const expectedPaths = [skill.primaryReference, ...skill.supportingReferences].map((path) =>
          posix.normalize(path),
        );
        expect(
          declaredPaths,
          `${host}/${skill.name} declares the wrong workflow references`,
        ).toEqual(expectedPaths);

        const isolatedPaths = new Set(isolated.map((file) => file.path));
        const entrypointDirectory = posix.dirname(entrypoint?.path ?? '');
        for (const declaredPath of declaredPaths) {
          const resolved = posix.normalize(posix.join(entrypointDirectory, declaredPath));
          expect(
            isolatedPaths.has(resolved),
            `${host}/${skill.name} omits declared workflow ${declaredPath}`,
          ).toBe(true);
        }
      }
    }
  });

  it('keeps front-door routing as a direct handoff instead of reloading the playbook corpus', () => {
    const router = renderAgentFiles({ targets: ['codex'] }).find(
      (file) => file.path === '.agents/skills/noodle-seed/SKILL.md',
    )?.content;
    for (const name of EXPECTED_BEHAVIOR_SKILL_NAMES) expect(router).toContain(name);
    expect(router).toMatch(/hand off|load the selected sibling/i);
    expect(router).toMatch(/do not reread|do not restart/i);
  });
});
