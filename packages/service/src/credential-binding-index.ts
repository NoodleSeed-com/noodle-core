import {
  type ArtifactConnectionSource,
  type ArtifactFulfilment,
  computeConnectionConfigRevision,
  type ResolvedOperationRef,
  type RuntimeArtifact,
} from '@noodle-borg/compiler';
import { type CredentialBindingDescriptor, MapServiceBroker } from '@noodle-borg/runtime';

export interface AllowedCredentialBinding {
  readonly descriptor: CredentialBindingDescriptor;
  readonly source: ArtifactConnectionSource;
  /** Private deploy-plane route key copied from the exact compiled operation reference. */
  readonly customerEndpoint?: string;
}

export interface CredentialBindingIndex {
  readonly byKey: ReadonlyMap<string, AllowedCredentialBinding>;
  readonly externalExchange: readonly AllowedCredentialBinding[];
  readonly googleWorkloadIdentity: readonly AllowedCredentialBinding[];
}

function resolvedOperationRefs(fulfilment: ArtifactFulfilment): readonly ResolvedOperationRef[] {
  if (fulfilment.kind === 'operation') {
    return fulfilment.operationRef.resolved ? [fulfilment.operationRef] : [];
  }
  return fulfilment.steps.flatMap((step) =>
    step.kind === 'operation' && step.operationRef.resolved ? [step.operationRef] : [],
  );
}

/** Build the immutable allowlist solely from trusted, compiled operation references. */
export function buildCredentialBindingIndex(
  artifact: RuntimeArtifact | undefined,
): CredentialBindingIndex {
  const byKey = new Map<string, AllowedCredentialBinding>();
  const externalExchange = new Map<string, AllowedCredentialBinding>();
  const googleWorkloadIdentity = new Map<string, AllowedCredentialBinding>();
  if (artifact === undefined) return { byKey, externalExchange: [], googleWorkloadIdentity: [] };
  const fulfilments: ArtifactFulfilment[] = [
    ...artifact.tools.map((tool) => tool.fulfilment),
    ...(artifact.resources ?? []).map((resource) => resource.fulfilment),
    ...(artifact.prompts ?? []).map((prompt) => prompt.fulfilment),
    ...(artifact.server.context?.ambient === undefined
      ? []
      : [artifact.server.context.ambient.fulfilment]),
  ];
  for (const fulfilment of fulfilments) {
    for (const ref of resolvedOperationRefs(fulfilment)) {
      const credentialBinding = ref.credentialBinding;
      if (credentialBinding === undefined) continue;
      const binding = artifact.connectorBindings?.[credentialBinding.bindingId];
      if (
        binding === undefined ||
        binding.connection.id !== credentialBinding.connectionId ||
        binding.profile !== credentialBinding.profile ||
        computeConnectionConfigRevision(binding.connection) !==
          credentialBinding.connectionConfigRevision
      ) {
        continue;
      }
      const descriptor: CredentialBindingDescriptor = {
        connectorId: ref.connectorId,
        connectorVersion: ref.connectorVersion,
        operation: ref.operation,
        ...credentialBinding,
      };
      const key = MapServiceBroker.bindingKey(descriptor);
      const source = structuredClone(binding.connection.source);
      const allowed = {
        descriptor,
        source,
        ...(ref.customerEndpoint === undefined ? {} : { customerEndpoint: ref.customerEndpoint }),
      };
      byKey.set(key, allowed);
      if (source.kind === 'externalExchange') {
        externalExchange.set(key, allowed);
      }
      if (source.kind === 'googleWorkloadIdentity') {
        googleWorkloadIdentity.set(key, allowed);
      }
    }
  }
  return {
    byKey,
    externalExchange: [...externalExchange.values()],
    googleWorkloadIdentity: [...googleWorkloadIdentity.values()],
  };
}
