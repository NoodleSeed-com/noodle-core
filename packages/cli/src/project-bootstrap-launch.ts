import { spawn } from 'node:child_process';
import type { AgentTarget } from '@noodle-borg/agent-kit';
import { commandOnPath } from './agent-command-context.js';
import { confirm, select } from './prompts.js';

export type BootstrapLaunchTarget = AgentTarget | 'none';
type LaunchResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'missing_executable' | 'command_failed' };
type LaunchChild = Pick<ReturnType<typeof spawn>, 'once'>;
type LaunchSpawn = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: 'inherit' },
) => LaunchChild;

export function isRunningCodingAgent(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.NOODLE_PLUGIN_HOST || env.CODEX_THREAD_ID || env.CLAUDECODE);
}

/** Offered only after a new project passes; cancelling keeps the ready project intact. */
export async function chooseBootstrapAgent(
  agents: readonly AgentTarget[],
  env: NodeJS.ProcessEnv,
): Promise<BootstrapLaunchTarget> {
  const detected = agents.filter((target) =>
    commandOnPath(target === 'codex' ? 'codex' : 'claude', env),
  );
  if (!detected.length) return 'none';
  try {
    const choices = [
      ...detected.map((target) => ({
        value: target as BootstrapLaunchTarget,
        label: target === 'codex' ? 'Codex' : 'Claude Code',
      })),
      { value: 'none' as const, label: 'Not now' },
    ];
    const choice = await select(
      'Local checks passed. Start a fresh coding-agent session?',
      choices,
      { initial: choices.length - 1 },
    );
    if (choice === 'none') return 'none';
    return (await confirm(
      'Start the selected installed agent in this project with its normal permissions?',
      { initial: false },
    ))
      ? choice
      : 'none';
  } catch {
    return 'none';
  }
}

export function assertBootstrapLaunchAllowed(
  target: BootstrapLaunchTarget,
  agents: readonly AgentTarget[],
  interactive: boolean,
  env: NodeJS.ProcessEnv,
  install: boolean,
): void {
  if (target === 'none') return;
  if (!interactive)
    throw new Error(
      'Fresh agent launch requires an interactive terminal; omit --launch in JSON/CI.',
    );
  if (isRunningCodingAgent(env))
    throw new Error(
      'Do not launch recursively from a running agent; read the new project context or start a fresh session yourself.',
    );
  if (!agents.includes(target))
    throw new Error(
      'Fresh agent launch requires its generated context; include the selected --agents target.',
    );
  if (!install)
    throw new Error(
      'Fresh agent launch requires completed local verification; remove --no-install.',
    );
}

export function bootstrapLaunchCommand(target: AgentTarget): { command: string; args: string[] } {
  return {
    command: target === 'codex' ? 'codex' : 'claude',
    args: [
      'Read AGENTS.md, the Noodle project skill and its routed references, and the generated project README before doing anything. Local synthetic starter checks have passed; the real customer application and hosted deployment are not verified. Do not read secrets or assume production permissions. Ask me which existing application and end-user workflow to integrate, then reuse the maintained recipes and their acceptance tests.',
    ],
  };
}

/** Explicit interactive handoff. No install, shell, saved-session reuse, model or permission override. */
export function launchBootstrapAgent(
  target: AgentTarget,
  project: string,
  env: NodeJS.ProcessEnv,
  spawnAgent: LaunchSpawn = spawn,
): Promise<LaunchResult> {
  const command = bootstrapLaunchCommand(target);
  return new Promise((resolve) => {
    const child = spawnAgent(command.command, command.args, {
      cwd: project,
      env,
      stdio: 'inherit',
    });
    child.once('error', () => resolve({ ok: false, code: 'missing_executable' }));
    child.once('close', (code) =>
      resolve(code === 0 ? { ok: true } : { ok: false, code: 'command_failed' }),
    );
  });
}
