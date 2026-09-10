import type { OperationRef, ResolvedOperationRef } from './artifact/operation-ref.js';
import { computeSignatureHash } from './catalog/signature.js';
import type { CatalogConnector, ConnectorCatalog } from './catalog/types.js';
import type { CompileError } from './errors.js';
import type { DeclaredConnectorRef } from './fulfilment-emit.js';
import type { StructOp } from './fulfilment-structural.js';

export interface NestedOperationTraversal {
  readonly ancestors: readonly string[];
  readonly budget: { remaining: number };
}

/** Resolve reachable system-derived dependency identities without guessing between account aliases. */
export function resolveNestedOperations(input: {
  readonly connector: CatalogConnector;
  readonly operation: string;
  readonly path: string;
  readonly catalog: ConnectorCatalog;
  readonly declared: Record<string, DeclaredConnectorRef>;
  readonly errors: CompileError[];
  readonly traversal?: NestedOperationTraversal;
  readonly resolve: (
    op: StructOp,
    declared: Record<string, DeclaredConnectorRef>,
    traversal: NestedOperationTraversal,
  ) => OperationRef;
}): readonly ResolvedOperationRef[] | undefined {
  const calls = input.connector.operationCalls?.[input.operation];
  if (calls === undefined) return undefined;
  const identity = JSON.stringify([input.connector.id, input.connector.version, input.operation]);
  const traversal = input.traversal ?? { ancestors: [], budget: { remaining: 1024 } };
  if (
    !Array.isArray(calls) ||
    traversal.ancestors.includes(identity) ||
    traversal.ancestors.length >= 32 ||
    traversal.budget.remaining-- <= 0
  ) {
    input.errors.push({
      code: 'invalid_connector_call_graph',
      path: input.path,
      message: 'Nested connector calls must be acyclic and within the compiler graph bounds',
    });
    return [];
  }
  const next = { ancestors: [...traversal.ancestors, identity], budget: traversal.budget };
  const output: ResolvedOperationRef[] = [];
  const seen = new Set<string>();
  for (const target of calls) {
    if (traversal.budget.remaining-- <= 0) {
      input.errors.push({
        code: 'invalid_connector_call_graph',
        path: input.path,
        message: 'Nested connector call graph exceeds the compiler bound',
      });
      break;
    }
    const targetConnector = input.catalog.get(target.connectorId, target.connectorVersion);
    const signature = targetConnector?.operations[target.operation];
    if (
      signature === undefined ||
      computeSignatureHash(target.operation, signature) !== target.signatureHash
    ) {
      input.errors.push({
        code: 'invalid_connector_call_graph',
        path: input.path,
        message: 'Nested connector identity or signature does not match the declared catalog',
      });
      continue;
    }
    const key = JSON.stringify([target.connectorId, target.connectorVersion, target.operation]);
    if (seen.has(key)) continue;
    seen.add(key);
    const aliases = Object.entries(input.declared).filter(
      ([, ref]) => ref.id === target.connectorId && ref.version === target.connectorVersion,
    );
    if (aliases.length > 1) {
      input.errors.push({
        code: 'ambiguous_nested_connector_binding',
        path: input.path,
        message: `Nested connector "${target.connectorId}@${target.connectorVersion}" matches multiple aliases; declare one unambiguous account binding for this connector`,
      });
      continue;
    }
    // Unbound catalog-only dependencies retain their existing behavior; credential-required targets
    // still fail normal profile validation when no exact manifest account binding exists.
    const alias = aliases[0]?.[0] ?? `#${target.connectorId}@${target.connectorVersion}`;
    const declared =
      aliases.length === 0
        ? {
            ...input.declared,
            [alias]: { id: target.connectorId, version: target.connectorVersion },
          }
        : input.declared;
    const resolved = input.resolve(
      { connectorAlias: alias, operation: target.operation, args: {}, path: `${input.path}.calls` },
      declared,
      next,
    );
    if (resolved.resolved) output.push(resolved);
  }
  return output;
}
