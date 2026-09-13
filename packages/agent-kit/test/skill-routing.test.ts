import { describe, expect, it } from 'vitest';
import { BEHAVIOR_SKILLS } from '../src/behavior-skills.js';
import { renderAgentFiles, renderManagedBlock } from '../src/index.js';
import { SKILL_REFERENCES } from '../src/skill-content.js';
import {
  APP_DIRECTORY_COMPLIANCE_REFERENCE,
  SKILL_DESCRIPTION,
  SKILL_ROUTES,
  type SkillRoute,
  skillRouterBody,
} from '../src/skill-router.js';

const EXPECTED_ROUTES = {
  'design-product': 'references/experience-design.md',
  'create-product-guide': 'references/product-agent-guides.md',
  'wrap-existing-app': 'references/wrap-existing-app.md',
  'build-server': 'references/build-an-mcp-server.md',
  'connect-api': 'references/connect-an-api.md',
  'build-app': 'references/build-an-mcp-app.md',
  'verify-recover': 'references/verify-and-recover.md',
  'debug-recover': 'references/verify-and-recover.md',
  'inspect-hosted': 'references/verify-and-recover.md',
  'deploy-hosted': 'references/deploy-and-ops.md',
  'embed-assistant': 'references/embedded-assistant.md',
  publish: 'references/publishing.md',
  feedback: 'references/feedback.md',
} as const;

function skillForRoute(route: SkillRoute) {
  const skill = BEHAVIOR_SKILLS.find((candidate) => candidate.name === route.skill);
  if (skill === undefined) throw new Error(`missing behavior skill for route ${route.id}`);
  return skill;
}

