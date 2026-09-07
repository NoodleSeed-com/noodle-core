import {
  type AppInspectionView,
  appInspectionViewSchema,
  diagnoseAppInputSchema,
  type GetLogsInput,
  type GetMetricsInput,
} from '../contracts.js';
import {
  type DiagnosisEvidence,
  type DiagnosisSource,
  type DiagnosisView,
  diagnoseEvidence,
  diagnosisViewSchema,
} from '../diagnosis.js';
import type { DeveloperControlPlane } from '../port.js';
import { portError, type ResultContext, successResult, validationError } from '../results.js';

interface DiagnoseToolContext extends ResultContext {
  readonly controlPlane: DeveloperControlPlane;
}

export async function diagnoseApp(context: DiagnoseToolContext, input: unknown) {
  const parsed = diagnoseAppInputSchema.safeParse(input);
  if (!parsed.success)
    return validationError<DiagnosisView>(context, 'Invalid diagnose_app input.');
  const { org, app, env } = parsed.data;

  let appView: AppInspectionView;
  try {
    appView = appInspectionViewSchema.parse(
      await context.controlPlane.inspectApp(context.ctx, { org, app, env }),
    );
  } catch (error) {
    return portError<DiagnosisView>(context, error, org, env);
  }

  const evidence: DiagnosisEvidence = { app: { active: appView.active } };
  const sources: DiagnosisSource[] = ['app'];
  const unavailable: DiagnosisSource[] = [];
  if (appView.latest === undefined || appView.latest.environment !== env) {
    return diagnosisResult(context, org, app, env, evidence, sources, unavailable);
  }

  try {
    const deployment = await context.controlPlane.inspectDeployment(context.ctx, {
      org,
      deploymentId: appView.latest.deploymentId,
    });
    evidenceWith(evidence, 'deployment', deployment);
    sources.push('deployment');
    if (deployment.health.state === 'ready') {
      await collectMetrics(context, org, app, env, evidence, sources, unavailable);
    } else {
      await collectLogs(context, org, app, env, evidence, sources, unavailable);
    }
  } catch {
    unavailable.push('deployment');
  }
  return diagnosisResult(context, org, app, env, evidence, sources, unavailable);
}

async function collectMetrics(
  context: DiagnoseToolContext,
  org: string,
  app: string,
  env: string,
  evidence: DiagnosisEvidence,
  sources: DiagnosisSource[],
  unavailable: DiagnosisSource[],
) {
  const input: GetMetricsInput = { org, app, env, window: '24h' };
  try {
    evidenceWith(evidence, 'metrics', await context.controlPlane.getMetrics(context.ctx, input));
    sources.push('metrics');
  } catch {
    unavailable.push('metrics');
  }
}

async function collectLogs(
  context: DiagnoseToolContext,
  org: string,
  app: string,
  env: string,
  evidence: DiagnosisEvidence,
  sources: DiagnosisSource[],
  unavailable: DiagnosisSource[],
) {
  const input: GetLogsInput = { org, app, env, limit: 50, level: 'error' };
  try {
    evidenceWith(evidence, 'logs', await context.controlPlane.getLogs(context.ctx, input));
    sources.push('logs');
  } catch {
    unavailable.push('logs');
  }
}

function evidenceWith<K extends 'deployment' | 'logs' | 'metrics'>(
  evidence: DiagnosisEvidence,
  key: K,
  value: NonNullable<DiagnosisEvidence[K]>,
): void {
  (evidence as Record<K, NonNullable<DiagnosisEvidence[K]>>)[key] = value;
}

function diagnosisResult(
  context: DiagnoseToolContext,
  org: string,
  app: string,
  env: string,
  evidence: DiagnosisEvidence,
  sources: DiagnosisSource[],
  unavailable: DiagnosisSource[],
) {
  const data = diagnosisViewSchema.parse({
    app,
    env,
    findings: diagnoseEvidence({ ...evidence, unavailable }),
    evidence: { sources, unavailable },
  });
  return successResult({
    ...context,
    data,
    org,
    env,
    summary:
      data.findings.length === 0
        ? `${app}/${env} is healthy in the observed evidence.`
        : `${data.findings.length} deterministic finding${data.findings.length === 1 ? '' : 's'} for ${app}/${env}.`,
    nextActions: data.findings.flatMap((finding) =>
      finding.nextAction === undefined ? [] : [finding.nextAction],
    ),
  });
}
