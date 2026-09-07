import type { ResolvedOperationRef } from '@noodle-borg/compiler';
import { type CredentialBroker, credentialUnavailableErrorSnapshot } from './broker/types.js';
import type { CustomerConnectorRoute } from './customer-routing.js';
import type { ExecuteDeps } from './execute.js';
import type { ExecutionError } from './result.js';

type OperationCredentialResult =
  | {
      readonly ok: true;
      readonly credential: Awaited<ReturnType<CredentialBroker['getCredential']>>;
    }
  | { readonly ok: false; readonly error: ExecutionError };

/** Acquire a connector credential using only the URL-blind customer route binding. */
export async function acquireOperationCredential(
  ref: ResolvedOperationRef,
  deps: ExecuteDeps,
  customerRoute: CustomerConnectorRoute | undefined,
): Promise<OperationCredentialResult> {
  try {
    const credential = await deps.broker.getCredential({
      connectorId: ref.connectorId,
      connectorVersion: ref.connectorVersion,
      operation: ref.operation,
      ...(ref.credentialBinding ?? {}),
      ...(ref.credentialBinding?.connectionId === undefined ||
      deps.executionBinding?.connections[ref.credentialBinding.connectionId] === undefined
        ? {}
        : {
            expectedConnectionGeneration:
              deps.executionBinding.connections[ref.credentialBinding.connectionId],
          }),
      ...(deps.tenantId !== undefined ? { tenantId: deps.tenantId } : {}),
      ...(deps.deploymentId !== undefined ? { deploymentId: deps.deploymentId } : {}),
      ...(deps.caller !== undefined ? { caller: deps.caller } : {}),
      ...(deps.customerIssuer !== undefined ? { customerIssuer: deps.customerIssuer } : {}),
      ...(customerRoute === undefined
        ? {}
        : {
            route: {
              key: customerRoute.key,
              fingerprint: customerRoute.fingerprint,
            },
          }),
    });
    return { ok: true, credential };
  } catch (error) {
    const message = `credential unavailable for operation "${ref.operation}"`;
    const snapshot = credentialUnavailableErrorSnapshot(error);
    if (snapshot?.reason === 'connector_route_unavailable') {
      return {
        ok: false,
        error: {
          code: 'connector_route_unavailable',
          message: 'Customer connector route is unavailable.',
        },
      };
    }
    if (snapshot !== undefined) {
      return {
        ok: false,
        error: {
          code: 'credential_unavailable',
          message,
          reason: snapshot.reason,
          ...(snapshot.fix === undefined ? {} : { fix: snapshot.fix }),
          ...(snapshot.next === undefined ? {} : { next: snapshot.next }),
        },
      };
    }
    return {
      ok: false,
      error: {
        code: 'credential_unavailable',
        message,
      },
    };
  }
}
