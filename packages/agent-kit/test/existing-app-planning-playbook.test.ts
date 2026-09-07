import { describe, expect, it } from 'vitest';
import { renderAgentFiles } from '../src/index.js';

function planningPlaybook(): string {
  const content = renderAgentFiles({}).find((file) =>
    file.path.endsWith('/references/wrap-existing-app.md'),
  )?.content;
  expect(content).toBeDefined();
  return content ?? '';
}

describe('existing application integration planning playbook', () => {
  it('uses the shared capability-playbook contract', () => {
    const playbook = planningPlaybook();
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

  it('asks identity first and separates inbound identity from downstream authorization', () => {
    const playbook = planningPlaybook();
    const identityQuestion = playbook.indexOf('identity provider');
    const connectorDecision = playbook.indexOf('static `http` connector');
    expect(identityQuestion).toBeGreaterThan(-1);
    expect(connectorDecision).toBeGreaterThan(identityQuestion);
    expect(playbook).toMatch(/inbound MCP identity/i);
    expect(playbook).toMatch(/downstream application authorization/i);
    expect(playbook).toMatch(/attribution, not per-user authorization/i);
    expect(playbook).toMatch(/application session.*not.*inbound customer identity/i);
    expect(playbook).toMatch(/generic identity bridge.*demand-gated.*not shipped/i);
  });

  it('states the honest application cost and static-origin routing boundary', () => {
    const playbook = planningPlaybook();
    expect(playbook).toMatch(/one compatible token endpoint/i);
    expect(playbook).toMatch(/route adapter|thin HTTP handler/i);
    expect(playbook).toMatch(/one static preconfigured downstream origin/i);
    expect(playbook).toMatch(/multi-origin.*(?:stop|hand off)|(?:stop|hand off).*multi-origin/i);
    expect(playbook).toMatch(/browser.*model.*tool.*caller.*cannot select an origin/i);
    expect(playbook).not.toMatch(/customer routing/i);
  });

  it('requires credential-bearing origins to stay on HTTPS without redirects', () => {
    const playbook = planningPlaybook();
    expect(playbook).toMatch(/service or delegated credential.*HTTPS/i);
    expect(playbook).toMatch(/reject redirects.*service or delegated credentials/i);
  });

  it('requires usable API evidence before handing off to API connection', () => {
    const playbook = planningPlaybook();
    expect(playbook).toMatch(
      /all four.*API base URL.*authentication scheme.*representative safe read.*observed response.*API-connection route/i,
    );
    expect(playbook).toMatch(
      /stale, inaccessible, undocumented-only, or otherwise unusable.*existing-application planning route/i,
    );
  });

  it('plans an adapter when the origin is stable but no safe HTTP seam exists', () => {
    const playbook = planningPlaybook();
    expect(playbook).toMatch(
      /stable origin.*no safe stable HTTP boundary.*smallest application-owned stable HTTPS adapter over existing business functions/i,
    );
    expect(playbook).not.toMatch(/stop blocked when.*stable HTTP seam/i);
  });

  it('leaves missing safe live evidence unproven instead of blocking the plan', () => {
    const playbook = planningPlaybook();
    expect(playbook).toMatch(
      /safe live verification input or working credential.*explicitly unproven.*exact prerequisite/i,
    );
    expect(playbook).not.toMatch(/stop blocked when.*safe verification input/i);
  });

  it('plans intent tools without becoming an importer or conformance command', () => {
    const playbook = planningPlaybook();
    expect(playbook).toMatch(/five to twelve/i);
    expect(playbook).toMatch(/budget, not a minimum/i);
    expect(playbook).toMatch(/not one tool per/i);
    expect(playbook).toMatch(/does not add an importer/i);
    expect(playbook).toMatch(/does not prove general schema conformance/i);
  });

  it('keeps discovery read-only and hands approved work to the existing executor', () => {
    const playbook = planningPlaybook();
    expect(playbook).toMatch(/read-only/i);
    expect(playbook).toMatch(/never read or print.*\.env/i);
    expect(playbook).toMatch(/present.*conversation.*stop/i);
    expect(playbook).toContain('executing-noodle-plans');
    expect(playbook).toMatch(/does not authorize.*hosted/i);
  });

  it('rejects unstable and unsafe integration seams without naming frameworks', () => {
    const playbook = planningPlaybook();
    expect(playbook).toMatch(/unstable server-call protocol/i);
    expect(playbook).toMatch(/direct (?:ORM or )?SQL|direct database/i);
    expect(playbook).toMatch(/copying.*browser session/i);
    expect(playbook).not.toMatch(/\b(?:Next\.js|Django|Rails|Laravel)\b/i);
  });
});
