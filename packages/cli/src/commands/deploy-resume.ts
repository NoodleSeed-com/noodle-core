import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HostedDeployTarget } from './deploy-preflight.js';

interface DeployResumeState {
  readonly schemaVersion: 1;
  readonly fingerprint: string;
  readonly idempotencyKey: string;
  readonly target: HostedDeployTarget;
  readonly serverVersion: string;
}

function deployResumePath(projectRoot: string): string {
  return join(projectRoot, '.noodle', 'deploy-resume.json');
}

/**
 * Reuse a key only while the same operation is unfinished. A changed target, version, or authored
 * deploy input starts a new operation, and clearing the state after readiness lets an intentional
 * later redeploy create normal rollback history.
 */
export function loadOrCreateDeployResume(input: {
  readonly projectRoot: string;
  readonly fingerprint: string;
  readonly target: HostedDeployTarget;
  readonly serverVersion: string;
}): DeployResumeState {
  const existing = readDeployResume(input.projectRoot);
  if (
    existing !== undefined &&
    existing.fingerprint === input.fingerprint &&
    existing.serverVersion === input.serverVersion &&
    sameTarget(existing.target, input.target)
  ) {
    return existing;
  }
  const state: DeployResumeState = {
    schemaVersion: 1,
    fingerprint: input.fingerprint,
    idempotencyKey: `sha256:${createHash('sha256').update(randomBytes(32)).digest('hex')}`,
    target: input.target,
    serverVersion: input.serverVersion,
  };
  writeDeployResume(input.projectRoot, state);
  return state;
}

export function clearDeployResume(projectRoot: string, idempotencyKey: string): void {
  const state = readDeployResume(projectRoot);
  if (state?.idempotencyKey !== idempotencyKey) return;
  try {
    unlinkSync(deployResumePath(projectRoot));
  } catch {}
}

function readDeployResume(projectRoot: string): DeployResumeState | undefined {
  try {
    const parsed = JSON.parse(readFileSync(deployResumePath(projectRoot), 'utf8')) as Record<
      string,
      unknown
    >;
    const target = parsed.target as Record<string, unknown> | undefined;
    if (
      parsed.schemaVersion !== 1 ||
      typeof parsed.fingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/.test(parsed.fingerprint) ||
      typeof parsed.idempotencyKey !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/.test(parsed.idempotencyKey) ||
      typeof parsed.serverVersion !== 'string' ||
      target === undefined ||
      typeof target.org !== 'string' ||
      typeof target.app !== 'string' ||
      typeof target.env !== 'string'
    ) {
      return undefined;
    }
    return {
      schemaVersion: 1,
      fingerprint: parsed.fingerprint,
      idempotencyKey: parsed.idempotencyKey,
      serverVersion: parsed.serverVersion,
      target: { org: target.org, app: target.app, env: target.env },
    };
  } catch {
    return undefined;
  }
}

function writeDeployResume(projectRoot: string, state: DeployResumeState): void {
  const directory = join(projectRoot, '.noodle');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = deployResumePath(projectRoot);
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function sameTarget(left: HostedDeployTarget, right: HostedDeployTarget): boolean {
  return left.org === right.org && left.app === right.app && left.env === right.env;
}
