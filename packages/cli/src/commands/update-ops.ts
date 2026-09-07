/**
 * `noodle update` — the canonical install/update/repair command (#242, ADR 0124).
 *
 * `npm install -g` fails with `EEXIST` before any of our code runs when a stale or
 * foreign `noodle` binary occupies the global bin path, so this command detects the
 * conflict first (via `update-binary.ts`), repairs it only when the binary is provably
 * ours, and otherwise prints the exact manual commands. The repair unlink is the only
 * destructive filesystem operation in the update system, runs only on a SAFE-classified
 * path, and is always logged plainly.
 *
 * Stable exit codes (explicit `noodle update` paths only, never plain commands):
 *   0  ok / already current / updated
 *   10 update available (--check)
 *   11 update or repair failed
 *   12 repair required (safe, but --repair not authorized / not confirmable)
 *   13 unsafe conflicting binary
 *   14 network inconclusive
 */
import { spawn } from 'node:child_process';
import { unlinkSync } from 'node:fs';
import { type ColorMode, detectColorMode } from '../gradient.js';
import { confirm } from '../prompts.js';
import { type Spinner, startSpinner } from '../status.js';
import {
  CLI_PACKAGE_NAME,
  compareVersions,
  currentCliVersion,
  fetchLatestVersion,
  GLOBAL_UPDATE_COMMAND,
  truthyEnv,
} from '../update.js';
import { inspectNoodleBinary, type NoodleBinaryInspection } from '../update-binary.js';
import {
  renderRepairNotice,
  renderUpdateAvailable,
  renderUpdated,
  renderUpToDate,
} from '../update-render.js';
import { printJsonFailure, printJsonOk } from './output.js';

const UPDATE_EXIT = {
  ok: 0,
  updateAvailable: 10,
  updateFailed: 11,
  repairRequired: 12,
  unsafeBinary: 13,
  networkInconclusive: 14,
} as const;

const RECOMMENDED_UPDATE = 'noodle update --yes --json';
const RECOMMENDED_REPAIR = 'noodle update --yes --repair --json';
const UNSAFE_REASON = `Existing noodle binary is not known to be owned by ${CLI_PACKAGE_NAME}.`;

export interface UpdateCommandDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  readonly inspectImpl?: () => NoodleBinaryInspection;
  readonly installImpl?: (opts: {
    readonly json: boolean;
    readonly colorMode?: ColorMode;
  }) => Promise<number>;
  readonly unlinkImpl?: (path: string) => void;
  readonly confirmImpl?: (message: string) => Promise<boolean>;
  /** Base prompt capability; defaults to stdin+stdout TTY outside CI. */
  readonly interactive?: boolean;
  readonly log?: (line: string) => void;
  readonly logError?: (line: string) => void;
  /** Rich-output mode; defaults to stdout detection ('none' in tests/CI/pipes). */
  readonly colorMode?: ColorMode;
}

