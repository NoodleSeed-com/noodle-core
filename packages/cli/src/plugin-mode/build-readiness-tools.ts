import type {
  BuildFinding,
  BuildReadinessSnapshot,
  BuildRunState,
  BuildStage,
} from './build-readiness-contract.js';
import { fingerprintAuthoringInputs } from './build-readiness-fingerprint.js';
import type { BuildReadinessStore } from './build-readiness-store.js';

export type BuildGateOperation = 'validate' | 'test' | 'target-check' | 'preview';
type BuildReadinessDecision =
  | 'action-required'
  | 'running'
  | 'ready-to-deploy'
  | 'deployed'
  | 'unavailable';
type BuildReadinessStageStatus =
  | 'not-run'
  | 'running'
  | 'passed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'stale';

interface BuildReadinessStageView {
  readonly id: BuildStage;
  readonly label: string;
  readonly status: BuildReadinessStageStatus;
  readonly tone: 'ok' | 'warn' | 'error' | 'neutral';
  readonly runId?: string;
}

interface BuildReadinessAction {
  readonly id: string;
  readonly label: string;
}

export interface BuildReadinessView {
  readonly decision: BuildReadinessDecision;
  readonly tone: 'ok' | 'warn' | 'error' | 'neutral';
  readonly title: string;
  readonly summary: string;
  readonly workspaceHandle: string;
  readonly sourceFingerprint?: string;
  readonly activeRunId?: string;
  readonly stages: readonly BuildReadinessStageView[];
  readonly findings: readonly BuildFinding[];
  readonly nextActions: readonly BuildReadinessAction[];
  readonly actions: {
    readonly validate: boolean;
    readonly test: boolean;
    readonly targetCheck: boolean;
    readonly preview: boolean;
    readonly deploy: boolean;
    readonly cancel: boolean;
  };
}

const ORDERED_STAGES: readonly BuildStage[] = [
  'project',
  'validate',
  'test',
  'target-check',
  'preview',
  'deploy',
];
const REQUIRED_STAGES: readonly BuildStage[] = ['validate', 'test', 'target-check'];

export const BUILD_GATE_COMMANDS: Readonly<
  Record<BuildGateOperation, { readonly command: string; readonly args: readonly string[] }>
> = {
  validate: { command: 'validate', args: ['--json'] },
  test: { command: 'test', args: ['--json'] },
  'target-check': { command: 'check', args: ['--target', 'generic', '--json'] },
  preview: { command: 'devtools', args: [] },
};

export async function projectBuildReadiness(input: {
  readonly store: BuildReadinessStore;
  readonly workspaceRoot: string;
  readonly workspaceHandle: string;
  readonly now: Date;
}): Promise<BuildReadinessView> {
  const currentFingerprint = await optionalFingerprint(input.workspaceRoot);
  const snapshot = await input.store.interruptExpiredRuns(input.workspaceHandle, input.now);
  const latest = latestRuns(snapshot);
  const stages = ORDERED_STAGES.map((stage) =>
    stageView(stage, latest.get(stage), currentFingerprint),
  );
  const active = [...latest.values()].find(
    (run) => run.status === 'queued' || run.status === 'running',
  );
  if (active !== undefined) {
    return view(input.workspaceHandle, currentFingerprint, stages, snapshot, {
      decision: 'running',
      title: `${stageLabel(active.stage)} is running`,
      summary: 'The managed Noodle command is still active.',
      activeRunId: active.runId,
      nextActions: [{ id: 'cancel-run', label: 'Cancel run' }],
    });
  }

  const deployed = stages.find((stage) => stage.id === 'deploy');
  if (deployed?.status === 'passed') {
    return view(input.workspaceHandle, currentFingerprint, stages, snapshot, {
      decision: 'deployed',
      title: 'Build deployed',
      summary: 'The verified source fingerprint was deployed to Noodle Cloud.',
      nextActions: [],
    });
  }

  const nextRequired = REQUIRED_STAGES.map((stage) =>
    stages.find((candidate) => candidate.id === stage),
  ).find((stage) => stage?.status !== 'passed');
  if (nextRequired !== undefined) {
    const action = actionForStage(nextRequired.id);
    const blocked = nextRequired.status === 'failed' || nextRequired.status === 'interrupted';
    return view(input.workspaceHandle, currentFingerprint, stages, snapshot, {
      decision: 'action-required',
      title: blocked ? `${stageLabel(nextRequired.id)} needs attention` : action.label,
      summary: blocked
        ? 'Resolve the bounded findings, then rerun this gate.'
        : 'Continue the verified local build sequence.',
      nextActions: [action],
    });
  }

  return view(input.workspaceHandle, currentFingerprint, stages, snapshot, {
    decision: 'ready-to-deploy',
    title: 'Ready to deploy',
    summary: 'Validation, tests, and the target check passed for the current source.',
    nextActions: [
      { id: 'deploy', label: 'Deploy build' },
      { id: 'run-preview', label: 'Open preview' },
    ],
  });
}

