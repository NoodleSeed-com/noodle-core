import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * The browser embed script, read from the published `@noodleseed/assistant` build.
 *
 * Served from the service origin rather than a CDN (ADR 0201): there is no new release lane to run, the
 * script is always the one that matches the deployed service, and a CDN can front the URL later without
 * changing a single byte a customer pasted.
 *
 * Read once and cached. The file is immutable for the life of the process — it ships inside the image —
 * so re-reading it per request would buy nothing but syscalls.
 */

export interface EmbedScript {
  readonly bytes: Buffer;
  /** Content-derived, so a redeployed service with an unchanged bundle keeps browsers' caches warm. */
  readonly etag: string;
}

export type EmbedScriptResult =
  | { readonly ok: true; readonly script: EmbedScript }
  | { readonly ok: false; readonly reason: string };

let cached: EmbedScriptResult | undefined;

export function loadEmbedScript(): EmbedScriptResult {
  cached ??= read();
  return cached;
}

function read(): EmbedScriptResult {
  try {
    // Resolved through the package's own `exports` map, which publishes `package.json` but not the
    // build output — so the manifest is the only resolvable anchor for the dist directory.
    const manifest = createRequire(import.meta.url).resolve('@noodleseed/assistant/package.json');
    const bytes = readFileSync(join(dirname(manifest), 'dist', 'embed.global.js'));
    return {
      ok: true,
      script: {
        bytes,
        etag: `"${createHash('sha256').update(bytes).digest('base64url').slice(0, 27)}"`,
      },
    };
  } catch {
    // A source tree whose SDK has not been built yet. Naming the command beats a stack trace, and an
    // explicit failure beats serving nothing with a 200.
    return {
      ok: false,
      reason: 'the embed script is not built; run `pnpm --filter @noodleseed/assistant build`',
    };
  }
}
