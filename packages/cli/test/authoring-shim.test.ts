import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as authoringBarrel from '@noodle-borg/authoring';
import * as authoringReact from '@noodle-borg/authoring/react';
import { describe, expect, it } from 'vitest';

/**
 * `@noodleseed/one` deploy-time shim parity gate (ADR 0150): `src/deploy.ts` writes a module shim
 * re-exporting fixed name lists from `@noodle-borg/authoring`. Every shimmed name must exist on the
 * real entry (or authors get a load-time crash), and the lists are pinned here so the public package
 * surface cannot drift silently. The barrel's own snapshot lives in
 * `packages/authoring/test/exports-snapshot.test.ts`.
 */

const here = dirname(fileURLToPath(import.meta.url));
// The deploy-time shim lives in the authoring package since the authored-entrypoint loader moved
// there (2026-08-15); the parity gate reads the shipped source, wherever it owns the shim strings.
const deploySource = readFileSync(
  join(here, '..', '..', 'authoring', 'src', 'load-authored.ts'),
  'utf8',
);

/** All `export { ... } from '@noodle-borg/authoring<entry>';` lists in source order. */
function shimExportLists(entry: string): string[][] {
  const pattern = new RegExp(`export \\{ ([^}]+) \\} from '@noodle-borg/authoring${entry}';`, 'g');
  return [...deploySource.matchAll(pattern)].map((match) =>
    (match[1] ?? '').split(',').map((name) => name.trim()),
  );
}

describe('@noodleseed/one deploy-time shim (ADR 0150)', () => {
  it('the index and platform shims re-export exactly the committed names', () => {
    const [indexShim, platformShim] = shimExportLists('');
    expect(indexShim).toEqual([
      'algolia',
      'annotations',
      'asset',
      'authenticatedWebsite',
      'bind',
      'clientCredentials',
      'connector',
      'connection',
      'customerAuth',
      'customerEndpoint',
      'embeddedAssistant',
      'externalExchange',
      'file',
      'firecrawl',
      'gmailConnector',
      'googleWorkloadIdentity',
      'handoffSession',
      'knowledge',
      'managedCollection',
      'managedSecret',
      'meilisearch',
      'noodleManaged',
      'openAICompatible',
      'prompt',
      'publicWebsite',
      'resource',
      'secret',
      'server',
      'site',
      'tavily',
      'tool',
      'variable',
      'when',
      'z',
    ]);
    expect(platformShim).toEqual(['noodlePlatform', 'noodlePlatformCatalog']);
    for (const name of [...(indexShim ?? []), ...(platformShim ?? [])]) {
      expect(name in authoringBarrel, `"${name}" missing from @noodle-borg/authoring`).toBe(true);
    }
  });

  it('the index shim carries every authoring name the published package re-exports', () => {
    // The dev/deploy loader and the published `@noodleseed/one` index must expose one surface: a name
    // exported by one and not the other loads in production and crashes under `noodle dev`.
    const published = readFileSync(join(here, '..', 'src', 'index.ts'), 'utf8');
    const publishedNames = [
      ...published.matchAll(/export \{([^}]+)\} from '@noodle-borg\/authoring';/g),
    ]
      .flatMap((match) => (match[1] ?? '').split(','))
      .map((name) => name.trim())
      .filter((name) => name.length > 0 && !name.startsWith('type '))
      .map((name) => name.split(' as ').at(-1)?.trim() ?? name)
      .sort();
    const [indexShim] = shimExportLists('');
    expect([...(indexShim ?? [])].sort()).toEqual(publishedNames);
  });

  it('the react shim mirrors the published react entry (everything, like packages/cli/src/react.ts)', () => {
    expect(deploySource).toContain("export * from '@noodle-borg/authoring/react';");
    expect(readFileSync(join(here, '..', 'src', 'react.ts'), 'utf8')).toContain(
      "export * from '@noodle-borg/authoring/react';",
    );
    expect('generateHelpers' in authoringReact).toBe(true);
  });
});
