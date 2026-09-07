import { describe, expect, it } from 'vitest';
import app from '../src/server.js';

describe('hello example', () => {
  it('exports a Noodle server definition', () => {
    expect(typeof app.toManifest).toBe('function');
  });

  it('advertises the greet default and keeps the argument optional', async () => {
    const manifest = await app.toManifest();
    const greet = manifest.tools?.find((tool) => tool.name === 'greet');
    const schema = greet?.inputSchema as {
      properties?: { name?: { default?: unknown } };
      required?: string[];
    };
    expect(schema.properties?.name?.default).toBe('world');
    expect(schema.required ?? []).not.toContain('name');
  });
});
