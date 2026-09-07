import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { manifestJsonSchema } from '../src/schema-export.js';

/**
 * JSON Schema drift gate (ADR 0150): the committed `manifest.schema.json` is the published Core v1
 * manifest contract. Editing `src/manifest/schema.ts` without regenerating it (`pnpm schema`) fails
 * here, so the normative export can never silently drift from the zod source of truth.
 */
describe('manifest.schema.json drift gate (ADR 0150)', () => {
  it('matches an in-memory regeneration from the zod schema', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const committed = JSON.parse(
      readFileSync(join(here, '..', 'manifest.schema.json'), 'utf8'),
    ) as unknown;
    expect(
      committed,
      'stale manifest.schema.json — run `pnpm schema` and commit the result',
    ).toEqual(manifestJsonSchema());
  });
});
