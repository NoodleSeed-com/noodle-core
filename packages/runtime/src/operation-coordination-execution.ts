import type { ConnectorCallHost } from './connector/types.js';
import { evaluateValue } from './eval/evaluate.js';
import type { ExecuteDeps } from './execute.js';
import type {
  OperationCoordinationDeclaration,
  OperationCoordinationLease,
} from './operation-coordination.js';

interface CoordinationFrame {
  readonly lease: OperationCoordinationLease;
  readonly executionId: string;
  writeStarted: boolean;
}
const frames = new WeakMap<ConnectorCallHost, CoordinationFrame[]>();

/** Parent evidence is runtime-owned. Child receipts remain durable but are not duplicate business rows. */
export function coordinatedParentId(host: ConnectorCallHost): string | undefined {
  return frames.get(host)?.at(-1)?.executionId;
}

/** Every nested action traverses this guard before credentials or provider I/O. */
export function admitCoordinatedAction(host: ConnectorCallHost): boolean {
  const frame = frames.get(host)?.at(-1);
  if (!frame) return true;
  if (!frame.lease.acquired || frame.writeStarted) return false;
  frame.writeStarted = true;
  return true;
}

export async function beginOperationCoordination(input: {
  declaration: OperationCoordinationDeclaration;
  executionId: string;
  executionBoundMs: number | undefined;
  args: Readonly<Record<string, unknown>>;
  env: Readonly<Record<string, unknown>>;
  deps: ExecuteDeps;
  host: ConnectorCallHost;
}): Promise<{
  lease: OperationCoordinationLease;
  didAdmitAction: () => boolean;
  dispose: () => void;
}> {
  if (
    !input.deps.operationCoordination ||
    !input.executionBoundMs ||
    frames.get(input.host)?.length
  )
    throw new Error('Coordination authority unavailable');
  const scope = { args: input.args, env: input.env, execution: { id: input.executionId } };
  const key = evaluateValue(input.declaration.key, scope);
  const reference = evaluateValue(input.declaration.reference, scope);
  if (typeof key !== 'string' || typeof reference !== 'string')
    throw new Error('Coordination identity invalid');
  const lease = await input.deps.operationCoordination.acquire({
    id: input.executionId,
    connectionId: input.declaration.connectionId,
    namespace: input.declaration.namespace,
    key,
    reference,
    executionBoundMs: input.executionBoundMs,
  });
  const stack = frames.get(input.host) ?? [];
  const frame = { lease, executionId: input.executionId, writeStarted: false };
  stack.push(frame);
  frames.set(input.host, stack);
  return {
    lease,
    didAdmitAction: () => frame.writeStarted,
    dispose() {
      if (stack.at(-1) === frame) stack.pop();
      if (stack.length === 0) frames.delete(input.host);
    },
  };
}
