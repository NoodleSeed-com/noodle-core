import type { OperationSignature, ResolvedOperationRef } from '@noodle-borg/compiler';
import type { DownstreamCredential } from '../broker/types.js';
import type { Connector, ConnectorCall, ConnectorRegistry } from './types.js';

/** A handler runs one operation: pure data in, data out. It receives the broker credential. */
export type OperationHandler = (
  args: Readonly<Record<string, unknown>>,
  credential: DownstreamCredential,
) => Promise<unknown> | unknown;

/** An in-memory operation: its signature plus the function that fulfils it. */
export interface InMemoryOperation {
  readonly signature: OperationSignature;
  readonly handler: OperationHandler;
}

/**
 * A connector whose operations are plain in-process functions. Used for tests and for the first
 * execution-plane slice; no network egress. The `http`/`custom` kinds arrive in later slices.
 */
export class InMemoryConnector implements Connector {
  readonly id: string;
  readonly version: string;
  readonly #operations: Readonly<Record<string, InMemoryOperation>>;

  constructor(id: string, version: string, operations: Record<string, InMemoryOperation>) {
    this.id = id;
    this.version = version;
    this.#operations = operations;
  }

  signature(operation: string): OperationSignature | undefined {
    return this.#operations[operation]?.signature;
  }

  async invoke(call: ConnectorCall): Promise<unknown> {
    const op = this.#operations[call.operation];
    if (!op) throw new Error(`connector "${this.id}" has no operation "${call.operation}"`);
    return op.handler(call.args, call.credential);
  }
}

/** A registry backed by a fixed set of connectors, keyed by `id@version`. */
export class InMemoryConnectorRegistry implements ConnectorRegistry {
  readonly #byKey: Map<string, Connector>;

  constructor(connectors: readonly Connector[]) {
    this.#byKey = new Map(connectors.map((c) => [key(c.id, c.version), c]));
  }

  resolve(ref: ResolvedOperationRef): Connector | undefined {
    return this.#byKey.get(key(ref.connectorId, ref.connectorVersion));
  }
}

function key(id: string, version: string): string {
  return `${id}@${version}`;
}
