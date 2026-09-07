import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertCliSdkCompatibility } from '../src/sdk-version-skew.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('CLI and project SDK compatibility', () => {
  it('fails before author import when the CLI is older than the installed project SDK', () => {
    const root = project('0.44.0');
    expect(() => assertCliSdkCompatibility(join(root, 'src', 'server.ts'), '0.33.0')).toThrow(
      "cli_sdk_version_skew: CLI 0.33.0 is older than this project's @noodleseed/one 0.44.0; re-run this command with ./node_modules/.bin/noodle",
    );
  });

  it('allows an equal or newer CLI', () => {
    const root = project('0.44.0');
    expect(() => assertCliSdkCompatibility(join(root, 'src', 'server.ts'), '0.44.0')).not.toThrow();
    expect(() => assertCliSdkCompatibility(join(root, 'src', 'server.ts'), '0.45.0')).not.toThrow();
  });
});

function project(sdkVersion: string): string {
  const root = mkdtempSync(join(tmpdir(), 'noodle-sdk-skew-'));
  dirs.push(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'node_modules', '@noodleseed', 'one'), { recursive: true });
  writeFileSync(
    join(root, 'node_modules', '@noodleseed', 'one', 'package.json'),
    JSON.stringify({ name: '@noodleseed/one', version: sdkVersion }),
  );
  return root;
}