describe('project skill intent routing', () => {
  it('routes standalone preflight to verification without granting publication authority', () => {
    const router = skillRouterBody('codex');
    expect(router).toContain('may inspect `deploy preflight`');
    const verification = SKILL_REFERENCES.find(
      (reference) => reference.relPath === 'references/verify-and-recover.md',
    );
    expect(verification).toBeDefined();
    expect(verification?.render()).toContain('preflight_build');
  });
  it('defines one primary reference for every supported MCP outcome', () => {
    expect(
      Object.fromEntries(
        SKILL_ROUTES.map((route) => [route.id, skillForRoute(route).primaryReference]),
      ),
    ).toEqual(EXPECTED_ROUTES);
    expect(new Set(SKILL_ROUTES.map((route) => route.id)).size).toBe(SKILL_ROUTES.length);
    expect(SKILL_ROUTES.every((route) => route.exitCondition.trim().length > 0)).toBe(true);
    for (const route of SKILL_ROUTES) {
      expect(route).not.toHaveProperty('primaryReference');
      expect(route).not.toHaveProperty('supportingReferences');
    }
  });

  it('keeps each route bounded to one primary and at most two supporting references', () => {
    for (const route of SKILL_ROUTES) {
      const skill = skillForRoute(route);
      expect(skill.primaryReference).toMatch(/^references\/[a-z-]+\.md$/);
      expect(skill.supportingReferences.length).toBeLessThanOrEqual(2);
      expect(new Set(skill.supportingReferences).size).toBe(skill.supportingReferences.length);
      expect(skill.supportingReferences).not.toContain(skill.primaryReference);
    }
  });

  it('routes only to references that ship in the generated skill tree', () => {
    const shipped = new Set(SKILL_REFERENCES.map((reference) => reference.relPath));
    for (const route of SKILL_ROUTES) {
      const skill = skillForRoute(route);
      expect(shipped.has(skill.primaryReference)).toBe(true);
      for (const supporting of skill.supportingReferences)
        expect(shipped.has(supporting)).toBe(true);
    }
  });

  it('loads one primary route instead of scanning the reference catalog', () => {
    for (const target of ['codex', 'claude-code'] as const) {
      const router = skillRouterBody(target);
      expect(router).toMatch(/choose (?:exactly )?one primary route/i);
      expect(router).toMatch(/read (?:the|that) primary reference in full/i);
      expect(router).toMatch(/supporting references only/i);
      expect(router).toMatch(/lookup catalog/i);
      expect(router).not.toMatch(/scan all|scan the .*index|scan its .*index/i);
      expect(router).toMatch(
        /all four.*API base URL.*authentication scheme.*representative safe read.*observed response.*connecting-apis-to-mcp/i,
      );
      expect(router).toMatch(/hosted inspection.*read-only/i);
      for (const route of SKILL_ROUTES) {
        expect(router).toContain(skillForRoute(route).primaryReference);
        expect(router).toContain(route.exitCondition);
      }
    }
  });

  it('routes a missing API to planning before ordinary API connection or generic server work', () => {
    const router = skillRouterBody('codex');
    expect(router).toMatch(
      /no stable, usable API or specification.*wrapping-existing-applications/i,
    );
    expect(router).toMatch(
      /all four.*API base URL.*authentication scheme.*representative safe read.*observed response.*connecting-apis-to-mcp/i,
    );
    expect(router).toMatch(
      /missing, stale, inaccessible, undocumented-only, or otherwise unusable evidence.*wrapping-existing-applications/i,
    );
    expect(router).toMatch(/both integration routes take precedence over generic server building/i);
  });

  it('routes a vague account-growth start to the continuous-onboarding workflow', () => {
    const router = skillRouterBody('codex');

    expect(SKILL_DESCRIPTION).toMatch(/signup or onboarding conversion/i);
    expect(router).toContain('## First-workflow heuristic');
    expect(router).toMatch(/inspect the repository and product context/i);
    expect(router).toMatch(/do not classify.*from an industry label alone/i);
    expect(router).toMatch(
      /public visitor surface.*signup or sign-in.*useful pre-account result.*authenticated outcome/is,
    );
    expect(router).toMatch(
      /recommend public-to-product continuous onboarding.*embedding-mcp-assistants/is,
    );
    expect(router).toMatch(/ask only for the smallest missing fit fact/i);
  });

  it('keeps the rendered route table as strict as the precedence paragraph', () => {
    const router = skillRouterBody('codex');
    const connectRoute = SKILL_ROUTES.find((route) => route.id === 'connect-api');
    expect(connectRoute?.intent).toMatch(
      /all four.*API base URL.*authentication scheme.*representative safe read.*observed response/i,
    );
    expect(router).toContain(connectRoute?.intent);
    expect(router).toMatch(
      /all four.*API base URL.*authentication scheme.*representative safe read.*observed response.*connecting-apis-to-mcp/i,
    );
    expect(router).toMatch(
      /missing, stale, inaccessible, undocumented-only, or otherwise unusable evidence.*wrapping-existing-applications/i,
    );
  });

  it('keeps inspect-only, prepare-only, and local-only requests away from hosted mutation', () => {
    for (const target of ['codex', 'claude-code'] as const) {
      const router = skillRouterBody(target);
      expect(router).toContain('“Inspect hosted logs/status” → `inspect-hosted`');
      expect(router).toContain('“Prepare for deployment”');
      expect(router).toContain('“Keep this local”');
      expect(router).toMatch(/does not authorize `link`, hosted config, publication, rollback/i);
      expect(router).toMatch(
        /current user request explicitly authorizes the exact mutation and target/i,
      );
    }
  });

  it('keeps headless server work out of app-design references', () => {
    const serverRoute = SKILL_ROUTES.find((route) => route.id === 'build-server');
    const appRoute = SKILL_ROUTES.find((route) => route.id === 'build-app');
    expect(serverRoute).toBeDefined();
    if (serverRoute === undefined || appRoute === undefined) throw new Error('missing route');
    expect(skillForRoute(serverRoute).supportingReferences).not.toContain(
      'references/experience-design.md',
    );
    expect(skillForRoute(serverRoute).supportingReferences).not.toContain(
      'references/widgets-and-apps.md',
    );
    expect(skillForRoute(appRoute).supportingReferences).toContain(
      'references/experience-design.md',
    );
  });

  it('gives the generated host block the same progressive-disclosure rule', () => {
    for (const target of ['codex', 'claude-code'] as const) {
      const block = renderManagedBlock({ target });
      expect(block).toMatch(/choose (?:exactly )?one primary route/i);
      expect(block).toMatch(/supporting references only/i);
      expect(block).not.toMatch(/scan all|scan its .*index/i);
      expect(block).not.toMatch(/design the experience before authoring/i);
      expect(block).not.toContain('## Widget design default');
      expect(block).toMatch(/current user request explicitly authorizes/i);
    }
  });

  it('uses configured-entrypoint terminology in the managed authoring route', () => {
    const block = renderManagedBlock({
      target: 'codex',
      project: { entrypoint: 'src/custom-entry.ts' },
    });
    expect(block).toMatch(/author.*configured TypeScript entrypoint/i);
    expect(block).not.toContain('edit `src/server.ts`');
  });

  it('keeps the rendered publishing route host-neutral and uses a neutral compliance path', () => {
    for (const target of ['codex', 'claude-code'] as const) {
      const routeFiles = renderAgentFiles({ targets: [target] }).filter(
        (file) =>
          (file.skill === 'noodle-seed' && file.path.endsWith('/SKILL.md')) ||
          (file.skill === 'publishing-mcp-integrations' && file.path.endsWith('/SKILL.md')) ||
          file.path.endsWith('/references/publishing.md') ||
          file.path.endsWith(`/${APP_DIRECTORY_COMPLIANCE_REFERENCE}`),
      );
      expect(routeFiles).toHaveLength(6);
      for (const file of routeFiles) {
        expect(file.content, file.path).not.toMatch(
          /ChatGPT|Claude|Codex|Cursor|MCP Inspector|OpenAI|Anthropic|React|VS Code/i,
        );
      }
      const router = routeFiles.find((file) => file.skill === 'noodle-seed')?.content ?? '';
      expect(router).toContain('references/app-directory-compliance.md');
      expect(router).not.toContain('references/chatgpt-compliance.md');
    }
  });

  it('keeps hosted mutation guidance at the routing and authorization boundary', () => {
    const deployReference = SKILL_REFERENCES.find(
      (reference) => reference.relPath === 'references/deploy-and-ops.md',
    )?.render();
    expect(deployReference).toBeDefined();
    expect(deployReference).toContain('references/cli-commands.md');
    expect(deployReference).toMatch(/organization.*application.*environment/i);
    expect(deployReference).toMatch(/when .*environment.*absent.*stop and ask/i);
    expect(deployReference).not.toMatch(
      /noodle (?:login|link|target|deploy|rollback|open|status|inspect|smoke)\b/i,
    );
  });

  it('routes directory compliance through the neutral canonical reference', () => {
    const publishingReference = SKILL_REFERENCES.find(
      (reference) => reference.relPath === 'references/publishing.md',
    )?.render();
    expect(publishingReference).toBeDefined();
    expect(publishingReference).toContain('references/app-directory-compliance.md');
    expect(publishingReference).not.toContain('references/chatgpt-compliance.md');
  });

  it('teaches the separate TypeScript distribution source and bounded target export', () => {
    const publishingReference = SKILL_REFERENCES.find(
      (reference) => reference.relPath === 'references/publishing.md',
    )?.render();
    expect(publishingReference).toBeDefined();
    expect(publishingReference).toMatch(/`distribution`.*`server\.ts`/i);
    expect(publishingReference).toMatch(/listing.*publisher.*support.*legal.*assets.*review/i);
    expect(publishingReference).toMatch(/App Package.*Runtime Artifact.*unchanged/i);
    expect(publishingReference).toMatch(/credential.*out of.*metadata/i);
    expect(publishingReference).toMatch(/screenshot.*separate user `prompt`/i);
    expect(publishingReference).toMatch(/only the rendered MCP App response/i);
    expect(publishingReference).toMatch(/separate installable-plugin.*remote-connector/i);
    expect(publishingReference).toMatch(/target-specific.*live command catalog/i);
    expect(publishingReference).toMatch(/local.*submission.*distinct/i);
    expect(publishingReference).toMatch(/does not.*register.*submit.*publish/i);
  });

  it('teaches authenticated distribution as an exact deployment-bound operation', () => {
    const publishingReference = SKILL_REFERENCES.find(
      (reference) => reference.relPath === 'references/publishing.md',
    )?.render();
    expect(publishingReference).toBeDefined();
    expect(publishingReference).toMatch(
      /noodle distributions publish <deployment-id> \[server\.ts\] --target <target>/i,
    );
    expect(publishingReference).toMatch(/local.*snapshot.*exact.*deployment/i);
    expect(publishingReference).toMatch(
      /noodle distributions list.*noodle distributions inspect.*noodle distributions download/is,
    );
    expect(publishingReference).toMatch(/download.*verif.*atomic/i);
    expect(publishingReference).toMatch(/does not.*submit.*external directory/i);
  });

  it('documents the universal JSON envelope without a hosted-command caveat', () => {
    for (const target of ['codex', 'claude-code'] as const) {
      const block = renderManagedBlock({ target });
      expect(block).toMatch(/every `--json` command/i);
      expect(block).toMatch(/exactly one envelope on stdout/i);
      expect(block).not.toMatch(/still being normalized/i);
    }
  });

  it('leaves unrelated project work outside the Noodle lifecycle', () => {
    for (const target of ['codex', 'claude-code'] as const) {
      const router = skillRouterBody(target);
      const block = renderManagedBlock({ target });
      for (const text of [router, block]) {
        expect(text).toMatch(/unrelated to (?:the )?Noodle MCP (?:surface|server or app)/i);
        expect(text).toMatch(/follow the project's normal instructions/i);
        expect(text).toMatch(/run no Noodle lifecycle commands/i);
      }
    }
  });

  it('renders the same route contract into both installed targets', () => {
    const routers = renderAgentFiles({})
      .filter((file) => file.skill === 'noodle-seed' && file.path.endsWith('/SKILL.md'))
      .map((file) => file.content);
    expect(routers).toHaveLength(2);
    for (const route of SKILL_ROUTES) {
      for (const router of routers) expect(router).toContain(skillForRoute(route).primaryReference);
    }
  });
});
