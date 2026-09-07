import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const exporterPath = join(here, '..', 'dist', 'schema-export.js');
const tempSchemaPath = join(here, '..', 'dist', 'temp-manifest-schema.json');

describe('CLI schema-export', () => {
  it('generates the manifest JSON schema and writes it to the designated file', () => {
    // Ensure cleanup first
    if (existsSync(tempSchemaPath)) unlinkSync(tempSchemaPath);

    const proc = spawnSync('node', [exporterPath, tempSchemaPath], { encoding: 'utf8' });
    expect(proc.status).toBe(0);
    expect(proc.stdout).toContain(`Wrote ${tempSchemaPath}`);
    expect(existsSync(tempSchemaPath)).toBe(true);

    const content = JSON.parse(readFileSync(tempSchemaPath, 'utf8'));
    expect(content.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(content.oneOf).toHaveLength(2);
    const coreV2 = content.oneOf.find(
      (candidate: { properties?: { manifestVersion?: { const?: string } } }) =>
        candidate.properties?.manifestVersion?.const === '2',
    );
    expect(coreV2?.properties?.server?.properties?.agentGuide).toMatchObject({
      type: 'object',
      additionalProperties: false,
    });

    // Clean up
    unlinkSync(tempSchemaPath);
  });
});