export async function runUpdateCommand(
  rest: readonly string[],
  deps: UpdateCommandDeps = {},
): Promise<number> {
  const env = deps.env ?? process.env;
  const yes = rest.includes('--yes') || rest.includes('-y');
  const check = rest.includes('--check');
  const json = rest.includes('--json');
  const repair = rest.includes('--repair');
  const log = deps.log ?? console.log;
  const logError = deps.logError ?? console.error;
  const canPrompt =
    (deps.interactive ?? defaultInteractive(env)) &&
    !truthyEnv(env.NOODLE_NO_PROMPT) &&
    !yes &&
    !json &&
    !check;

  const colorMode = deps.colorMode ?? detectColorMode(process.stdout);
  const installed = currentCliVersion();
  // The check moment: a live spinner on rich TTYs; nothing extra anywhere else.
  const spin: Spinner | undefined =
    colorMode !== 'none' && !json ? startSpinner('checking for updates') : undefined;
  const latest = await fetchLatestVersion(deps.fetchImpl ?? fetch, 5000).catch(() => undefined);
  if (latest === undefined) {
    spin?.warn('could not reach the npm registry');
    if (json) {
      printJsonFailure(
        {
          code: 'network_inconclusive',
          message: 'Could not reach the npm registry to determine the latest version.',
          fix: 'Check the network connection and retry.',
          next: 'noodle update --check --json',
          retryable: true,
          detail: { package: CLI_PACKAGE_NAME, installed },
        },
        UPDATE_EXIT.networkInconclusive,
        log,
      );
    } else if (spin === undefined) {
      logError('update: could not reach the npm registry to determine the latest version.');
    }
    return UPDATE_EXIT.networkInconclusive;
  }

  spin?.stop();
  const updateAvailable = compareVersions(latest, installed) > 0;
  const inspection = (deps.inspectImpl ?? inspectNoodleBinary)();
  const status = inspection.status;
  const repairRequired = status.kind === 'safe-repair' || status.kind === 'unsafe';
  const repairSafe = status.kind === 'safe-repair';

  const checkShape = () => ({
    package: CLI_PACKAGE_NAME,
    installed,
    latest,
    updateAvailable,
    // Never recommend a command guaranteed to exit 13: an UNSAFE binary gets
    // the manual path at check time instead of a doomed --yes suggestion.
    ...(updateAvailable && status.kind !== 'unsafe'
      ? { recommendedCommand: repairSafe ? RECOMMENDED_REPAIR : RECOMMENDED_UPDATE }
      : {}),
    repairRequired,
    repairSafe,
    ...(status.kind === 'unsafe'
      ? {
          path: inspection.binPath,
          manualCommands: [`rm ${inspection.binPath}`, GLOBAL_UPDATE_COMMAND],
        }
      : {}),
  });

  if (check) {
    if (json) printJsonOk(checkShape(), undefined, log);
    else printPlan({ log, logError, installed, latest, updateAvailable, inspection, colorMode });
    return updateAvailable ? UPDATE_EXIT.updateAvailable : UPDATE_EXIT.ok;
  }

  if (!updateAvailable) {
    if (json) printJsonOk(checkShape(), undefined, log);
    else log(renderUpToDate(installed, colorMode));
    return UPDATE_EXIT.ok;
  }

  const install = async (repairedPath?: string): Promise<number> => {
    const code = await (deps.installImpl ?? defaultInstall)({ json, colorMode });
    if (code !== 0) {
      // The install failed — most often npm's `EEXIST .../bin/noodle` from an old/conflicting global
      // binary. Say a new version IS available and point at the repair + manual paths, rather than
      // leaking a bare exit code (the reported "package already exists" case).
      if (json) {
        printJsonFailure(
          {
            code: 'update_failed',
            message: `The update command exited with code ${code}.`,
            fix: 'Repair a safe blocked binary or reinstall the CLI manually.',
            next: RECOMMENDED_REPAIR,
            retryable: true,
            detail: {
              package: CLI_PACKAGE_NAME,
              installedBefore: installed,
              latest,
              updateAvailable: true,
              command: GLOBAL_UPDATE_COMMAND,
              installExitCode: code,
              recommendedCommand: RECOMMENDED_REPAIR,
              manualCommands: [`${GLOBAL_UPDATE_COMMAND} --force`],
            },
          },
          UPDATE_EXIT.updateFailed,
          log,
        );
      } else {
        logError(
          `update: a new version (${latest}) is available, but \`${GLOBAL_UPDATE_COMMAND}\` exited with code ${code}.`,
        );
        logError(
          'This is usually an old or conflicting global `noodle` binary blocking npm. Fix it with:',
        );
        logError(
          '  noodle update --yes --repair    # remove a safe-to-remove Noodle binary, then update',
        );
        logError(
          `  ${GLOBAL_UPDATE_COMMAND} --force  # or reinstall manually, forcing past the blocked binary`,
        );
      }
      return UPDATE_EXIT.updateFailed;
    }
    if (json) {
      printJsonOk(
        {
          package: CLI_PACKAGE_NAME,
          installedBefore: installed,
          installedAfter: latest,
          command: GLOBAL_UPDATE_COMMAND,
          ...(repairedPath !== undefined ? { repairPerformed: true, repairedPath } : {}),
        },
        undefined,
        log,
      );
    } else {
      log(renderUpdated(installed, latest, colorMode));
    }
    return UPDATE_EXIT.ok;
  };

  const repairAndInstall = async (): Promise<number> => {
    const reason = status.kind === 'safe-repair' ? status.reason : '';
    // The one destructive operation in the update system: unlink a SAFE-classified
    // path, logged plainly before it happens.
    if (!json) logError(`Removing blocked binary: ${inspection.binPath} (${reason})`);
    try {
      (deps.unlinkImpl ?? unlinkSync)(inspection.binPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (json) {
        printJsonFailure(
          {
            code: 'repair_failed',
            message,
            fix: 'Verify the blocked binary path and permissions, then retry.',
            next: RECOMMENDED_REPAIR,
            retryable: true,
            detail: { package: CLI_PACKAGE_NAME, path: inspection.binPath },
          },
          UPDATE_EXIT.updateFailed,
          log,
        );
      } else {
        logError(`update: could not remove ${inspection.binPath}: ${message}`);
      }
      return UPDATE_EXIT.updateFailed;
    }
    return install(inspection.binPath);
  };

  const reportUnsafe = (): number => {
    if (json) {
      return printJsonFailure(
        {
          code: 'conflicting_binary',
          message: UNSAFE_REASON,
          fix: 'Verify and remove the conflicting binary manually.',
          next: GLOBAL_UPDATE_COMMAND,
          retryable: false,
          detail: {
            package: CLI_PACKAGE_NAME,
            path: inspection.binPath,
            repairRequired: true,
            repairSafe: false,
            manualCommands: [`rm ${inspection.binPath}`, GLOBAL_UPDATE_COMMAND],
          },
        },
        UPDATE_EXIT.unsafeBinary,
        log,
      );
    } else {
      logError(
        'The existing `noodle` binary is not owned by this install, so I will not overwrite it automatically.',
      );
      logError(`  binary: ${inspection.binPath}`);
      logError('Verify that file yourself, then update manually:');
      logError(`  rm ${inspection.binPath}`);
      logError(`  ${GLOBAL_UPDATE_COMMAND}`);
    }
    return UPDATE_EXIT.unsafeBinary;
  };

  const reportRepairRequired = (): number => {
    if (json) {
      return printJsonFailure(
        {
          code: 'repair_required',
          message: 'A previous Noodle CLI binary is blocking npm; it is safe to remove.',
          fix: 'Authorize the safe repair and update.',
          next: RECOMMENDED_REPAIR,
          retryable: false,
          detail: {
            package: CLI_PACKAGE_NAME,
            path: inspection.binPath,
            repairRequired: true,
            repairSafe: true,
            recommendedCommand: RECOMMENDED_REPAIR,
          },
        },
        UPDATE_EXIT.repairRequired,
        log,
      );
    } else {
      logError(`update: an old Noodle CLI binary at ${inspection.binPath} is blocking npm.`);
      logError('Run `noodle update --yes --repair` to remove it safely and update.');
    }
    return UPDATE_EXIT.repairRequired;
  };

  // Headless or explicitly-flagged action paths (--yes and/or --repair).
  if (yes || repair) {
    if (status.kind === 'unsafe') return reportUnsafe();
    if (repairSafe) {
      if (repair && yes) return repairAndInstall();
      if (repair && canPrompt) {
        printPlan({ log, logError, installed, latest, updateAvailable, inspection, colorMode });
        const go = await promptConfirm(deps, 'Repair and update now?');
        return go ? repairAndInstall() : UPDATE_EXIT.ok;
      }
      // --yes without --repair, or --repair without a way to confirm.
      return reportRepairRequired();
    }
    // No blocking binary (or the active install's own symlink).
    if (yes) return install();
    // --repair with nothing to repair, interactive: fall through to the normal prompt.
  }

  // Interactive default: show the plan, then ask.
  if (canPrompt) {
    log(renderUpdateAvailable(installed, latest, colorMode));
    if (status.kind === 'unsafe') return reportUnsafe();
    if (repairSafe) {
      logError(
        renderRepairNotice(
          `An old \`noodle\` binary at ${inspection.binPath} is blocking npm.`,
          colorMode,
        ),
      );
      logError('It is provably a Noodle CLI install, so it can be removed safely.');
      const go = await promptConfirm(deps, 'Repair and update now?');
      return go ? repairAndInstall() : UPDATE_EXIT.ok;
    }
    const go = await promptConfirm(deps, 'Update now?');
    return go ? install() : UPDATE_EXIT.ok;
  }

  // Non-interactive without an action flag: report the plan and change nothing.
  if (json) printJsonOk(checkShape(), undefined, log);
  else printPlan({ log, logError, installed, latest, updateAvailable, inspection, colorMode });
  return UPDATE_EXIT.ok;
}

function printPlan(input: {
  log: (line: string) => void;
  logError: (line: string) => void;
  installed: string;
  latest: string;
  updateAvailable: boolean;
  inspection: NoodleBinaryInspection;
  colorMode: ColorMode;
}): void {
  const { log, installed, latest, updateAvailable, inspection, colorMode } = input;
  if (!updateAvailable) {
    log(renderUpToDate(installed, colorMode));
    return;
  }
  log(renderUpdateAvailable(installed, latest, colorMode));
  const status = inspection.status;
  if (status.kind === 'safe-repair') {
    log(`An old \`noodle\` binary at ${inspection.binPath} will block npm; it is safe to remove.`);
    log('Run `noodle update --yes --repair` to repair and update now.');
    return;
  }
  if (status.kind === 'unsafe') {
    log(`An existing \`noodle\` binary at ${inspection.binPath} blocks npm and is not owned by`);
    log('this install. Verify and remove it yourself, then update:');
    log(`  rm ${inspection.binPath}`);
    log(`  ${GLOBAL_UPDATE_COMMAND}`);
    return;
  }
  log('Run `noodle update --yes` to update now.');
}

async function promptConfirm(deps: UpdateCommandDeps, message: string): Promise<boolean> {
  const ask = deps.confirmImpl ?? ((m: string) => confirm(m));
  return ask(message).catch(() => false);
}

function defaultInteractive(env: NodeJS.ProcessEnv): boolean {
  return (
    process.stdin.isTTY === true && process.stdout.isTTY === true && !truthyEnv(env.CI ?? undefined)
  );
}

function defaultInstall(opts: {
  readonly json: boolean;
  readonly colorMode?: ColorMode;
}): Promise<number> {
  const rich = !opts.json && (opts.colorMode ?? 'none') !== 'none';
  const capture = rich || opts.json;
  // Rich TTYs get a spinner and captured npm output (shown only on failure);
  // --json keeps stdout machine-readable; plain mode inherits npm's own output.
  const spin = rich ? startSpinner(`updating ${CLI_PACKAGE_NAME}`) : undefined;
  return new Promise<number>((resolve) => {
    const child = spawn('npm', ['install', '-g', `${CLI_PACKAGE_NAME}@latest`], {
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let captured = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      captured = (captured + chunk.toString()).slice(-65536);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      captured = (captured + chunk.toString()).slice(-65536);
    });
    child.on('error', (error) => {
      spin?.fail(`updating ${CLI_PACKAGE_NAME}`);
      if (!opts.json) console.error(`update: ${error.message}`);
      resolve(1);
    });
    child.on('close', (code) => {
      if ((code ?? 1) === 0) spin?.stop();
      else {
        spin?.fail(`updating ${CLI_PACKAGE_NAME}`);
        // cli-output-drift-allow: human-only captured npm diagnostics after a rich TTY failure.
        if (!opts.json && captured.length > 0) process.stderr.write(`${captured}\n`);
      }
      resolve(code ?? 1);
    });
  });
}
