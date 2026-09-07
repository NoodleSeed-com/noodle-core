import { createInterface } from 'node:readline/promises';
import { inferDeployVersionFromPath, normalizeDeployVersion } from '@noodle-borg/deploy-client';
import { printRecovery } from '../diagnostics.js';
import { printJsonFailure } from './output.js';
import { printCliFailure } from './shared.js';

/**
 * Resolution order for a deploy's server version, most explicit first:
 *
 * 1. `--version`.
 * 2. the version this project last deployed to this exact org/app/env (`.noodle/deployment.json`).
 * 3. a versioned ancestor folder of the entrypoint (`v1/`, `v2.0.6/`).
 * 4. `deployedVersions()` — what the hosted app already runs (#703). A brand-new app runs nothing,
 *    so the first deploy is version `1`; an app on exactly one version keeps it, matching the
 *    documented rule that deploying does not auto-increment. Several live versions is a real
 *    ambiguity, so it fails naming them rather than picking one.
 * 5. an interactive prompt, else `missing_server_version`.
 *
 * A failing lookup never blocks the deploy — it degrades to step 5.
 */
export async function resolveDeployServerVersion(input: {
  readonly manifestPath: string;
  readonly versionFlag?: string;
  readonly linkedVersion?: string;
  readonly deployedVersions?: () => Promise<readonly string[]>;
  readonly noPrompt: boolean;
  readonly json: boolean;
}): Promise<
  { readonly ok: true; readonly value: string } | { readonly ok: false; exitCode: number }
> {
  if (input.versionFlag !== undefined) {
    try {
      return { ok: true, value: normalizeDeployVersion(input.versionFlag) };
    } catch (error) {
      return deployVersionFailure((error as Error).message, input.json);
    }
  }
  if (input.linkedVersion !== undefined) {
    try {
      return { ok: true, value: normalizeDeployVersion(input.linkedVersion) };
    } catch (error) {
      return deployVersionFailure((error as Error).message, input.json);
    }
  }
  const inferred = inferDeployVersionFromPath(input.manifestPath);
  if (inferred !== undefined) return { ok: true, value: inferred };
  const hosted = await hostedDeployVersions(input.deployedVersions);
  if (hosted !== undefined) {
    if (hosted.length === 0) return { ok: true, value: FIRST_SERVER_VERSION };
    if (hosted.length === 1) return { ok: true, value: hosted[0] as string };
    return ambiguousDeployVersionFailure(hosted, input.json);
  }
  if (
    input.noPrompt ||
    input.json ||
    process.stdin.isTTY !== true ||
    process.stdout.isTTY !== true
  ) {
    return deployVersionFailure(
      'No server version was provided and no versioned folder was found.',
      input.json,
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question('Enter server version (for example 1 or 2.0.6): ');
    return { ok: true, value: normalizeDeployVersion(answer) };
  } catch (error) {
    return deployVersionFailure((error as Error).message, input.json);
  } finally {
    rl.close();
  }
}

export function normalizeCommandServerVersion(
  command: string,
  version: string | undefined,
  json: boolean,
):
  | { readonly ok: true; readonly value?: string }
  | { readonly ok: false; readonly exitCode: number } {
  if (version === undefined) return { ok: true };
  try {
    return { ok: true, value: normalizeDeployVersion(version) };
  } catch (error) {
    const cause = (error as Error).message;
    return {
      ok: false,
      exitCode: printCliFailure(
        command,
        {
          code: 'invalid_server_version',
          message: cause,
          cause,
          fix: 'Use a numeric dotted server version such as 1, 2.0, or 2.0.6.',
          next: `${command === 'access' ? 'noodle access set owner-only' : `noodle ${command}`} --version 1`,
          exitCode: 2,
        },
        json,
      ),
    };
  }
}

/** The version a hosted app that has never been deployed starts at. */
const FIRST_SERVER_VERSION = '1';

/**
 * The distinct, canonically normalized versions the hosted app already runs, or `undefined` when
 * there is no lookup or it failed. A deploy must not be blocked by a diagnostic read, so any error
 * (unreachable service, insufficient grant, unknown app) falls through to the prompt/fail path.
 */
async function hostedDeployVersions(
  lookup: (() => Promise<readonly string[]>) | undefined,
): Promise<readonly string[] | undefined> {
  if (lookup === undefined) return undefined;
  try {
    const normalized = new Set<string>();
    for (const version of await lookup()) {
      try {
        normalized.add(normalizeDeployVersion(version));
      } catch {
        // A version the current CLI cannot normalize still means the app is not brand new, so keep
        // it verbatim: it can only widen the set and push us to the explicit-choice error.
        normalized.add(version);
      }
    }
    return [...normalized].sort();
  } catch {
    return undefined;
  }
}

function ambiguousDeployVersionFailure(
  versions: readonly string[],
  json: boolean,
): { readonly ok: false; readonly exitCode: number } {
  const highest = highestDeployedVersion(versions);
  const cause = `This app already runs ${versions.length} server versions (${versions.join(', ')}), so the target is ambiguous.`;
  const fix = `Pass the server version you intend to deploy (the highest deployed is ${highest.value}; a new version would be ${highest.next}).`;
  const next = `noodle deploy --version ${highest.next}`;
  if (json)
    printJsonFailure({ code: 'ambiguous_server_version', message: cause, cause, fix, next }, 2);
  else printRecovery({ command: 'deploy', cause, fix, next });
  return { ok: false, exitCode: 2 };
}

/**
 * The numerically highest deployed version and the next new one after it. Versions compare by
 * dotted numeric segments; "next" bumps the leading segment (a new server version, not a patch),
 * which is also the only unambiguous successor for mixed version shapes.
 */
function highestDeployedVersion(versions: readonly string[]): {
  readonly value: string;
  readonly next: string;
} {
  const bySegments = [...versions].sort((left, right) => {
    const a = left.split('.').map(Number);
    const b = right.split('.').map(Number);
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      const delta = (a[i] ?? 0) - (b[i] ?? 0);
      if (Number.isNaN(delta)) return left.localeCompare(right);
      if (delta !== 0) return delta;
    }
    return 0;
  });
  const value = bySegments[bySegments.length - 1] as string;
  const leading = Number.parseInt(value, 10);
  const next = Number.isNaN(leading) ? FIRST_SERVER_VERSION : String(leading + 1);
  return { value, next };
}

function deployVersionFailure(
  cause: string,
  json: boolean,
): { readonly ok: false; readonly exitCode: number } {
  if (json) {
    printJsonFailure(
      {
        code: 'missing_server_version',
        message: cause,
        cause,
        fix: 'Pass a deployment version explicitly, or put the server under a versioned folder like v1/.',
        next: 'noodle deploy <entrypoint> --version 1',
      },
      2,
    );
  } else {
    printRecovery({
      command: 'deploy',
      cause,
      fix: 'Pass a deployment version explicitly, or put the server under a versioned folder like v1/.',
      next: 'noodle deploy <entrypoint> --version 1',
    });
  }
  return { ok: false, exitCode: 2 };
}
