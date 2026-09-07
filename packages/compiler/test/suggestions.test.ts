import { describe, expect, it } from 'vitest';
import { compile } from '../src/compile.js';
import type { CompileError, CompileErrorCode } from '../src/errors.js';
import { testCatalog } from './catalog.js';

/** Compile an (expected-invalid) manifest against the shared test catalog and return its errors. */
function errorsOf(manifest: string): readonly CompileError[] {
  const result = compile(manifest, { catalog: testCatalog });
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.errors;
}

function findError(errors: readonly CompileError[], code: CompileErrorCode): CompileError {
  const found = errors.find((e) => e.code === code);
  if (!found) {
    throw new Error(`expected a ${code} error, got: [${errors.map((e) => e.code).join(', ')}]`);
  }
  return found;
}

const header = `manifestVersion: "1"
server:
  name: acme_support
  version: 1.0.0
  title: Acme Support
`;

describe('GT-1: generation-friendly resolution errors', () => {
  it('unknown_operation typo -> didYouMean the real operation, with got + docAnchor', () => {
    const manifest = `${header}connectors:
  acme:
    id: acme_orders
    version: 1.2.0
tools:
  - name: get_order
    description: Look up an order.
    inputSchema:
      type: object
    fulfilment:
      use: acme.get_ordr
`;
    const error = findError(errorsOf(manifest), 'unknown_operation');
    expect(error.path).toBe('tools.0.fulfilment.use');
    expect(error.got).toBe('get_ordr');
    expect(error.didYouMean).toBe('get_order');
    expect(error.suggestions).toContain('get_order');
    expect(error.docAnchor).toBe('compile-errors#unknown-operation');
  });

  it('unknown_connector_alias typo -> didYouMean the declared alias', () => {
    const manifest = `${header}connectors:
  acme:
    id: acme_orders
    version: 1.2.0
tools:
  - name: get_order
    description: Look up an order.
    inputSchema:
      type: object
    fulfilment:
      use: acm.get_order
`;
    const error = findError(errorsOf(manifest), 'unknown_connector_alias');
    expect(error.got).toBe('acm');
    expect(error.didYouMean).toBe('acme');
    expect(error.docAnchor).toBe('compile-errors#unknown-connector-alias');
  });

  it('unknown_schema_ref typo -> didYouMean the declared schema name', () => {
    const manifest = `${header}schemas:
  address:
    type: object
connectors:
  acme:
    id: acme_orders
    version: 1.2.0
tools:
  - name: get_order
    description: Look up an order.
    inputSchema:
      type: object
      properties:
        x:
          $use: addres
    fulfilment:
      use: acme.get_order
      args:
        id: \${input.x}
`;
    const error = findError(errorsOf(manifest), 'unknown_schema_ref');
    expect(error.got).toBe('addres');
    expect(error.didYouMean).toBe('address');
    expect(error.docAnchor).toBe('compile-errors#unknown-schema-ref');
  });

  it('connector_not_in_catalog -> expected/got + docAnchor, but NO didYouMean (catalog cannot enumerate)', () => {
    const manifest = `${header}connectors:
  acme:
    id: acme_orders
    version: 9.9.9
tools:
  - name: get_order
    description: Look up an order.
    inputSchema:
      type: object
    fulfilment:
      use: acme.get_order
`;
    const error = findError(errorsOf(manifest), 'connector_not_in_catalog');
    expect(error.got).toBe('acme_orders@9.9.9');
    expect(error.expected).toContain('acme_orders');
    expect(error.didYouMean).toBeUndefined();
    expect(error.docAnchor).toBe('compile-errors#connector-not-in-catalog');
  });

  it('a far-off operation name yields NO didYouMean (generators are not misled) but keeps the candidate set', () => {
    const manifest = `${header}connectors:
  acme:
    id: acme_orders
    version: 1.2.0
tools:
  - name: nuke
    description: Attempt an operation the connector does not expose.
    inputSchema:
      type: object
    fulfilment:
      use: acme.delete_everything
`;
    const error = findError(errorsOf(manifest), 'unknown_operation');
    expect(error.got).toBe('delete_everything');
    expect(error.didYouMean).toBeUndefined();
    expect(error.suggestions).toContain('get_order');
    // The base fields are always intact for existing consumers.
    expect(error.code).toBe('unknown_operation');
    expect(error.path).toBe('tools.0.fulfilment.use');
    expect(typeof error.message).toBe('string');
  });
});
