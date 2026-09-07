import { type DeveloperContextView, developerContextViewSchema } from '../contracts.js';
import type { DeveloperControlPlane } from '../port.js';
import { portError, type ResultContext, successResult } from '../results.js';

interface ContextToolContext extends ResultContext {
  readonly controlPlane: DeveloperControlPlane;
}

export async function getContext(context: ContextToolContext) {
  try {
    const data = developerContextViewSchema.parse(
      await context.controlPlane.getContext(context.ctx),
    );
    return successResult({
      ...context,
      data,
      summary: `${data.organizations.length} organization${data.organizations.length === 1 ? '' : 's'} available through live user access.`,
      nextActions: [
        { kind: 'call_tool', label: 'List apps in an organization', tool: 'list_apps' },
        {
          kind: 'read_resource',
          label: 'Review the Noodle developer workflow',
          resource: 'noodle://developer/workflow/v2',
        },
      ],
    });
  } catch (error) {
    return portError<DeveloperContextView>(context, error);
  }
}
