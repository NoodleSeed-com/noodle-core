import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { featureRegistryMarkdown } from '@noodle-borg/capabilities';
import { describe, expect, it, vi } from 'vitest';
import { run } from '../src/index.js';

describe('noodle features', () => {
  it('prints the machine-readable host compatibility registry', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await run(['features', '--host', 'embedded', '--json'])).toBe(0);
    const body = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(body.data.features).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'mcp-apps' })]),
    );
    expect(body.features).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'sampling' })]),
    );
    log.mockRestore();
  });

  it('keeps the generated compatibility changelog synchronized', () => {
    const path = join(
      import.meta.dirname,
      '..',
      '..',
      '..',
      'docs',
      'references',
      'compatibility-features.md',
    );
    expect(readFileSync(path, 'utf8')).toBe(featureRegistryMarkdown());
  });
});
