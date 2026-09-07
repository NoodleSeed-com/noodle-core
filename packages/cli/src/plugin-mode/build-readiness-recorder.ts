import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

import {
  type BuildReadinessSnapshot,
  type BuildRunState,
  type BuildStage,
  transitionBuildRun,
} from './build-readiness-contract.js';
import {
  fingerprintAuthoringInputs,
  resolveWorkspaceIdentity,
} from './build-readiness-fingerprint.js';
import { BuildReadinessStore } from './build-readiness-store.js';
import type { PluginMode } from './profile.js';

const RECORDED_COMMANDS = new Map<string, BuildStage>([
  ['init', 'project'],
  ['setup', 'project'],
  ['validate', 'validate'],
  ['test', 'test'],
  ['check', 'target-check'],
  ['devtools', 'preview'],
  ['deploy', 'deploy'],
]);
const INIT_VALUE_OPTIONS = new Set(['--template', '--name', '--agents']);

export interface ManagedInvocationInput {
  readonly command: string | undefined;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly pluginMode: PluginMode;
  readonly now?: () => Date;
  readonly heartbeatMs?: number;
}

export class BuildRunConflictError extends Error {
  readonly runId: string;

  constructor(runId: string) {
    super(`A Noodle build operation is already active (${runId}).`);
    this.name = 'BuildRunConflictError';
    this.runId = runId;
  }
}

export async function recordManagedInvocation(
  input: ManagedInvocationInput,
  invoke: () => Promise<number>,
): Promise<number> {
  const command = input.command;
  if (command === undefined) return invoke();
  // Readiness is not publication and must not advance the plugin's deployment evidence.
  if (command === 'deploy' && input.argv[0] === 'preflight') return invoke();
  const stage = RECORDED_COMMANDS.get(command);
  if (stage === undefined) return invoke();

  const now = input.now ?? (() => new Date());
  const workspaceRoot = recordedWorkspaceRoot(command, input.argv, input.cwd);
  const identity = resolveWorkspaceIdentity(workspaceRoot);
  const store = new BuildReadinessStore(join(input.pluginMode.configHome, 'build-readiness'));
  const startedAtDate = now();
  const startedAt = startedAtDate.toISOString();
  const runId = `run_${randomUUID()}`;
  const sourceFingerprint = await optionalFingerprint(workspaceRoot);
  const queued: BuildRunState = {
    runId,
    stage,
    status: 'queued',
    ...(sourceFingerprint === undefined ? {} : { sourceFingerprint }),
    startedAt,
    heartbeatAt: startedAt,
  };

  await store.interruptExpiredRuns(identity.workspaceHandle, now());
  await store.mutate(identity.workspaceHandle, (current) => appendRun(current, identity, queued));
  await updateRun(store, identity.workspaceHandle, runId, {
    status: 'running',
    heartbeatAt: now().toISOString(),
  });

  const heartbeat = startHeartbeat(
    store,
    identity.workspaceHandle,
    runId,
    now,
    input.heartbeatMs ?? 5_000,
  );

  try {
    const code = await invoke();
    const heartbeatError = await heartbeat.stop();
    if (heartbeatError !== undefined) throw heartbeatError;
    await finishRun(
      store,
      identity.workspaceHandle,
      runId,
      code === 0 ? 'succeeded' : 'failed',
      now,
    );
    return code;
  } catch (error) {
    await heartbeat.stop();
    await finishRun(store, identity.workspaceHandle, runId, 'interrupted', now);
    throw error;
  }
}

function startHeartbeat(
  store: BuildReadinessStore,
  handle: string,
  runId: string,
  now: () => Date,
  intervalMs: number,
): { stop: () => Promise<unknown | undefined> } {
  let pending = Promise.resolve();
  let heartbeatError: unknown;
  const timer = setInterval(
    () => {
      pending = pending
        .then(() =>
          updateRun(store, handle, runId, {
            status: 'running',
            heartbeatAt: now().toISOString(),
          }),
        )
        .catch((error: unknown) => {
          heartbeatError ??= error;
        });
    },
    Math.max(1, intervalMs),
  );
  timer.unref();
  return {
    stop: async () => {
      clearInterval(timer);
      await pending;
      return heartbeatError;
    },
  };
}

function appendRun(
  current: BuildReadinessSnapshot | undefined,
  identity: ReturnType<typeof resolveWorkspaceIdentity>,
  run: BuildRunState,
): BuildReadinessSnapshot {
  const active = current?.runs.find(
    (candidate) => candidate.status === 'queued' || candidate.status === 'running',
  );
  if (active !== undefined) throw new BuildRunConflictError(active.runId);
  const runs = [...(current?.runs ?? []), run].slice(-64);
  return {
    schemaVersion: 1,
    ...identity,
    updatedAt: run.heartbeatAt,
    runs,
    ...(current?.findings === undefined ? {} : { findings: current.findings }),
  };
}

async function finishRun(
  store: BuildReadinessStore,
  handle: string,
  runId: string,
  status: 'succeeded' | 'failed' | 'interrupted',
  now: () => Date,
): Promise<void> {
  const finishedAt = now().toISOString();
  await updateRun(store, handle, runId, { status, heartbeatAt: finishedAt, finishedAt });
}

async function updateRun(
  store: BuildReadinessStore,
  handle: string,
  runId: string,
  update: Parameters<typeof transitionBuildRun>[1],
): Promise<void> {
  await store.mutate(handle, (current) => {
    if (current === undefined) throw new Error('build readiness state disappeared');
    let matched = false;
    const runs = current.runs.map((run) => {
      if (run.runId !== runId) return run;
      matched = true;
      return transitionBuildRun(run, update);
    });
    if (!matched) throw new Error(`build run disappeared (${runId})`);
    return { ...current, updatedAt: update.heartbeatAt, runs };
  });
}

async function optionalFingerprint(root: string): Promise<`sha256:${string}` | undefined> {
  try {
    return await fingerprintAuthoringInputs(root);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function recordedWorkspaceRoot(command: string, argv: readonly string[], cwd: string): string {
  if (command !== 'init') return resolve(cwd);
  let requested: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (INIT_VALUE_OPTIONS.has(argument)) {
      index += 1;
      continue;
    }
    if (!argument.startsWith('-')) {
      requested = argument;
      break;
    }
  }
  return requested === undefined ? resolve(cwd) : resolve(cwd, requested);
}
