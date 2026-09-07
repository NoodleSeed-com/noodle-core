import { createHash } from 'node:crypto';
import type { SigningKeyProvider } from '@noodle-borg/auth';
import type { DelegatedTokenExchangeBinding, SecretBinding } from '@noodle-borg/connector-defs';
import { resolveManagedVariablesInString } from './managed-config-expressions.js';

export interface LocalDevtoolsDelegatedExchangeAuthority {
  readonly issuer: string;
  readonly signer: SigningKeyProvider;
}

export interface LocalDevtoolsDelegatedExchangeSuccess {
  readonly bindingKey: string;
}

export interface LocalDevtoolsDelegatedExchangeRuntime {
  resolve(): Promise<LocalDevtoolsDelegatedExchangeAuthority>;
  onAttempt?(event: LocalDevtoolsDelegatedExchangeBindingProjection): void;
  onSuccess?(event: LocalDevtoolsDelegatedExchangeSuccess): void;
}

export interface LocalDevtoolsDelegatedExchangeBindingProjection {
  readonly bindingKey: string;
  readonly connectorId: string;
  readonly operation?: string;
  readonly audience: string;
}

function lengthPrefixedTuple(values: readonly string[]): string {
  return values.map((value) => `${Buffer.byteLength(value, 'utf8')}:${value}`).join('');
}

export function localDevtoolsDelegatedExchangeBindingKey(
  binding: SecretBinding,
  resolved: DelegatedTokenExchangeBinding,
): string {
  const tuple = lengthPrefixedTuple([
    binding.connectorId,
    binding.connectorVersion,
    binding.operation ?? '',
    resolved.tokenUrl,
    resolved.clientId,
    resolved.audience ?? '',
    lengthPrefixedTuple(resolved.scopes ?? []),
    resolved.authMethod ?? '',
    binding.secretRef ?? '',
  ]);
  return `sha256:${createHash('sha256').update(tuple).digest('hex')}`;
}

export function projectLocalDevtoolsDelegatedExchangeBindings(
  secretBindings: readonly SecretBinding[],
  variables: Readonly<Record<string, string>>,
): readonly LocalDevtoolsDelegatedExchangeBindingProjection[] {
  const projected: LocalDevtoolsDelegatedExchangeBindingProjection[] = [];
  for (const binding of secretBindings) {
    if (binding.authKind !== 'delegatedTokenExchange' || binding.tokenExchange === undefined) {
      continue;
    }
    const declared = binding.tokenExchange;
    const resolved: DelegatedTokenExchangeBinding = {
      ...declared,
      tokenUrl: resolveManagedVariablesInString(declared.tokenUrl, variables),
      clientId: resolveManagedVariablesInString(declared.clientId, variables),
      ...(declared.audience === undefined
        ? {}
        : { audience: resolveManagedVariablesInString(declared.audience, variables) }),
    };
    projected.push({
      bindingKey: localDevtoolsDelegatedExchangeBindingKey(binding, resolved),
      connectorId: binding.connectorId,
      ...(binding.operation === undefined ? {} : { operation: binding.operation }),
      audience: resolved.audience ?? resolved.tokenUrl,
    });
  }
  return projected;
}
