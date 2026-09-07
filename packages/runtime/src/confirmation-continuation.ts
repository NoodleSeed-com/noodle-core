import type { RuntimeArtifact } from '@noodle-borg/compiler';
import type {
  ConfirmationActionReview,
  ConfirmationPreparationResult,
  PreparedOperationAction,
  PreparedToolContinuation,
  ToolPreparationContinuation,
} from './result.js';

export function confirmationRequired(
  artifact: RuntimeArtifact,
  toolName: string,
  input: unknown,
  nextStepIndex: number,
  completedSteps: Record<string, unknown>,
  elicited: Record<string, unknown>,
  env: Record<string, unknown>,
  action?: {
    readonly prepared: PreparedOperationAction;
    readonly review: ConfirmationActionReview;
  },
  executionRevision?: string,
): ConfirmationPreparationResult {
  const reviewedAction =
    action === undefined
      ? undefined
      : {
          connectorId: action.prepared.connectorId,
          connectorVersion: action.prepared.connectorVersion,
          operation: action.prepared.operation,
          ...(action.prepared.bindingId !== undefined
            ? { bindingId: action.prepared.bindingId }
            : {}),
          ...(action.prepared.connectionId !== undefined
            ? { connectionId: action.prepared.connectionId }
            : {}),
          ...(action.prepared.connectionConfigRevision !== undefined
            ? { connectionConfigRevision: action.prepared.connectionConfigRevision }
            : {}),
          ...(action.prepared.profile !== undefined ? { profile: action.prepared.profile } : {}),
          ...(action.prepared.presentation !== undefined
            ? { presentation: structuredClone(action.prepared.presentation) }
            : {}),
          ...(action.prepared.requiredScopes !== undefined
            ? { requiredScopes: [...action.prepared.requiredScopes] }
            : {}),
          ...(action.prepared.requiredAudience !== undefined
            ? { requiredAudience: action.prepared.requiredAudience }
            : {}),
          arguments: action.prepared.arguments,
          ...(action.prepared.customerRoutes === undefined
            ? {}
            : {
                customerRoutes: action.prepared.customerRoutes.map(({ key, fingerprint }) => ({
                  key,
                  fingerprint,
                })),
              }),
        };
  return {
    status: 'confirmation_required',
    review: {
      input,
      elicited: { ...elicited },
      ...(action !== undefined ? { action: action.review } : {}),
    },
    continuation: {
      kind: 'prepared_confirmation',
      ...(executionRevision === undefined ? {} : { executionRevision }),
      version: 1,
      artifact: artifactIdentity(artifact),
      toolName,
      input,
      nextStepIndex,
      completedSteps: { ...completedSteps },
      env: { ...env },
      ...(reviewedAction !== undefined ? { reviewedAction } : {}),
    },
  };
}

export function sameArtifact(
  artifact: RuntimeArtifact,
  continuation: ToolPreparationContinuation | PreparedToolContinuation,
): boolean {
  const expected = artifactIdentity(artifact);
  return (
    expected.manifestName === continuation.artifact.manifestName &&
    expected.manifestVersion === continuation.artifact.manifestVersion &&
    expected.serverName === continuation.artifact.serverName &&
    expected.serverVersion === continuation.artifact.serverVersion
  );
}

export function artifactIdentity(
  artifact: RuntimeArtifact,
): ToolPreparationContinuation['artifact'] {
  return {
    manifestName: artifact.source.manifestName,
    manifestVersion: artifact.source.manifestVersion,
    serverName: artifact.server.name,
    serverVersion: artifact.server.version,
  };
}
