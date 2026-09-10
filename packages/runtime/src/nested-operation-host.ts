import type { ResolvedOperationRef } from '@noodle-borg/compiler';
import { type ConnectorCallHost, ConnectorInvocationError } from './connector/types.js';

/** Bind only exact declared children, retaining the original host's execution/coordination identity. */
export function nestedOperationHost(
  ref: ResolvedOperationRef,
  host: ConnectorCallHost,
  parentSignal?: AbortSignal,
): ConnectorCallHost {
  const calls = ref.calls;
  if (calls === undefined && parentSignal === undefined) return host;
  // Legacy artifacts retain their declaration contract while inheriting the parent's deadline.
  return {
    callOperation(target, args, path) {
      const declared = calls?.find(
        (child) =>
          child.connectorId === target.connectorId &&
          child.connectorVersion === target.connectorVersion &&
          child.operation === target.operation &&
          child.signatureHash === target.signatureHash,
      );
      if (calls !== undefined && declared === undefined)
        throw new ConnectorInvocationError('Undeclared nested connector operation', {
          category: 'invalid_response',
          retryable: false,
        });
      // Invoke as a method on the original host: WeakMap custody frames and private symbol state
      // must never migrate to this projection. Caller-supplied binding metadata has no authority.
      return host.callOperation(declared ?? target, args, path, parentSignal);
    },
  };
}
