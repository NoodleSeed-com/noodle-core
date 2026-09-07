import type { ExprMap, JsonSchema } from './artifact/types.js';
import { normalizeElicitationSchema } from './elicitation-schema.js';
import type { CompileError } from './errors.js';
import {
  type CondNode,
  collectPaths,
  type ExprNode,
  parseCondition,
  parseValue,
} from './manifest/expression.js';
import { parseOperationRef } from './manifest/naming.js';
import type { Manifest } from './manifest/schema.js';

/** A connector-operation occurrence (single-op fulfilment, or one operation step) to resolve. */
export interface StructOp {
  readonly connectorAlias: string;
  readonly operation: string;
  readonly args: ExprMap;
  /** Path prefix of the fulfilment/step (e.g. `tools.0.fulfilment` or `…fulfilment.steps.1`). */
  readonly path: string;
}

/**
 * A structurally-validated flow step with parsed expressions; connector refs resolve later. The Core v1
 * verb set is `operation` + `map` + portable `elicit`; `compute` remains reserved (ADR 0150).
 */
type StructStep =
  | {
      readonly id: string;
      readonly kind: 'operation';
      readonly cond?: CondNode;
      readonly op: StructOp;
    }
  | {
      readonly id: string;
      readonly kind: 'map';
      readonly cond?: CondNode;
      readonly value: ExprMap;
    }
  | {
      readonly id: string;
      readonly kind: 'elicit';
      readonly cond?: CondNode;
      readonly message: string;
      readonly requestedSchema: JsonSchema;
    };

/** A structurally-validated fulfilment with parsed expressions; connector refs resolve later. */
export type StructFulfilment =
  | { readonly kind: 'operation'; readonly op: StructOp }
  | { readonly kind: 'flow'; readonly steps: readonly StructStep[]; readonly output: ExprMap };

/** Context for validating `${steps.<id>}` references against declared step order. */
interface RefCtx {
  readonly stepIndexById: ReadonlyMap<string, number>;
  /** Index of the step the expression lives in, or `null` for `output` (any step is in scope). */
  readonly currentIdx: number | null;
}

const NO_STEPS: RefCtx = { stepIndexById: new Map(), currentIdx: null };

// ─── Fulfilment parsing (structural, catalog-independent) ──────────────────────

type RawFulfilment = Manifest['tools'][number]['fulfilment'];
type RawStep = NonNullable<RawFulfilment['steps']>[number];

/**
 * Parse a fulfilment into a {@link StructFulfilment} with all `${...}` expressions resolved to AST and
 * all step references validated. `prefix` is the dotted path of the fulfilment (e.g.
 * `tools.0.fulfilment`). A steps-less flow (pure `output`, no connector call) is valid — a static
 * resource/prompt or a pure-computation tool — but a flow still needs an `output`. Returns `null` (after
 * recording an error) when the fulfilment is structurally invalid.
 */
export function parseFulfilment(
  raw: RawFulfilment,
  prefix: string,
  errors: CompileError[],
): StructFulfilment | null {
  const hasUse = raw.use !== undefined;
  const hasSteps = raw.steps !== undefined;

  if (hasUse === hasSteps) {
    errors.push({
      code: 'invalid_fulfilment',
      path: prefix,
      message: 'fulfilment must have exactly one of "use" (single operation) or "steps" (flow)',
    });
    return null;
  }

  if (hasUse) {
    if (raw.output !== undefined) {
      errors.push({
        code: 'invalid_fulfilment',
        path: `${prefix}.output`,
        message: '"output" is only valid in a flow ("steps")',
      });
    }
    const op = parseOp(raw.use as string, raw.args, prefix, NO_STEPS, errors);
    return op ? { kind: 'operation', op } : null;
  }

  // Flow.
  const steps = raw.steps as RawStep[];
  if (raw.args !== undefined) {
    errors.push({
      code: 'invalid_fulfilment',
      path: `${prefix}.args`,
      message: '"args" is only valid on a single operation or a step, not on a flow',
    });
  }
  if (raw.output === undefined) {
    errors.push({
      code: 'invalid_fulfilment',
      path: `${prefix}.output`,
      message: 'a flow needs an "output" mapping',
    });
  }

  // First pass: step ids + duplicate detection.
  const stepIndexById = new Map<string, number>();
  steps.forEach((step, m) => {
    if (stepIndexById.has(step.id)) {
      errors.push({
        code: 'duplicate_step_id',
        path: `${prefix}.steps.${m}.id`,
        message: `duplicate step id "${step.id}"`,
      });
    } else {
      stepIndexById.set(step.id, m);
    }
  });

  // Second pass: parse each step with reference checks against earlier steps.
  const structSteps: StructStep[] = [];
  steps.forEach((step, m) => {
    const parsed = parseStep(
      step,
      `${prefix}.steps.${m}`,
      { stepIndexById, currentIdx: m },
      errors,
    );
    if (parsed) structSteps.push(parsed);
  });

  // Output mapping runs after all steps, so any declared step is in scope.
  const output = parseExprMap(
    raw.output,
    `${prefix}.output`,
    { stepIndexById, currentIdx: null },
    errors,
  );

  return { kind: 'flow', steps: structSteps, output };
}

