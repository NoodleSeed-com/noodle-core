import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectConfigPath } from '../project.js';
import { dimText } from './resource-shared.js';

/** Cheap, offline check: does this project's `.git/config` mention a GitHub remote? */
function hasGithubRemote(cwd: string): boolean {
  try {
    return readFileSync(join(cwd, '.git', 'config'), 'utf8').includes('github.com');
  } catch {
    return false;
  }
}

/**
 * Whether the one-time "connect GitHub" nudge has already been shown for this project. Tracked as
 * an untyped passthrough key in `.noodle/project.json` — the same file `readProjectLink` owns —
 * rather than widening its typed `ProjectLink` schema, since that's out of this wiring's scope.
 */
function readGithubHintShown(cwd: string): boolean {
  try {
    const raw = JSON.parse(readFileSync(projectConfigPath(cwd), 'utf8')) as {
      githubHintShown?: unknown;
    };
    return raw.githubHintShown === true;
  } catch {
    return false;
  }
}

function markGithubHintShown(cwd: string): void {
  try {
    const path = projectConfigPath(cwd);
    const existing = existsSync(path)
      ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>)
      : {};
    writeFileSync(path, `${JSON.stringify({ ...existing, githubHintShown: true }, null, 2)}\n`, {
      mode: 0o600,
    });
  } catch {
    // Best-effort: failing to persist the flag just means the hint might repeat — not worth
    // failing an otherwise-successful deploy over.
  }
}

/**
 * Print the one-time `tip: deploy on every push` nudge after a successful interactive deploy, when
 * the project is a GitHub-remoted git repo and the hint hasn't been shown before.
 */
export function maybePrintGithubHint(cwd: string = process.cwd()): void {
  if (readGithubHintShown(cwd) || !hasGithubRemote(cwd)) return;
  console.log(dimText('tip: deploy on every push — noodle github connect', process.stdout));
  markGithubHintShown(cwd);
}
