import {
  type CredentialBindingDescriptor,
  type CredentialBroker,
  type CredentialRequest,
  CredentialUnavailableError,
  credentialBindingDescriptorFromRequest,
  type DownstreamCredential,
} from './types.js';

/**
 * Build the lookup key for a connector operation. With `operation`, it keys an exact
 * `(connectorId, operation)` entry; without, it keys the connector-level default.
 */
function entryKey(connectorId: string, operation?: string): string {
  return JSON.stringify(['legacy', connectorId, operation ?? null]);
}

type BindingKeyInput = CredentialBindingDescriptor;

function bindingEntryKey(input: BindingKeyInput): string {
  return JSON.stringify([
    'binding',
    input.connectorId,
    input.connectorVersion,
    input.operation,
    input.bindingId,
    input.connectionId,
    input.connectionConfigRevision,
    input.profile,
    input.presentation.kind === 'bearer' ? ['bearer'] : ['apiKey', input.presentation.header],
    [...input.requiredScopes].sort(),
    input.requiredAudience ?? null,
  ]);
}

/**
 * A service-credential broker backed by a resolved map. It resolves a {@link DownstreamCredential} by
 * `(connectorId, operation)`, falling back to a connector-level default, then to a shared `fallback`
 * (an empty token by default, so operations with no declared auth keep calling public endpoints exactly
 * as before).
 *
 * It holds only already-resolved `{token}` values — it has no knowledge of auth schemes or secret names.
 * Managed deployments use a tenant-aware broker instead; this map broker remains useful for tests/static
 * embeddings. Legacy unbound operations get the empty-token fallback. Binding-scoped requests require
 * the complete compiled descriptor and fail closed; they never fall back to legacy connector keys.
 *
 * The broker method boundary remains `getCredential(request)`, so managed config and tenant scoping layer
 * on top through the broker implementation rather than a separate runtime credential path.
 */
export class MapServiceBroker implements CredentialBroker {
  readonly #byKey: ReadonlyMap<string, DownstreamCredential>;
  readonly #fallback: DownstreamCredential;

  constructor(
    entries: ReadonlyMap<string, DownstreamCredential>,
    fallback: DownstreamCredential = { token: '' },
  ) {
    this.#byKey = entries;
    this.#fallback = fallback;
  }

  getCredential(request: CredentialRequest): Promise<DownstreamCredential> {
    let descriptor: CredentialBindingDescriptor | undefined;
    try {
      descriptor = credentialBindingDescriptorFromRequest(request);
    } catch (error) {
      return Promise.reject(error);
    }
    if (descriptor !== undefined) {
      const exactBinding = this.#byKey.get(bindingEntryKey(descriptor));
      return exactBinding === undefined
        ? Promise.reject(new CredentialUnavailableError('credential_not_configured'))
        : Promise.resolve(exactBinding);
    }
    const exact = this.#byKey.get(entryKey(request.connectorId, request.operation));
    const connectorDefault = this.#byKey.get(entryKey(request.connectorId));
    return Promise.resolve(exact ?? connectorDefault ?? this.#fallback);
  }

  /** Build the map key for `(connectorId, operation?)`; exported so callers can populate the entries. */
  static key = entryKey;
  static bindingKey = bindingEntryKey;
}
