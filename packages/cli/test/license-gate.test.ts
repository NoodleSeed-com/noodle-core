import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  isAllowedException,
  licenseOf,
  repositoryLicensePolicyErrors,
} from '../../../scripts/license-gate.mjs';

describe('scripts/license-gate.mjs', () => {
  const canonicalLicense = readFileSync(join(import.meta.dirname, '..', 'LICENSE'), 'utf8');

  it('rejects a contradictory MIT repository license and foreign attribution', () => {
    expect(
      repositoryLicensePolicyErrors({
        license: 'MIT License\n\nCopyright (c) 2024 Anthropic, PBC\n',
        cliLicense: canonicalLicense,
        notice: 'Copyright 2026 TheNoodleSeed Corporation\n',
        rootManifest: { name: 'noodle-core', license: 'Apache-2.0' },
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining('canonical Apache-2.0'),
        expect.stringContaining('must match the root LICENSE'),
      ]),
    );
  });

  it('rejects the wrong copyright holder and missing public SPDX metadata', () => {
    expect(
      repositoryLicensePolicyErrors({
        license: canonicalLicense,
        cliLicense: canonicalLicense,
        notice: 'Copyright 2026 Noodle Seed\n',
        rootManifest: { name: 'noodle-core', private: true },
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining('TheNoodleSeed Corporation'),
        expect.stringContaining('must declare Apache-2.0'),
      ]),
    );
  });

  it('accepts the canonical Apache repository policy', () => {
    expect(
      repositoryLicensePolicyErrors({
        license: canonicalLicense,
        cliLicense: canonicalLicense,
        notice: 'Noodle Seed / Noodle Borg\nCopyright 2026 TheNoodleSeed Corporation\n',
        rootManifest: { name: 'noodle-core', private: true, license: 'Apache-2.0' },
      }),
    ).toEqual([]);
  });

  it('gives every workspace package an explicit open or proprietary license', () => {
    const repoRoot = join(import.meta.dirname, '..', '..', '..');
    const manifests = ['packages', 'apps'].flatMap((root) =>
      readdirSync(join(repoRoot, root), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(repoRoot, root, entry.name, 'package.json'))
        .filter((manifestPath) => existsSync(manifestPath)),
    );

    for (const manifestPath of manifests) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        name: string;
        private?: boolean;
        license?: string;
      };
      expect(
        ['Apache-2.0', 'UNLICENSED'],
        `${manifest.name} must declare Apache-2.0 or UNLICENSED`,
      ).toContain(manifest.license);
      if (manifest.license === 'UNLICENSED') expect(manifest.private).toBe(true);
    }
  });

  it('reports the same "Unknown" casing as `pnpm licenses list` for a package with no license metadata', () => {
    // mermaid's `khroma` dependency ships an MIT `license` FILE but omits the SPDX `license` FIELD;
    // `pnpm licenses list --json` reports packages like this as `Unknown` (capital U only).
    expect(licenseOf({ name: 'khroma', version: '2.1.0' })).toBe('Unknown');
  });

  it('reads the license from a string `license` field', () => {
    expect(licenseOf({ name: 'foo', license: 'MIT' })).toBe('MIT');
  });

  it('applies the documented khroma exception under the installed-tree fallback path', () => {
    // Regression test: the installed-tree fallback previously returned `UNKNOWN` (all caps),
    // which never matched the `license === 'Unknown'` check in isAllowedException, so the
    // ground-truth-verified MIT exception for khroma silently never applied via that path.
    const license = licenseOf({ name: 'khroma', version: '2.1.0' });
    expect(isAllowedException(license, 'khroma')).toBe(true);
  });

  it('applies the verified MIT exception for react-share transitive jsonp metadata', () => {
    const license = licenseOf({ name: 'jsonp', version: '0.2.1' });
    expect(license).toBe('Unknown');
    expect(isAllowedException(license, 'jsonp')).toBe(true);
  });

  it('does not exempt an unrelated package lacking license metadata', () => {
    const license = licenseOf({ name: 'some-copyleft-thing', version: '1.0.0' });
    expect(isAllowedException(license, 'some-copyleft-thing')).toBe(false);
  });
});
