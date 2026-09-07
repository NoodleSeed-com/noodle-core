import { describe, expect, it } from 'vitest';
import { BEHAVIOR_SKILLS, renderAgentFiles } from '../src/index.js';
import { renderAgentGuideReference } from '../src/skill-agent-guide-ref.js';
import { renderAuthoringWorkflowReference } from '../src/skill-authoring-refs.js';
import { renderExperienceDesignReference } from '../src/skill-design-refs.js';

describe('shipped product agent-guide lifecycle guidance', () => {
  it('teaches the explicit, account-free, collision-safe local install and diagnosis path', () => {
    const reference = renderAgentGuideReference();

    expect(reference).toContain('noodle agents setup` previews');
    expect(reference).toContain('noodle agents setup --write');
    expect(reference).toContain('noodle agents doctor --json');
    expect(reference).toContain('No account or hosted deployment is required');
    expect(reference).toContain('.agents/skills/<app-skill>/');
    expect(reference).toContain('.claude/skills/<app-skill>/');
    expect(reference).toContain('never overwrites a modified app-skill file');
    expect(reference).toContain('`--force` applies only to Noodle-owned project context');
    expect(reference).toContain('agent_skill_modified');
    expect(reference).toContain('agent_skill_stale');
    expect(reference).toContain('agent_skill_invalid_state');
  });

  it('makes product-guide coverage an agent-owned decision instead of required user vocabulary', () => {
    const reference = renderAgentGuideReference();

    expect(reference).toMatch(/do not wait for the user to (?:name|request) `agentGuide`/i);
    expect(reference).toMatch(/App Package.*product skill.*plugin.*agent distribution/i);
    expect(reference).toMatch(/multiple capabilities.*workflow/i);
    expect(reference).toMatch(/ordering.*grounding.*clarification.*boundaries/i);
    expect(reference).toMatch(/single.*self-explanatory.*capability.*omit/i);
    expect(reference).toMatch(/tool count.*signal, not a rule/i);
    expect(reference).toMatch(/state.*decision.*reason/i);
  });

  it('distinguishes local, embedded, host-package, and direct external projections', () => {
    const reference = renderAgentGuideReference();

    expect(reference).toMatch(/Noodle workflow skills.*build and operate/i);
    expect(reference).toMatch(/app product skill.*team-local/i);
    expect(reference).toMatch(/marketplace plugin.*separate host distribution/i);
    expect(reference).toMatch(
      /available target adapters.*local exports.*deployment-bound archives/i,
    );
    expect(reference).toMatch(/embedded assistant automatically consumes.*authorization-aware/i);
    expect(reference).toMatch(/direct external agent.*tenant MCP URL.*modern draft MCP Skills/i);
    expect(reference).toMatch(/protocol delivery.*not evidence of host support/i);
    expect(reference).toMatch(/existing OAuth flow.*do not install a second skill/i);
    expect(reference).toMatch(/authorized, model-visible tools.*resources or prompts/i);
    expect(reference).toMatch(/app-only helpers.*forbidden tools.*stay out/i);
    expect(reference).toMatch(/caller-specific SHA-256 digest/i);
    expect(reference).toMatch(/role or scope change.*next response.*digest/i);
    expect(reference).toMatch(/raw guide.*never enter the browser/i);
  });

  it('puts the guide decision in the design contract before implementation', () => {
    const reference = renderExperienceDesignReference();

    expect(reference).toMatch(/product-guide decision/i);
    expect(reference).toMatch(/guided or unguided/i);
    expect(reference).toContain('references/product-agent-guides.md');
  });

  it('routes the common authoring loop to the canonical guide decision', () => {
    const reference = renderAuthoringWorkflowReference();

    expect(reference).toMatch(/product-guide decision/i);
    expect(reference).toContain('references/product-agent-guides.md');
    expect(reference).toMatch(/do not wait for the user to (?:name|request) `agentGuide`/i);
  });

  it('requires reuse of shipped managed capabilities without inventing roadmap APIs', () => {
    const reference = renderAuthoringWorkflowReference();

    expect(reference).toMatch(/Managed capability reuse/i);
    expect(reference).toMatch(/actually exported.*use its one documented declaration/i);
    expect(reference).toMatch(/embedded assistant and external MCP agents/i);
    expect(reference).toContain('provider: noodleManaged()');
    expect(reference).toMatch(/fares, inventory, bookings.*remain connectors/i);
    expect(reference).toMatch(/roadmap is not an SDK/i);
    expect(reference).toMatch(/do not invent an import/i);
  });

  it('ships a dedicated cold-agent route for creating a product guide safely', () => {
    expect(BEHAVIOR_SKILLS).toContainEqual(
      expect.objectContaining({ name: 'creating-product-agent-guides' }),
    );

    const installed = renderAgentFiles({});
    for (const root of ['.agents/skills', '.claude/skills']) {
      expect(
        installed.some((file) => file.path === `${root}/creating-product-agent-guides/SKILL.md`),
      ).toBe(true);
    }
  });

  it('teaches inspect, interview, approval, proof, and explicit package installation', () => {
    const reference = renderAgentGuideReference();

    expect(reference).toMatch(/inspect.*(?:server\.ts|configured TypeScript entrypoint)/i);
    expect(reference).toMatch(/interview.*(?:builder|product)/i);
    expect(reference).toMatch(/never (?:invent|guess).*(?:tool|resource|prompt|capabilit)/i);
    expect(reference).toMatch(/propose.*TypeScript/i);
    expect(reference).toMatch(/approval.*before.*(?:edit|writ)/i);
    expect(reference).toContain('noodle validate --json');
    expect(reference).toContain('noodle test --json');
    expect(reference).toMatch(/noodle agents setup --json.*preview/i);
    expect(reference).toContain('--regenerate-app-skill');
    expect(reference).toMatch(/approval.*before.*app product skill/i);
  });
});
