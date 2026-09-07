import type { ConfigLocation } from './config.js';

/**
 * Passive post-command update check (#242, ADR 0124, refining ADR 0079).
 *
 * Default behavior on a human TTY: at most once per day, offer "Update now?"
 * (Enter = yes; "n" snoozes for 24h via `updateCheck.snoozedUntil`). When a prompt
 * is not possible (no interactive stdin, NOODLE_NO_PROMPT, machine notices) it
 * falls back to the once-per-day notice. `NOODLE_UPDATE_MODE` selects explicit
 * behaviors for automation: `off` (no checks), `notify` (notice only), `check`
 * (stable exit-code overlay 10 when an update is available — the only mode that
 * runs without a TTY / in CI), and `auto` (run the update, interactive shells
 * only; `NOODLE_AUTO_UPDATE` stays as the shipped alias).
 *
 * A failed, declined, or crashed check must NEVER break or re-code the user's
 * actual command — every failure path resolves to `undefined`.
 */

import { printJsonStreamEvent } from './commands/output.js';
import { runUpdateCommand } from './commands/update-ops.js';
import { readConfig, writeConfig } from './config.js';
import { detectColorMode } from './gradient.js';
import { confirm } from './prompts.js';
import {
  bundledAgentKitVersion,
  fetchLatestAgentKitVersion,
  isSkillsUpdateAvailable,
  skillsUpdatePromptMessage,
} from './skills-update.js';
import {
  CLI_PACKAGE_NAME,
  compareVersions,
  currentCliVersion,
  fetchLatestVersion,
  truthyEnv,
  UPDATE_CHECK_INTERVAL_MS,
} from './update.js';
import { renderUpdateAvailable } from './update-render.js';

type UpdateMode = 'off' | 'notify' | 'check' | 'auto' | 'prompt';

export interface UpdateCheckInput {
  readonly command: string | undefined;
  /** Remaining argv of the invocation; any `--json` invocation skips the check. */
  readonly argv?: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly home: ConfigLocation;
  readonly fetchImpl?: typeof fetch;
  /** Injectable updater (defaults to `runUpdateCommand`); tests avoid spawning npm. */
  readonly runUpdate?: (rest: readonly string[]) => Promise<number>;
  readonly confirmImpl?: (message: string) => Promise<boolean>;
  /** May we prompt? Defaults to stdin+stderr being TTYs. */
  readonly promptCapable?: boolean;
  /** May we print a notice? Defaults to stderr being a TTY. */
  readonly noticeCapable?: boolean;
}

/** Resolve the update mode: NOODLE_UPDATE_MODE, else the NOODLE_AUTO_UPDATE alias, else the default prompt. */
function resolveUpdateMode(env: NodeJS.ProcessEnv): UpdateMode {
  const raw = env.NOODLE_UPDATE_MODE?.toLowerCase();
  if (raw === 'off' || raw === 'notify' || raw === 'check' || raw === 'auto') return raw;
  if (truthyEnv(env.NOODLE_AUTO_UPDATE)) return 'auto';
  return 'prompt';
}

/**
 * Run the passive update check after a successful command. Returns an exit-code
 * overlay only under `NOODLE_UPDATE_MODE=check` (10 = update available); every
 * other outcome — including all failures — resolves `undefined`.
 */
export async function maybeCheckForCliUpdate(input: UpdateCheckInput): Promise<number | undefined> {
  try {
    return await checkForCliUpdate(input);
  } catch {
    return undefined; // an optional check must never break the user's command
  }
}

async function checkForCliUpdate(input: UpdateCheckInput): Promise<number | undefined> {
  const { env } = input;
  if (shouldSkipCommand(input.command)) return undefined;
  if (truthyEnv(env.NOODLE_DISABLE_UPDATE_CHECK)) return undefined;
  if (input.argv?.includes('--json')) return undefined;
  const mode = resolveUpdateMode(env);
  if (mode === 'off') return undefined;

  const noticeCapable = input.noticeCapable ?? process.stderr.isTTY === true;
  const promptCapable = input.promptCapable ?? (process.stdin.isTTY === true && noticeCapable);
  const jsonNotices = truthyEnv(env.NOODLE_UPDATE_JSON);
  // `check` is the automation contract and runs anywhere; everything else stays
  // out of CI and non-interactive shells (never prompt or auto-update there).
  if (mode !== 'check' && (truthyEnv(env.CI) || !noticeCapable)) return undefined;

  const installed = currentCliVersion();
  const fetchImpl = input.fetchImpl ?? fetch;
  const config = readConfig(input.home);
  const wantsPrompt =
    mode === 'prompt' && promptCapable && !truthyEnv(env.NOODLE_NO_PROMPT) && !jsonNotices;

  if (wantsPrompt || mode === 'check') {
    if (wantsPrompt && isSnoozed(config.updateCheck?.snoozedUntil)) return undefined;
    // Deterministic freshness: use the cached latest when fresh, else fetch once.
    let latest: string | undefined;
    let skillsLatest: string | undefined;
    if (isFresh(config.updateCheck?.checkedAt) && config.updateCheck?.latestVersion !== undefined) {
      latest = config.updateCheck.latestVersion;
    } else {
      latest = await fetchLatestVersion(fetchImpl).catch(() => undefined);
      skillsLatest = await fetchLatestAgentKitVersion(fetchImpl).catch(() => undefined);
      if (latest !== undefined || skillsLatest !== undefined) {
        writeCheckCache(input.home, latest, skillsLatest);
      }
    }
    const newer = latest !== undefined && compareVersions(latest, installed) > 0;
    if (mode === 'check') {
      if (!newer || latest === undefined) return undefined;
      emitNotice(jsonNotices, installed, latest);
      return 10;
    }
    if (newer && latest !== undefined) {
      // Snooze before asking so an aborted or killed prompt never repeats.
      snooze(input.home);
      console.error(renderUpdateAvailable(installed, latest, detectColorMode(process.stderr)));
      const ask =
        input.confirmImpl ?? ((message: string) => confirm(message, { output: process.stderr }));
      const accepted = await ask('Update now?').catch(() => false);
      if (accepted) {
        await runUpdate(input)(['--yes']).catch(() => 1);
      } else {
        console.error('Snoozed for 24 hours. Run `noodle update` when ready.');
      }
    }
    maybeSkillsNotice(jsonNotices, skillsLatest);
    return undefined;
  }

  // notify / auto (and non-promptable defaults): the once-per-24h notice pass.
  if (isFresh(config.updateCheck?.checkedAt)) return undefined;
  const latest = await fetchLatestVersion(fetchImpl).catch(() => undefined);
  const skillsLatest = await fetchLatestAgentKitVersion(fetchImpl).catch(() => undefined);
  if (latest === undefined && skillsLatest === undefined) return undefined;
  writeCheckCache(input.home, latest, skillsLatest);
  if (latest !== undefined && compareVersions(latest, installed) > 0) {
    if (mode === 'auto') {
      console.error(`A newer Noodle CLI is available: ${installed} -> ${latest}`);
      console.error(`${autoTrigger(env)} — updating now...`);
      await runUpdate(input)(['--yes']).catch(() => 1);
    } else {
      emitNotice(jsonNotices, installed, latest);
    }
  }
  maybeSkillsNotice(jsonNotices, skillsLatest);
  return undefined;
}

