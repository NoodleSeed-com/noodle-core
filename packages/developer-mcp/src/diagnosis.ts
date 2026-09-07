import { z } from 'zod';

import {
  type AppInspectionView,
  appSlugSchema,
  type DeploymentInspectionView,
  developerNextActionSchema,
  environmentNameSchema,
  type LogsView,
  type MetricsView,
} from './contracts.js';

export const DIAGNOSIS_SOURCES = ['app', 'deployment', 'logs', 'metrics'] as const;
export type DiagnosisSource = (typeof DIAGNOSIS_SOURCES)[number];

export const diagnosticFindingSchema = z.strictObject({
  severity: z.enum(['error', 'warning', 'info']),
  code: z.string().min(1).max(100),
  title: z.string().min(1).max(200),
  message: z.string().min(1).max(2_000),
  evidence: z.array(z.string().min(1).max(200)).max(20),
  nextAction: developerNextActionSchema.optional(),
});
export type DiagnosticFinding = z.infer<typeof diagnosticFindingSchema>;

export const diagnosisViewSchema = z.strictObject({
  app: appSlugSchema,
  env: environmentNameSchema,
  findings: z.array(diagnosticFindingSchema).max(100),
  evidence: z.strictObject({
    sources: z.array(z.enum(DIAGNOSIS_SOURCES)).max(DIAGNOSIS_SOURCES.length),
    unavailable: z.array(z.enum(DIAGNOSIS_SOURCES)).max(DIAGNOSIS_SOURCES.length),
  }),
});
export type DiagnosisView = z.infer<typeof diagnosisViewSchema>;

export interface DiagnosisEvidence {
  readonly app?: Pick<AppInspectionView, 'active'>;
  readonly deployment?: DeploymentInspectionView;
  readonly logs?: LogsView;
  readonly metrics?: MetricsView;
  readonly unavailable?: readonly DiagnosisSource[];
}

const SEVERITY_ORDER = new Map<DiagnosticFinding['severity'], number>([
  ['error', 0],
  ['warning', 1],
  ['info', 2],
]);

export function diagnoseEvidence(evidence: DiagnosisEvidence): readonly DiagnosticFinding[] {
  const findings: DiagnosticFinding[] = [];
  const missingSecrets = evidence.deployment?.health.missingSecrets ?? [];
  if (missingSecrets.length > 0) {
    const sorted = [...missingSecrets].sort();
    findings.push({
      severity: 'error',
      code: 'missing_managed_config',
      title: 'Managed configuration is incomplete',
      message: `${sorted.length} required secret${sorted.length === 1 ? ' is' : 's are'} missing.`,
      evidence: ['deployment.health.missingSecrets'],
      nextAction: {
        kind: 'run_cli',
        label:
          sorted.length === 1
            ? 'Set the missing managed secret'
            : `Set ${sorted[0]} first (${sorted.length} secrets missing)`,
        command: `noodle secrets set ${sorted[0] as string}`,
      },
    });
  } else if (
    evidence.deployment !== undefined &&
    evidence.deployment.health.state !== 'ready' &&
    evidence.deployment.health.state !== 'missing-config'
  ) {
    findings.push({
      severity: 'error',
      code: 'deployment_unhealthy',
      title: 'Deployment is not ready',
      message: `Deployment health is ${evidence.deployment.health.state}.`,
      evidence: ['deployment.health.state'],
      nextAction: {
        kind: 'inspect_code',
        label: 'Ask the coding agent to inspect the local project against this evidence',
      },
    });
  }

  if (evidence.app?.active === false && evidence.deployment === undefined) {
    findings.push({
      severity: 'error',
      code: 'no_active_deployment',
      title: 'No active deployment',
      message: 'The selected app environment has no active deployment.',
      evidence: ['app.active'],
      nextAction: {
        kind: 'run_cli',
        label: 'Validate the local project before deploying',
        command: 'noodle validate',
      },
    });
  }

  const metrics = evidence.metrics?.metrics;
  if (
    metrics !== undefined &&
    metrics.totals.requests >= 5 &&
    metrics.errors.toolErrorRate >= 0.1
  ) {
    findings.push({
      severity: 'warning',
      code: 'tool_error_spike',
      title: 'Tool errors are elevated',
      message: `${Math.round(metrics.errors.toolErrorRate * 100)}% of recent requests ended in tool errors.`,
      evidence: ['metrics.errors.toolErrorRate', 'metrics.totals.requests'],
      nextAction: { kind: 'call_tool', label: 'Inspect recent tool errors', tool: 'list_events' },
    });
  }
  if (evidence.metrics?.truncated === true) {
    findings.push({
      severity: 'warning',
      code: 'partial_analytics',
      title: 'Analytics evidence is partial',
      message: 'The bounded analytics scan reached its limit; aggregate values are incomplete.',
      evidence: ['metrics.truncated'],
      nextAction: {
        kind: 'call_tool',
        label: 'Inspect a narrower request window',
        tool: 'get_metrics',
      },
    });
  }
  if (evidence.logs?.events.some((event) => event.level === 'error')) {
    findings.push({
      severity: 'warning',
      code: 'recent_log_errors',
      title: 'Recent application errors were logged',
      message: 'The bounded log window contains one or more error events.',
      evidence: ['logs.events.level'],
      nextAction: { kind: 'call_tool', label: 'Inspect recent logs', tool: 'get_logs' },
    });
  }
  if ((evidence.unavailable?.length ?? 0) > 0) {
    findings.push({
      severity: 'warning',
      code: 'source_unavailable',
      title: 'Some diagnostic evidence is unavailable',
      message: `Unavailable sources: ${[...(evidence.unavailable ?? [])].sort().join(', ')}.`,
      evidence: ['evidence.unavailable'],
    });
  }
  if (
    evidence.app === undefined &&
    evidence.deployment === undefined &&
    evidence.logs === undefined &&
    evidence.metrics === undefined &&
    (evidence.unavailable?.length ?? 0) === 0
  ) {
    findings.push({
      severity: 'info',
      code: 'insufficient_evidence',
      title: 'No diagnostic evidence was supplied',
      message: 'Inspect the app environment before drawing a conclusion.',
      evidence: [],
      nextAction: { kind: 'call_tool', label: 'Inspect the app', tool: 'inspect_app' },
    });
  }

  return findings.sort(
    (left, right) =>
      (SEVERITY_ORDER.get(left.severity) ?? 99) - (SEVERITY_ORDER.get(right.severity) ?? 99) ||
      left.code.localeCompare(right.code),
  );
}
