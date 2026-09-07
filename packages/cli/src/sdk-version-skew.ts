import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { compareVersions, currentCliVersion } from './update.js';

/** Fail before importing author code when a global/older CLI cannot understand the local SDK. */
export function assertCliSdkCompatibility(
  inputPath: string,
  cliVersion = currentCliVersion(),
): void {
  const packagePath = findInstalledSdkPackage(dirname(resolve(inputPath)));
  if (packagePath === undefined) return;
  let sdkVersion: string | undefined;
  try {
    const parsed = JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: unknown };
    if (typeof parsed.version === 'string') sdkVersion = parsed.version;
  } catch {
    return;
  }
  if (sdkVersion === undefined || compareVersions(cliVersion, sdkVersion) >= 0) return;
  throw new Error(
    `cli_sdk_version_skew: CLI ${cliVersion} is older than this project's @noodleseed/one ${sdkVersion}; re-run this command with ./node_modules/.bin/noodle`,
  );
}

function findInstalledSdkPackage(start: string): string | undefined {
  let dir = start;
  const root = parse(dir).root;
  while (true) {
    const candidate = join(dir, 'node_modules', '@noodleseed', 'one', 'package.json');
    if (existsSync(candidate)) return candidate;
    if (dir === root) return undefined;
    dir = dirname(dir);
  }
}
