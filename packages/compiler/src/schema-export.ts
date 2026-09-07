import { realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { manifestSchema } from './manifest/schema.js';

/**
 * Emit the manifest's own contract as a JSON Schema 2020-12 document, generated natively by Zod 4.
 * This both publishes the manifest contract and proves the Zod -> 2020-12 path end to end.
 */
export function manifestJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(manifestSchema, { target: 'draft-2020-12' }) as Record<string, unknown>;
}

function isInvokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isInvokedDirectly()) {
  const out = process.argv[2] ?? 'manifest.schema.json';
  writeFileSync(out, `${JSON.stringify(manifestJsonSchema(), null, 2)}\n`);
  process.stdout.write(`Wrote ${out}\n`);
}
