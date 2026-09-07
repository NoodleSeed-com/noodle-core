import {
  type DeploymentInspectionView,
  deploymentInspectionViewSchema,
  inspectDeploymentInputSchema,
} from '../contracts.js';
import type { DeveloperControlPlane } from '../port.js';
import { portError, type ResultContext, successResult, validationError } from '../results.js';

interface DeploymentToolContext extends ResultContext {
  readonly controlPlane: DeveloperControlPlane;
}

export async function inspectDeployment(context: DeploymentToolContext, input: unknown) {
  const parsed = inspectDeploymentInputSchema.safeParse(input);
  if (!parsed.success) {
    return validationError<DeploymentInspectionView>(context, 'Invalid inspect_deployment input.');
  }
  try {
    const data = deploymentInspectionViewSchema.parse(
      await context.controlPlane.inspectDeployment(context.ctx, parsed.data),
    );
    return successResult({
      ...context,
      data,
      org: parsed.data.org,
      env: data.target.env,
      summary: `${data.deployment.serverName} is ${data.health.state} in ${data.target.env}.`,
      nextActions: [
        { kind: 'call_tool', label: 'Read recent deployment logs', tool: 'get_logs' },
        { kind: 'call_tool', label: 'Review request metrics', tool: 'get_metrics' },
        {
          kind: 'run_cli',
          label: 'Validate the local project with the Noodle CLI',
          command: 'noodle validate',
        },
      ],
    });
  } catch (error) {
    return portError<DeploymentInspectionView>(context, error, parsed.data.org);
  }
}
