import type { OperationSignature } from '@noodle-borg/compiler';
import type { ConnectorCompileError } from './compile-expr.js';
import { operationIdentityKey } from './identity-key.js';
import type { ConnectorDef } from './schema.js';

interface TargetIndexEntry {
  readonly id: string;
  readonly version: string;
  readonly operations: Readonly<Record<string, OperationSignature>>;
}

interface TargetIndex {
  readonly byId: ReadonlyMap<string, TargetIndexEntry | 'ambiguous'>;
}

export function validateComputeCallGraph(
  defs: readonly ConnectorDef[],
  targets: TargetIndex,
  errors: ConnectorCompileError[],
): void {
  const graph = new Map<string, Set<string>>();
  const paths = new Map<string, string>();

  for (const def of defs) {
    for (const opName of Object.keys(def.operations)) {
      const key = operationIdentityKey(def.id, def.version, opName);
      graph.set(key, graph.get(key) ?? new Set());
      paths.set(key, `connectors.${def.id}.operations.${opName}.calls`);
    }
    if ('http' in def || 'mcp' in def) continue;
    for (const [opName, op] of Object.entries(def.operations)) {
      const from = operationIdentityKey(def.id, def.version, opName);
      if (op.calls === undefined) continue;
      for (const target of Object.values(op.calls)) {
        const parsed = parseCallTarget(target);
        if (parsed === null) continue;
        const entry = targets.byId.get(parsed.connectorId);
        if (entry === undefined || entry === 'ambiguous') continue;
        if (entry.operations[parsed.operation] === undefined) continue;
        graph
          .get(from)
          ?.add(operationIdentityKey(parsed.connectorId, entry.version, parsed.operation));
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (node: string, stack: string[]): boolean => {
    if (visiting.has(node)) {
      const cycle = [...stack.slice(stack.indexOf(node)), node];
      errors.push({
        code: 'circular_call_dependency',
        path: paths.get(node) ?? '',
        message: `compute operation calls must be acyclic; found cycle ${cycle.join(' -> ')}`,
      });
      return true;
    }
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const next of graph.get(node) ?? []) {
      if (visit(next, [...stack, next])) return true;
    }
    visiting.delete(node);
    visited.add(node);
    return false;
  };

  for (const node of graph.keys()) {
    if (visit(node, [node])) return;
  }
}

function parseCallTarget(target: string): { connectorId: string; operation: string } | null {
  const parts = target.split('.');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') return null;
  return { connectorId: parts[0] as string, operation: parts[1] as string };
}
