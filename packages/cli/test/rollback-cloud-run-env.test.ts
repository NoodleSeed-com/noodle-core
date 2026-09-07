import { describe, expect, it } from 'vitest';
import {
  buildListCommand,
  buildRollbackCommand,
  resolveEnvTarget,
} from '../../../scripts/rollback-cloud-run.mjs';

// Slice A3: `--env dev|staging|prod` selects the tier by PROJECT — the service name is `borg-service`
// in every environment (the project is the namespace, docs/deploy/environments.md).
describe('rollback-cloud-run --env mapping', () => {
  it('maps each env to its project with the shared service name', () => {
    expect(resolveEnvTarget('dev')).toEqual({ project: 'noodle-borg-dev' });
    expect(resolveEnvTarget('staging')).toEqual({ project: 'noodle-borg-staging' });
    expect(resolveEnvTarget('prod')).toEqual({ project: 'noodle-borg' });
  });

  it('rejects unknown environments', () => {
    expect(() => resolveEnvTarget('production')).toThrow(/dev\|staging\|prod/);
  });

  it('builds tier-correct commands from an env target', () => {
    const target = {
      service: 'borg-service',
      region: 'us-central1',
      ...resolveEnvTarget('staging'),
    };
    expect(buildListCommand(target)).toContain('--project=noodle-borg-staging');
    expect(buildRollbackCommand(target, 'borg-service-00002-abc')).toContain(
      '--project=noodle-borg-staging',
    );
  });

  it('combines --env with a non-default service (the documented app-tier rollback shape)', () => {
    // docs/deploy/docs-hosting.md rolls back the docs tier with `--env prod --service noodleseed-docs`:
    // --env picks the PROJECT only, so an explicit service name must ride along untouched.
    const target = {
      region: 'us-central1',
      service: 'noodleseed-docs',
      ...resolveEnvTarget('prod'),
    };
    const list = buildListCommand(target);
    expect(list).toContain('--project=noodle-borg');
    expect(list).toContain('--service=noodleseed-docs');
  });
});
