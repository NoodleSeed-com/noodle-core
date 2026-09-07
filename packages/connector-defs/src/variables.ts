import type { ExprNode } from '@noodle-borg/compiler';

const VARIABLE_EXPR_RE = /^\$\{env\.([A-Za-z0-9_]+)\}$/;
const VARIABLE_REF_RE = /\$\{env\.([A-Za-z0-9_]+)\}/g;

export function isVariableExpression(value: string): boolean {
  return VARIABLE_EXPR_RE.test(value);
}

export function collectVariableExpression(value: string, out: Set<string>): void {
  const match = VARIABLE_EXPR_RE.exec(value);
  if (match?.[1] !== undefined) out.add(match[1]);
}

export function collectVariableReferences(value: string, out: Set<string>): void {
  for (const match of value.matchAll(VARIABLE_REF_RE)) {
    if (match[1] !== undefined) out.add(match[1]);
  }
}

export function collectVariablesFromExprMap(map: Record<string, ExprNode>, out: Set<string>): void {
  for (const node of Object.values(map)) collectVariablesFromExpr(node, out);
}

export function collectVariablesFromExpr(node: ExprNode, out: Set<string>): void {
  if (node.kind === 'path') {
    if (node.root === 'env') {
      const first = node.segments[0];
      if (first?.kind === 'prop') out.add(first.name);
    }
    return;
  }
  if (node.kind === 'template') {
    for (const part of node.parts) {
      if (part.kind !== 'text') collectVariablesFromExpr(part, out);
    }
    return;
  }
  if (node.kind === 'array') {
    for (const item of node.items) collectVariablesFromExpr(item, out);
    return;
  }
  if (node.kind === 'object') {
    for (const entry of node.entries) collectVariablesFromExpr(entry.value, out);
    return;
  }
  if (node.kind === 'coalesce') {
    collectVariablesFromExpr(node.left, out);
    collectVariablesFromExpr(node.right, out);
    return;
  }
  if (node.kind === 'function') {
    for (const arg of node.args) collectVariablesFromExpr(arg, out);
  }
}
