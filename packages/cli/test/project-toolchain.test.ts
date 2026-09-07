import { describe, expect, it } from 'vitest';
import { helloFiles, httpApiFiles } from '../src/project-scaffold-templates.js';
import {
  installArguments,
  projectDependencyPins,
  selectPackageManager,
} from '../src/project-toolchain.js';
import { currentCliVersion } from '../src/update.js';
import { widgetFiles } from '../src/widget-scaffold-template.js';

describe('deterministic project-local toolchain', () => {
  it('refuses unreviewed dependencies at the owning scaffold generator', () => {
    expect(() => projectDependencyPins(['surprise'])).toThrow(/no qualified version/);
  });
  it('pins the running CLI and all declared starter dependencies exactly', () => {
    for (const files of [
      helloFiles('test', []),
      httpApiFiles('test', []),
      widgetFiles('test', []),
      widgetFiles('test', [], 'saas'),
    ]) {
      const manifest = JSON.parse(files['package.json'] ?? '{}');
      expect(manifest.devDependencies['@noodleseed/one']).toBe(currentCliVersion());
      for (const version of Object.values(manifest.devDependencies))
        expect(version).toMatch(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
    }
  });

  it('prefers existing project ownership over the invoking npx package manager', () => {
    expect(
      selectPackageManager({ lockfiles: ['pnpm-lock.yaml'], userAgent: 'npm/11.12.0 node/v24' }),
    ).toBe('pnpm');
    expect(selectPackageManager({ packageManager: 'yarn@4.14.1' })).toBe('yarn');
    expect(selectPackageManager({ requested: 'npm' })).toBe('npm');
    expect(selectPackageManager({})).toBe('npm');
  });

  it('refuses conflicting manager or lockfile ownership instead of creating a second lockfile', () => {
    expect(() => selectPackageManager({ requested: 'npm', lockfiles: ['yarn.lock'] })).toThrow(
      /package.manager conflict/,
    );
    expect(() => selectPackageManager({ lockfiles: ['yarn.lock', 'package-lock.json'] })).toThrow(
      /package.manager conflict/,
    );
    expect(() => selectPackageManager({ packageManager: 'bun@1.3.0' })).toThrow(
      /unsupported package manager/,
    );
  });

  it.each([
    [
      'npm',
      '11.12.0',
      'package-lock.json',
      ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--workspaces=false'],
    ],
    [
      'pnpm',
      '11.5.2',
      'pnpm-lock.yaml',
      ['install', '--frozen-lockfile', '--ignore-scripts', '--ignore-workspace'],
    ],
  ] as const)('%s %s preserves a finished lockfile and never runs install scripts', (manager, version, _lock, expected) => {
    expect(installArguments(manager, version, true)).toEqual(expected);
    expect(installArguments(manager, version, false)).not.toContain('--immutable');
    expect(installArguments(manager, version, false)).not.toContain('--frozen-lockfile');
    expect(installArguments(manager, version, false)).not.toContain('ci');
  });

  it.each([
    '1.22.22',
    '4.18.0',
  ])('does not pretend Yarn %s can install the bundled runtime', (version) => {
    expect(() => installArguments('yarn', version, true)).toThrow(/bundled runtime/);
    expect(() => installArguments('yarn', version, false)).toThrow(/bundled runtime/);
  });
});
