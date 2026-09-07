import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..', '..');
const serviceRoot = join(root, 'packages/service');

describe('public service platform-identity boundary', () => {
  it('contains no hosted WorkOS or platform-identity implementation', () => {
    const packageJson = JSON.parse(readFileSync(join(serviceRoot, 'package.json'), 'utf8')) as {
      readonly dependencies?: Readonly<Record<string, string>>;
    };
    const sourcePaths = readdirSync(join(serviceRoot, 'src'), { recursive: true })
      .map(String)
      .filter(isHostedPlatformIdentityPath)
      .sort();

    expect(packageJson.dependencies).not.toHaveProperty('@workos-inc/node');
    expect(sourcePaths).toEqual([]);
  });
});

function isHostedPlatformIdentityPath(path: string): boolean {
  return (
    /^platform-.*\.ts$/.test(path) ||
    path === 'workos-directory.ts' ||
    /^oauth\/(?:workos(?:-.+)?|platform-principal(?:-.+)?)\.ts$/.test(path) ||
    /^routes\/(?:platform-.+|private-platform-auth-dispatch)\.ts$/.test(path)
  );
}
