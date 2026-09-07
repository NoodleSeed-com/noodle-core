import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import app from '../src/server.js';

describe('internal-ops-demo example', () => {
  it('exports a Noodle server definition', () => {
    expect(typeof app.toManifest).toBe('function');
  });

  it('documents the managed deploy-to-remote-inspection handoff', () => {
    const readme = readFileSync(join(import.meta.dirname, '..', 'README.md'), 'utf8');
    expect(readme).toContain('deploy --json');
    expect(readme).toContain('noodle-developer.inspect_deployment');
    expect(readme).toContain('noodle-developer.diagnose_app');
    expect(readme).toMatch(/coding agent still authors and tests/i);
  });
});