/** Parse a single operation occurrence: its operation reference and its parsed argument expressions. */
function parseOp(
  use: string,
  rawArgs: Record<string, unknown> | undefined,
  path: string,
  ctx: RefCtx,
  errors: CompileError[],
): StructOp | null {
  const ref = parseOperationRef(use);
  if (!ref) {
    errors.push({
      code: 'invalid_operation_ref',
      path: `${path}.use`,
      message: `invalid operation reference "${use}"; expected <connector>.<operation>`,
    });
    return null;
  }
  const args = parseExprMap(rawArgs, `${path}.args`, ctx, errors);
  return { connectorAlias: ref.connector, operation: ref.operation, args, path };
}

/** Parse a flow step, enforcing exactly one verb (`use`/`map`/`elicit`) and parsing its data. */
function parseStep(
  step: RawStep,
  path: string,
  ctx: RefCtx,
  errors: CompileError[],
): StructStep | null {
  const verbs = [step.use !== undefined, step.map !== undefined, step.elicit !== undefined].filter(
    Boolean,
  ).length;
  if (verbs !== 1) {
    errors.push({
      code: 'invalid_fulfilment',
      path,
      message: 'a step must have exactly one of "use", "map", or "elicit"',
    });
    return null;
  }
  if (step.args !== undefined && step.use === undefined) {
    errors.push({
      code: 'invalid_fulfilment',
      path: `${path}.args`,
      message: '"args" is only valid on an operation ("use") step',
    });
  }

  let cond: CondNode | undefined;
  if (step.if !== undefined) {
    const parsed = parseCondition(step.if, `${path}.if`);
    errors.push(...parsed.errors);
    validateRefs(parsed.node, `${path}.if`, ctx, errors);
    cond = parsed.node;
  }

  if (step.use !== undefined) {
    const op = parseOp(step.use, step.args, path, ctx, errors);
    if (!op) return null;
    return { id: step.id, kind: 'operation', ...(cond ? { cond } : {}), op };
  }
  if (step.elicit !== undefined) {
    const requestedSchema = normalizeElicitationSchema(
      step.elicit.requestedSchema,
      `${path}.elicit.requestedSchema`,
      errors,
    );
    if (!requestedSchema) return null;
    return {
      id: step.id,
      kind: 'elicit',
      ...(cond ? { cond } : {}),
      message: step.elicit.message,
      requestedSchema,
    };
  }
  const value = parseExprMap(step.map, `${path}.map`, ctx, errors);
  return { id: step.id, kind: 'map', ...(cond ? { cond } : {}), value };
}

/** Parse an `args`/`map`/`output` map of raw values into expression nodes and validate step refs. */
function parseExprMap(
  raw: Record<string, unknown> | undefined,
  pathPrefix: string,
  ctx: RefCtx,
  errors: CompileError[],
): ExprMap {
  const out: Record<string, ExprNode> = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    const path = `${pathPrefix}.${key}`;
    const { node, errors: e } = parseValue(value, path);
    errors.push(...e);
    validateRefs(node, path, ctx, errors);
    out[key] = node;
  }
  return out;
}

/** Validate every `${steps.<id>}` reference in a node against declared step order. */
function validateRefs(
  node: ExprNode | CondNode,
  path: string,
  ctx: RefCtx,
  errors: CompileError[],
): void {
  for (const p of collectPaths(node)) {
    if (p.root !== 'steps') continue;
    const first = p.segments[0];
    if (first?.kind !== 'prop') {
      errors.push({
        code: 'unknown_step_ref',
        path,
        message: 'a "steps" reference must name a step (`${steps.<id>...}`)',
      });
      continue;
    }
    const id = first.name;
    const idx = ctx.stepIndexById.get(id);
    if (idx === undefined) {
      errors.push({ code: 'unknown_step_ref', path, message: `unknown step "${id}"` });
    } else if (ctx.currentIdx !== null) {
      if (idx === ctx.currentIdx) {
        errors.push({ code: 'self_step_ref', path, message: `step "${id}" references itself` });
      } else if (idx > ctx.currentIdx) {
        errors.push({
          code: 'forward_step_ref',
          path,
          message: `step "${id}" is referenced before it runs`,
        });
      }
    }
  }
}

/**
 * Recursively scan an authored JSON Schema for an external `$ref` (any `$ref` that is not a local
 * `#`-fragment). External refs are rejected per docs/SPEC.md "Schemas". Returns the first one found.
 */
export function findExternalRef(value: unknown, path: string): CompileError | null {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = findExternalRef(value[i], `${path}.${i}`);
      if (found) return found;
    }
    return null;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, val] of Object.entries(value)) {
      if (key === '$ref' && typeof val === 'string' && !val.startsWith('#')) {
        return {
          code: 'external_ref',
          path: `${path}.$ref`,
          message: `external $ref "${val}" is not allowed; use $use or a local "#/" reference`,
        };
      }
      const found = findExternalRef(val, `${path}.${key}`);
      if (found) return found;
    }
  }
  return null;
}