function runUpdate(input: UpdateCheckInput): (rest: readonly string[]) => Promise<number> {
  return input.runUpdate ?? ((rest) => runUpdateCommand(rest, { env: input.env }));
}

function shouldSkipCommand(command: string | undefined): boolean {
  return (
    command === undefined ||
    command === '--version' ||
    command === '-v' ||
    command === 'version' ||
    command === '--help' ||
    command === '-h' ||
    command === 'help' ||
    command === 'update'
  );
}

function emitNotice(jsonNotices: boolean, installed: string, latest: string): void {
  if (jsonNotices) {
    printJsonStreamEvent({
      event: 'update_available',
      package: CLI_PACKAGE_NAME,
      installed,
      latest,
      recommendedCommand: 'noodle update --yes --json',
    });
    return;
  }
  console.error(`A newer Noodle CLI is available: ${installed} -> ${latest}`);
  console.error('Update: noodle update');
}

/** Self-checking skills: notify (never auto-update) when the registry has a newer agent-kit. */
function maybeSkillsNotice(jsonNotices: boolean, skillsLatest: string | undefined): void {
  if (jsonNotices) return; // machine notices carry only the CLI update event
  if (skillsLatest !== undefined && isSkillsUpdateAvailable(skillsLatest)) {
    console.error(skillsUpdatePromptMessage(skillsLatest, bundledAgentKitVersion()));
  }
}

function autoTrigger(env: NodeJS.ProcessEnv): string {
  return env.NOODLE_UPDATE_MODE?.toLowerCase() === 'auto'
    ? 'NOODLE_UPDATE_MODE=auto'
    : 'NOODLE_AUTO_UPDATE is set';
}

function isFresh(checkedAt: string | undefined): boolean {
  if (checkedAt === undefined) return false;
  const checked = Date.parse(checkedAt);
  if (!Number.isFinite(checked)) return false;
  return Date.now() - checked < UPDATE_CHECK_INTERVAL_MS;
}

function isSnoozed(snoozedUntil: string | undefined): boolean {
  if (snoozedUntil === undefined) return false;
  const until = Date.parse(snoozedUntil);
  return Number.isFinite(until) && Date.now() < until;
}

function writeCheckCache(
  home: ConfigLocation,
  latestVersion: string | undefined,
  skillsLatestVersion: string | undefined,
): void {
  const config = readConfig(home);
  writeConfig(
    {
      ...config,
      updateCheck: {
        checkedAt: new Date().toISOString(),
        ...(latestVersion !== undefined ? { latestVersion } : {}),
        ...(skillsLatestVersion !== undefined ? { skillsLatestVersion } : {}),
        ...(config.updateCheck?.snoozedUntil !== undefined &&
        isSnoozed(config.updateCheck.snoozedUntil)
          ? { snoozedUntil: config.updateCheck.snoozedUntil }
          : {}),
      },
    },
    home,
  );
}

function snooze(home: ConfigLocation): void {
  const config = readConfig(home);
  writeConfig(
    {
      ...config,
      updateCheck: {
        checkedAt: config.updateCheck?.checkedAt ?? new Date().toISOString(),
        ...(config.updateCheck?.latestVersion !== undefined
          ? { latestVersion: config.updateCheck.latestVersion }
          : {}),
        ...(config.updateCheck?.skillsLatestVersion !== undefined
          ? { skillsLatestVersion: config.updateCheck.skillsLatestVersion }
          : {}),
        snoozedUntil: new Date(Date.now() + UPDATE_CHECK_INTERVAL_MS).toISOString(),
      },
    },
    home,
  );
}
