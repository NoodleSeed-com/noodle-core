import { serviceJson } from '../control-plane.js';
import type { AccessMode, OrgMembershipSource } from '../deploy.js';
import { promptToImportMissingDotenvConfig } from './deploy-dotenv-import.js';
import { promptAndSetMissingConfig } from './deploy-output.js';
import { type HostedDeployTarget, preflightHostedDeploy } from './deploy-preflight.js';
import { configOnly, preflightBlocked, preflightError } from './deploy-preflight-output.js';
import { clearDeployResume, loadOrCreateDeployResume } from './deploy-resume.js';
import type { JsonError } from './output.js';

export interface CanonicalDeployPreparation {
  readonly ok: true;
  readonly idempotencyKey?: string;
  readonly resumeCommand: string;
  readonly verificationRequired: boolean;
}

export interface CanonicalDeployPreparationFailure {
  readonly ok: false;
  readonly exitCode: number;
  readonly error: JsonError;
}

export interface HostedDeployVerification {
  readonly required: boolean;
  readonly ok: boolean;
  readonly checks?: readonly {
    readonly level: 'PASS' | 'WARN' | 'FAIL';
    readonly name: string;
    readonly message: string;
  }[];
  readonly message?: string;
}

interface PrepareCanonicalDeployInput {
  readonly manifestPath: string;
  readonly connectorsPath?: string;
  readonly serviceUrl: string;
  readonly token?: string;
  readonly target: HostedDeployTarget;
  readonly accessMode?: AccessMode;
  readonly ownerSubject?: string;
  readonly orgMembershipSources?: readonly OrgMembershipSource[];
  readonly serverVersion: string;
  readonly projectRoot: string;
  readonly saveLegacy?: boolean;
  readonly noSave?: boolean;
  readonly noPrompt: boolean;
  readonly json: boolean;
  readonly interactive: boolean;
  readonly silent?: boolean;
}

interface PrepareCanonicalDeployDependencies {
  readonly confirmDotenvImport?: (message: string) => Promise<boolean>;
  readonly promptMissingConfig?: typeof promptAndSetMissingConfig;
}

/**
 * Run the read-only half of the canonical hosted deploy. It returns only after the complete
 * configuration checklist is ready and a retry key has been durably recorded.
 */
export async function prepareCanonicalDeploy(
  input: PrepareCanonicalDeployInput,
  dependencies: PrepareCanonicalDeployDependencies = {},
): Promise<CanonicalDeployPreparation | CanonicalDeployPreparationFailure> {
  const resumeCommand = deployResumeCommand({
    manifestPath: input.manifestPath,
    ...(input.connectorsPath !== undefined ? { connectorsPath: input.connectorsPath } : {}),
    serviceUrl: input.serviceUrl,
    target: input.target,
    accessMode: input.accessMode ?? 'owner-only',
    ...(input.ownerSubject !== undefined ? { ownerSubject: input.ownerSubject } : {}),
    serverVersion: input.serverVersion,
    ...(input.saveLegacy !== undefined ? { saveLegacy: input.saveLegacy } : {}),
    ...(input.noSave !== undefined ? { noSave: input.noSave } : {}),
    noPrompt: input.noPrompt,
    json: input.json,
  });
  if (input.token === undefined) {
    return { ok: true, resumeCommand, verificationRequired: false };
  }
  const token = input.token;
  try {
    const runPreflight = async () => {
      const preflight = await preflightHostedDeploy({
        manifestPath: input.manifestPath,
        ...(input.connectorsPath !== undefined ? { connectorsPath: input.connectorsPath } : {}),
        serviceUrl: input.serviceUrl,
        token,
        target: input.target,
        ...(input.accessMode !== undefined ? { accessMode: input.accessMode } : {}),
        ...(input.ownerSubject !== undefined ? { ownerSubject: input.ownerSubject } : {}),
        ...(input.orgMembershipSources !== undefined
          ? { orgMembershipSources: input.orgMembershipSources }
          : {}),
        serverVersion: input.serverVersion,
      });
      return preflight;
    };
    let preflight = await runPreflight();
    if (
      !preflight.response.ready &&
      configOnly(preflight.response.errors) &&
      !input.noPrompt &&
      input.interactive &&
      !input.json
    ) {
      const dotenvImport = await promptToImportMissingDotenvConfig(
        {
          projectRoot: input.projectRoot,
          missingSecrets: preflight.response.config.missingSecrets,
          missingVariables: preflight.response.config.missingVariables,
          serviceUrl: input.serviceUrl,
          token,
          target: input.target,
        },
        dependencies.confirmDotenvImport !== undefined
          ? { confirmImport: dependencies.confirmDotenvImport }
          : {},
      );
      if (dotenvImport.imported) preflight = await runPreflight();
      if (!preflight.response.ready && configOnly(preflight.response.errors)) {
        const promptMissingConfig = dependencies.promptMissingConfig ?? promptAndSetMissingConfig;
        await promptMissingConfig({
          missingSecrets: preflight.response.config.missingSecrets,
          missingVariables: preflight.response.config.missingVariables,
          serviceUrl: input.serviceUrl,
          token,
          target: input.target,
        });
        preflight = await runPreflight();
      }
    }
    if (!preflight.response.ready) {
      return preflightBlocked(
        preflight.response,
        input.target,
        input.serverVersion,
        resumeCommand,
        input.json,
        input.silent === true,
      );
    }
    const resume = loadOrCreateDeployResume({
      projectRoot: input.projectRoot,
      fingerprint: preflight.fingerprint,
      target: input.target,
      serverVersion: input.serverVersion,
    });
    return {
      ok: true,
      idempotencyKey: resume.idempotencyKey,
      resumeCommand,
      verificationRequired: true,
    };
  } catch (error) {
    return preflightError(error, input.serviceUrl, input.target, input.json, input.silent === true);
  }
}

