import { describe, expect, it } from 'vitest';
import { compile } from '../src/compile.js';

/** A minimal valid manifest with an optional extra line spliced into the `server` block. */
function manifest(serverExtra = ''): string {
  return `
manifestVersion: "1"
server:
  name: acme
  version: 1.0.0
  title: Acme
${serverExtra}tools:
  - name: ping
    description: Ping.
    inputSchema:
      type: object
    fulfilment:
      steps: []
      output:
        ok: true
`;
}

describe('server.instructions', () => {
  it('round-trips manifest instructions into the artifact server', () => {
    const result = compile(manifest('  instructions: Use the ping tool before anything else.\n'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.server.instructions).toBe('Use the ping tool before anything else.');
  });

  it('leaves the field absent when the manifest omits it', () => {
    const result = compile(manifest());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.server).not.toHaveProperty('instructions');
  });

  it('trims surrounding whitespace', () => {
    const result = compile(manifest('  instructions: "  Spaced out.  "\n'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.server.instructions).toBe('Spaced out.');
  });

  it('rejects whitespace-only instructions', () => {
    const result = compile(manifest('  instructions: "   "\n'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.path === 'server.instructions')).toBe(true);
  });

  it('rejects instructions longer than 4000 characters', () => {
    const result = compile(manifest(`  instructions: "${'x'.repeat(4001)}"\n`));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.path === 'server.instructions')).toBe(true);
  });
});
