/**
 * Bare-`noodle` first-run detection, kept out of the dispatch-only `cli.ts`.
 *
 * On an interactive TTY for a genuine first-run (no saved account and no project in
 * this directory), offer the guided `noodle start` walkthrough. Everything else —
 * pipes, CI, agents, a configured user, or an existing project — gets plain usage.
 * The wizard is never forced on a non-interactive caller.
 */
import { usage } from './commands/shared.js';
import type { ConfigLocation } from './config.js';
import { readConfig } from './config.js';
import { runStart } from './first-run.js';
import { resolveLocalEntrypoint } from './project.js';
import { confirm, isInteractive } from './prompts.js';

export async function offerFirstRun(env: NodeJS.ProcessEnv, home: ConfigLocation): Promise<number> {
  const config = readConfig(home);
  const configured = config.identity !== undefined || config.authToken !== undefined;
  const hasProject = resolveLocalEntrypoint(process.cwd()) !== undefined;

  if (isInteractive() && !configured && !hasProject) {
    let wants = false;
    try {
      wants = await confirm('New here? Set up your first server with a guided walkthrough?', {
        initial: true,
      });
    } catch {
      wants = false; // Esc/Ctrl+C on the offer → just show usage
    }
    if (wants) return runStart([], env, home);
    usage(console.log);
    return 0;
  }

  usage();
  return 1;
}