export async function verifyHostedDeploy(input: {
  readonly required: boolean;
  readonly serviceUrl: string;
  readonly token?: string;
  readonly target: HostedDeployTarget;
}): Promise<HostedDeployVerification> {
  if (!input.required || input.token === undefined) return { required: false, ok: true };
  try {
    const raw = await serviceJson<unknown>(
      `${input.serviceUrl}/v1/orgs/${encodeURIComponent(input.target.org)}` +
        `/apps/${encodeURIComponent(input.target.app)}` +
        `/envs/${encodeURIComponent(input.target.env)}/smoke`,
      input.token,
      { method: 'POST' },
    );
    if (!isSmokeResponse(raw)) {
      return {
        required: true,
        ok: false,
        message: 'hosted readiness response did not match the expected contract',
      };
    }
    return {
      required: true,
      ok: raw.ok,
      checks: raw.checks,
      ...(!raw.ok ? { message: failedCheckMessage(raw.checks) } : {}),
    };
  } catch (error) {
    return {
      required: true,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function completeDeployResume(
  projectRoot: string,
  idempotencyKey: string | undefined,
): void {
  if (idempotencyKey !== undefined) clearDeployResume(projectRoot, idempotencyKey);
}

export function deployResumeCommand(input: {
  readonly manifestPath: string;
  readonly connectorsPath?: string;
  readonly serviceUrl: string;
  readonly target: HostedDeployTarget;
  readonly accessMode: AccessMode;
  readonly ownerSubject?: string;
  readonly serverVersion: string;
  readonly saveLegacy?: boolean;
  readonly noSave?: boolean;
  readonly noPrompt?: boolean;
  readonly json?: boolean;
}): string {
  const args = [
    'noodle',
    'deploy',
    input.manifestPath,
    ...(input.connectorsPath !== undefined ? ['--connectors', input.connectorsPath] : []),
    '--service',
    input.serviceUrl,
    '--org',
    input.target.org,
    '--app',
    input.target.app,
    '--env',
    input.target.env,
    '--version',
    input.serverVersion,
    '--access',
    input.accessMode,
    ...(input.ownerSubject !== undefined ? ['--owner-subject', input.ownerSubject] : []),
    ...(input.noSave ? ['--no-save'] : input.saveLegacy ? ['--save'] : []),
    ...(input.noPrompt ? ['--no-prompt'] : []),
    ...(input.json ? ['--json'] : []),
  ];
  return args.map(shellQuoteCommandArgument).join(' ');
}

function shellQuoteCommandArgument(value: string): string {
  if (/^[a-zA-Z0-9_./:@%+,=-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function isSmokeResponse(value: unknown): value is {
  readonly ok: boolean;
  readonly checks: readonly {
    readonly level: 'PASS' | 'WARN' | 'FAIL';
    readonly name: string;
    readonly message: string;
  }[];
} {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { ok?: unknown; checks?: unknown };
  return (
    typeof candidate.ok === 'boolean' &&
    Array.isArray(candidate.checks) &&
    candidate.checks.every(
      (check) =>
        typeof check === 'object' &&
        check !== null &&
        ['PASS', 'WARN', 'FAIL'].includes(String((check as { level?: unknown }).level)) &&
        typeof (check as { name?: unknown }).name === 'string' &&
        typeof (check as { message?: unknown }).message === 'string',
    )
  );
}

function failedCheckMessage(
  checks: readonly { readonly level: 'PASS' | 'WARN' | 'FAIL'; readonly message: string }[],
): string {
  return checks.find((check) => check.level === 'FAIL')?.message ?? 'hosted readiness check failed';
}
