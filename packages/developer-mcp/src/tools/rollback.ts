import {
  type RollbackView,
  rollbackDeploymentInputSchema,
  rollbackViewSchema,
} from '../contracts.js';
import type { DeveloperControlPlane } from '../port.js';
import {
  errorResult,
  portError,
  type ResultContext,
  successResult,
  validationError,
} from '../results.js';

interface RollbackToolContext extends ResultContext {
  readonly controlPlane: DeveloperControlPlane;
}

export async function rollbackDeployment(context: RollbackToolContext, input: unknown) {
  if (!context.ctx.capabilities.includes('deployments:rollback')) {
    return errorResult<RollbackView>({
      ...context,
      code: 'capability_missing',
      message: 'This connection does not grant deployment rollback.',
      nextActions: [
        {
          kind: 'read_resource',
          label: 'Review Developer MCP capabilities',
          resource: 'noodle://developer/capabilities/v2',
        },
      ],
    });
  }
  const parsed = rollbackDeploymentInputSchema.safeParse(input);
  if (!parsed.success) {
    return validationError<RollbackView>(context, 'Invalid rollback_deployment input.');
  }
  try {
    const data = rollbackViewSchema.parse(
      await context.controlPlane.rollbackDeployment(context.ctx, parsed.data),
    );
    if (data.target.app !== parsed.data.app || data.target.env !== parsed.data.env) {
      return errorResult<RollbackView>({
        ...context,
        code: 'internal_error',
        message: 'Noodle Cloud returned an out-of-scope rollback response.',
        org: parsed.data.org,
        env: parsed.data.env,
      });
    }
    return successResult({
      ...context,
      data,
      org: parsed.data.org,
      env: parsed.data.env,
      summary: data.rollback.alreadyActive
        ? `${data.rollback.serverName} deployment ${data.rollback.deploymentId} was already active.`
        : `${data.rollback.serverName} rolled back to deployment ${data.rollback.deploymentId}.`,
      nextActions: [
        {
          kind: 'call_tool',
          label: 'Inspect the active deployment',
          tool: 'inspect_deployment',
        },
        { kind: 'call_tool', label: 'Read post-rollback logs', tool: 'get_logs' },
        { kind: 'call_tool', label: 'Review post-rollback metrics', tool: 'get_metrics' },
      ],
    });
  } catch (error) {
    return portError<RollbackView>(context, error, parsed.data.org, parsed.data.env);
  }
}
