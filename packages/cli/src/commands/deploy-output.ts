import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { serviceJson } from '../control-plane.js';
import type { AssetDeployStage, AssetDeploySummary } from '../deploy.js';
import { EXIT } from './output.js';
import { formatBytes } from './shared.js';

/**
 * Map a `deploy()` outcome's HTTP-like status onto the standard exit-code taxonomy: 401/403 (auth,
 * including a wrong-org 403) exit `AUTH`; a status-0 network failure exits `UNREACHABLE`; everything
 * else (validation 4xx, asset failures at 422, server 5xx) is a domain failure and stays `FAILURE`.
 * Missing-secret failures never reach this — they always stay `FAILURE` (a config/domain issue).
 */
export function deployExitCode(status: number): number {
  if (status === 401 || status === 403) return EXIT.AUTH;
  if (status === 0) return EXIT.UNREACHABLE;
  return EXIT.FAILURE;
}

export async function promptAndSetMissingConfig(input: {
  readonly missingSecrets: readonly string[];
  readonly missingVariables: readonly string[];
  readonly serviceUrl: string;
  readonly token: string;
  readonly target: { readonly org: string; readonly app: string; readonly env: string };
}): Promise<void> {
  const muted = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output: muted });
  try {
    for (const [kind, names] of [
      ['variable', input.missingVariables],
      ['secret', input.missingSecrets],
    ] as const) {
      for (const name of names) {
        console.error(`Enter value for ${kind} ${name}:`);
        const value = await rl.question('');
        await serviceJson(
          `${input.serviceUrl}/v1/orgs/${encodeURIComponent(input.target.org)}` +
            `/apps/${encodeURIComponent(input.target.app)}` +
            `/envs/${encodeURIComponent(input.target.env)}/${kind}s/${encodeURIComponent(name)}`,
          input.token,
          {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ value }),
          },
        );
        console.error(`set ${kind} ${name}`);
      }
    }
  } finally {
    rl.close();
  }
}

export function managedConfigSetCommand(
  kind: 'secret' | 'variable',
  name: string,
  target: { readonly org: string; readonly app: string; readonly env: string },
): string {
  return (
    `noodle ${kind}s set ${name} --runtime cloud --scope env --org ${target.org}` +
    ` --app ${target.app} --env ${target.env} --from-env ${name}`
  );
}

/**
 * Render the packaged-asset line shown after a successful deploy. Reads as plain English so authors
 * never see object keys or buckets: "3 checked, 1 uploaded, 2 reused (12.0 KB uploaded)", or
 * "none packaged" when the app ships no assets.
 */
export function formatAssetSummary(summary: AssetDeploySummary): string {
  if (summary.checked === 0) return 'none packaged.';
  return (
    `${summary.checked} checked, ${summary.uploaded} uploaded, ${summary.reused} reused ` +
    `(${formatBytes(summary.uploadedBytes)} uploaded).`
  );
}

/**
 * Map a packaged-asset failure to a stable, repairable recovery. The service/compiler message already
 * names the offending asset by project-relative path, so it becomes the `cause` verbatim; only the
 * fix/next differ by stage. `validate` and `preflight` send the author back to `noodle validate` (fast
 * local re-check / asset disclosure); an `upload` rejection is often transient, so it points at retry.
 */
export function assetFailureRecovery(
  stage: AssetDeployStage,
  message: string,
): { cause: string; fix: string; next: string } {
  if (stage === 'validate') {
    return {
      cause: message,
      fix: 'Repair the packaged asset named above (paths are project-relative), then re-validate.',
      next: 'noodle validate',
    };
  }
  if (stage === 'preflight') {
    return {
      cause: message,
      fix: 'The service rejected the upload plan (quota, size, or public-hosting policy). Reduce or remove the offending asset.',
      next: 'noodle validate',
    };
  }
  return {
    cause: message,
    fix: 'The object store rejected the upload (checksum, size, or an expired target). Retry the deploy.',
    next: 'noodle deploy',
  };
}

export function deployFailureFix(status: number): string {
  if (status === 401 || status === 403)
    return 'Sign in to the target service and confirm org access.';
  if (status === 0) return 'Check that the deploy service URL is reachable.';
  if (status === 400) return 'Fix the deploy input reported by the service.';
  if (status === 413)
    return 'Reduce the compiled widget payload named in the error, then validate before deploying again.';
  return 'Check the service status and retry.';
}

export function deployFailureNext(status: number, serviceUrl: string): string {
  if (status === 401 || status === 403) return `noodle login --service ${serviceUrl}`;
  if (status === 0) return `noodle doctor --service ${serviceUrl}`;
  if (status === 400) return 'noodle validate';
  if (status === 413) return 'noodle check';
  return 'noodle doctor';
}