function view(
  workspaceHandle: string,
  sourceFingerprint: string | undefined,
  stages: readonly BuildReadinessStageView[],
  snapshot: BuildReadinessSnapshot | undefined,
  decision: Pick<BuildReadinessView, 'decision' | 'title' | 'summary' | 'nextActions'> & {
    readonly activeRunId?: string;
  },
): BuildReadinessView {
  const actionIds = new Set(decision.nextActions.map((action) => action.id));
  return {
    ...decision,
    tone:
      decision.decision === 'ready-to-deploy' || decision.decision === 'deployed'
        ? 'ok'
        : decision.decision === 'action-required'
          ? 'warn'
          : 'neutral',
    workspaceHandle,
    ...(sourceFingerprint === undefined ? {} : { sourceFingerprint }),
    stages,
    findings: (snapshot?.findings ?? []).slice(0, 3),
    actions: {
      validate: actionIds.has('run-validate'),
      test: actionIds.has('run-test'),
      targetCheck: actionIds.has('run-target-check'),
      preview: actionIds.has('run-preview'),
      deploy: actionIds.has('deploy'),
      cancel: actionIds.has('cancel-run'),
    },
  };
}

function latestRuns(snapshot: BuildReadinessSnapshot | undefined): Map<BuildStage, BuildRunState> {
  const latest = new Map<BuildStage, BuildRunState>();
  for (const run of snapshot?.runs ?? []) latest.set(run.stage, run);
  return latest;
}

function stageView(
  stage: BuildStage,
  run: BuildRunState | undefined,
  currentFingerprint: string | undefined,
): BuildReadinessStageView {
  if (stage === 'project') {
    const status = currentFingerprint === undefined ? 'not-run' : 'passed';
    return { id: stage, label: stageLabel(stage), status, tone: toneForStage(status) };
  }
  if (run === undefined)
    return { id: stage, label: stageLabel(stage), status: 'not-run', tone: 'neutral' };
  if (
    currentFingerprint !== undefined &&
    run.sourceFingerprint !== undefined &&
    run.sourceFingerprint !== currentFingerprint
  ) {
    return {
      id: stage,
      label: stageLabel(stage),
      status: 'stale',
      tone: 'warn',
      runId: run.runId,
    };
  }
  const status: BuildReadinessStageStatus =
    run.status === 'succeeded'
      ? 'passed'
      : run.status === 'failed'
        ? 'failed'
        : run.status === 'cancelled'
          ? 'cancelled'
          : run.status === 'interrupted'
            ? 'interrupted'
            : 'running';
  return {
    id: stage,
    label: stageLabel(stage),
    status,
    tone: toneForStage(status),
    runId: run.runId,
  };
}

function toneForStage(status: BuildReadinessStageStatus): 'ok' | 'warn' | 'error' | 'neutral' {
  if (status === 'passed') return 'ok';
  if (status === 'failed') return 'error';
  if (status === 'stale' || status === 'interrupted' || status === 'cancelled') return 'warn';
  return 'neutral';
}

function actionForStage(stage: BuildStage): BuildReadinessAction {
  if (stage === 'test') return { id: 'run-test', label: 'Run tests' };
  if (stage === 'target-check') return { id: 'run-target-check', label: 'Check target' };
  return { id: 'run-validate', label: 'Validate project' };
}

function stageLabel(stage: BuildStage): string {
  if (stage === 'target-check') return 'Target check';
  return `${stage[0]?.toUpperCase() ?? ''}${stage.slice(1)}`;
}

async function optionalFingerprint(root: string): Promise<string | undefined> {
  try {
    return await fingerprintAuthoringInputs(root);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}
