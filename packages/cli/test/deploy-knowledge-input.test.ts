import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readDeployInput } from '../src/deploy.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, 'fixtures', 'knowledge-server', 'server.ts');

/**
 * The regression that reached production 2026-08-17: `readDeployInput` returned the authored
 * manifest with unhashed knowledge documents, so every hosted deploy of a knowledge-bearing app
 * failed service preflight with `knowledge_unhashed`. The browser E2E deployed through
 * `registry.deploy` directly and never exercised this leg; `deploy` submits exactly this
 * manifest, so the hashes must already be present here.
 */
describe('readDeployInput with authored knowledge', () => {
  it('embeds the content hash and byte count every deploy submission requires', async () => {
    const input = await readDeployInput(fixture);
    const manifest = JSON.parse(input.manifest) as {
      server: {
        knowledge?: { documents: { path: string; sha256?: string; bytes?: number }[] }[];
      };
    };
    const documents = manifest.server.knowledge?.[0]?.documents ?? [];
    expect(documents).toHaveLength(1);
    const bytes = readFileSync(join(dirname(fixture), 'knowledge', 'guide.md'));
    expect(documents[0]?.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(documents[0]?.bytes).toBe(bytes.byteLength);
  });
});
