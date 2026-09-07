import {
  type EventsView,
  eventsViewSchema,
  getLogsInputSchema,
  getMetricsInputSchema,
  getSessionInputSchema,
  type LogsView,
  listEventsInputSchema,
  logsViewSchema,
  type MetricsView,
  metricsViewSchema,
  type SessionView,
  sessionViewSchema,
} from '../contracts.js';
import type { DeveloperControlPlane } from '../port.js';
import { portError, type ResultContext, successResult, validationError } from '../results.js';

interface OperationsToolContext extends ResultContext {
  readonly controlPlane: DeveloperControlPlane;
}

export async function getLogs(context: OperationsToolContext, input: unknown) {
  const parsed = getLogsInputSchema.safeParse(input);
  if (!parsed.success) return validationError<LogsView>(context, 'Invalid get_logs input.');
  try {
    const data = logsViewSchema.parse(await context.controlPlane.getLogs(context.ctx, parsed.data));
    return successResult({
      ...context,
      data,
      org: parsed.data.org,
      env: parsed.data.env,
      summary: `${data.events.length} recent log event${data.events.length === 1 ? '' : 's'} for ${parsed.data.app}/${parsed.data.env}.`,
      nextActions: [
        { kind: 'call_tool', label: 'Diagnose this app environment', tool: 'diagnose_app' },
        { kind: 'call_tool', label: 'Review request events', tool: 'list_events' },
      ],
    });
  } catch (error) {
    return portError<LogsView>(context, error, parsed.data.org, parsed.data.env);
  }
}

export async function getMetrics(context: OperationsToolContext, input: unknown) {
  const parsed = getMetricsInputSchema.safeParse(input);
  if (!parsed.success) return validationError<MetricsView>(context, 'Invalid get_metrics input.');
  try {
    const data = metricsViewSchema.parse(
      await context.controlPlane.getMetrics(context.ctx, parsed.data),
    );
    return successResult({
      ...context,
      data,
      org: parsed.data.org,
      env: parsed.data.env,
      summary: `${data.metrics.totals.requests} requests observed${data.truncated ? ' (partial window)' : ''}.`,
      nextActions: [
        { kind: 'call_tool', label: 'Inspect request events', tool: 'list_events' },
        { kind: 'call_tool', label: 'Diagnose this app environment', tool: 'diagnose_app' },
      ],
    });
  } catch (error) {
    return portError<MetricsView>(context, error, parsed.data.org, parsed.data.env);
  }
}

export async function listEvents(context: OperationsToolContext, input: unknown) {
  const parsed = listEventsInputSchema.safeParse(input);
  if (!parsed.success) return validationError<EventsView>(context, 'Invalid list_events input.');
  try {
    const data = eventsViewSchema.parse(
      await context.controlPlane.listEvents(context.ctx, parsed.data),
    );
    return successResult({
      ...context,
      data,
      org: parsed.data.org,
      env: parsed.data.env,
      summary: `${data.events.length} request event${data.events.length === 1 ? '' : 's'} matched.`,
      nextActions: [
        { kind: 'call_tool', label: 'Open one session chronology', tool: 'get_session' },
        { kind: 'call_tool', label: 'Diagnose this app environment', tool: 'diagnose_app' },
      ],
    });
  } catch (error) {
    return portError<EventsView>(context, error, parsed.data.org, parsed.data.env);
  }
}

export async function getSession(context: OperationsToolContext, input: unknown) {
  const parsed = getSessionInputSchema.safeParse(input);
  if (!parsed.success) return validationError<SessionView>(context, 'Invalid get_session input.');
  try {
    const data = sessionViewSchema.parse(
      await context.controlPlane.getSession(context.ctx, parsed.data),
    );
    return successResult({
      ...context,
      data,
      org: parsed.data.org,
      env: parsed.data.env,
      summary: `${data.events.length} chronological event${data.events.length === 1 ? '' : 's'} in session ${data.sessionId}.`,
      nextActions: [
        { kind: 'call_tool', label: 'Read correlated application logs', tool: 'get_logs' },
        { kind: 'call_tool', label: 'Diagnose this app environment', tool: 'diagnose_app' },
      ],
    });
  } catch (error) {
    return portError<SessionView>(context, error, parsed.data.org, parsed.data.env);
  }
}
