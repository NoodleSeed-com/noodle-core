import type {
  AppInspectionView,
  DeploymentInspectionView,
  DeveloperContextView,
  DeveloperMcpContext,
  EventsView,
  GetLogsInput,
  GetMetricsInput,
  GetSessionInput,
  InspectAppInput,
  InspectDeploymentInput,
  ListAppsInput,
  ListAppsView,
  ListEventsInput,
  LogsView,
  MetricsView,
  RollbackDeploymentInput,
  RollbackView,
  SessionView,
} from './contracts.js';

export interface DeveloperControlPlane {
  getContext(ctx: DeveloperMcpContext): Promise<DeveloperContextView>;
  listApps(ctx: DeveloperMcpContext, input: ListAppsInput): Promise<ListAppsView>;
  inspectApp(ctx: DeveloperMcpContext, input: InspectAppInput): Promise<AppInspectionView>;
  inspectDeployment(
    ctx: DeveloperMcpContext,
    input: InspectDeploymentInput,
  ): Promise<DeploymentInspectionView>;
  getLogs(ctx: DeveloperMcpContext, input: GetLogsInput): Promise<LogsView>;
  getMetrics(ctx: DeveloperMcpContext, input: GetMetricsInput): Promise<MetricsView>;
  listEvents(ctx: DeveloperMcpContext, input: ListEventsInput): Promise<EventsView>;
  getSession(ctx: DeveloperMcpContext, input: GetSessionInput): Promise<SessionView>;
  rollbackDeployment(
    ctx: DeveloperMcpContext,
    input: RollbackDeploymentInput,
  ): Promise<RollbackView>;
}

export class DeveloperControlPlaneError extends Error {
  constructor(
    readonly code:
      | 'not_found'
      | 'dependency_unavailable'
      | 'rate_limited'
      | 'forbidden_scope'
      | 'validation_failed',
    message: string,
  ) {
    super(message);
    this.name = 'DeveloperControlPlaneError';
  }
}
