import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Guards ADR 0120 decision 4 as amended by slice A4 (ADR 0119): with a static-only `CI`, "green CI on
// main" never implies build/tests pass. The pipeline owns dev + staging and system-release.yml owns every
// production mutation, including npm publication.
const repoRoot = join(import.meta.dirname, '..', '..', '..');

describe('downstream workflow triggers (ADR 0120 + slice A4)', () => {
  it('the retired app auto-deploy workflows stay deleted (slice A4: pipeline owns app deploys)', () => {
    for (const name of ['deploy-website.yml', 'deploy-docs.yml', 'deploy-console.yml']) {
      expect(
        existsSync(join(repoRoot, '.github', 'workflows', name)),
        `${name} was retired by slice A4 — deploy-pipeline.yml owns dev/staging app deploys and website production`,
      ).toBe(false);
    }
  });

  it('retires every component-selectable production and npm workflow', () => {
    for (const name of [
      'deploy-cloud-run.yml',
      'publish-cli.yml',
      'publish-agent-kit.yml',
      'publish-assistant.yml',
    ]) {
      expect(existsSync(join(repoRoot, '.github', 'workflows', name)), name).toBe(false);
    }
  });

  it('retires the parallel Release Please and component repair workflows', () => {
    for (const name of ['release-please.yml', 'release-repair.yml', 'release-watchdog.yml']) {
      expect(existsSync(join(repoRoot, '.github', 'workflows', name)), name).toBe(false);
    }
  });
});
