import type { CompileError } from '../errors.js';
import { ExprError, exprErrorToCompileError } from './expr-error.js';

/**
 * Expression language: parse a manifest `${...}` expression into a serializable AST.
 *
 * The runtime evaluates the AST and never parses tenant strings (docs/SPEC.md "Runtime Artifact",
 * "Expression language"), so parsing happens here at compile time and the AST is emitted into the
 * runtime artifact. No `eval`/`Function`; a hand-written tokenizer + recursive-descent parser only.
 *
 * Two entry points:
 * - {@link parseValue}  — for `args`/`map`/`output` values. Produces a value node (path, literal, or
 *   string template). The value grammar has NO operators, so equality/boolean used outside an `if`
 *   surfaces as `expr_operator_not_allowed`.
 * - {@link parseCondition} — for a step's `if`. Produces a boolean condition node (equality + boolean
 *   only, per docs/SPEC.md "Equality and boolean checks only for `if` conditions").
 *
 * Allowed roots this phase: `input`, `steps`, `env`, `user`, `context`. `item` is recognized but rejected with
 * `expr_root_unavailable` (repeat/option-list expression contexts do not exist yet).
 */

/**
 * Roots an expression may read. Manifest expressions use `input`/`steps`; other contexts (e.g. connector
 * request/response mapping) pass their own allowed-roots set to {@link parseValue}/{@link parseCondition}.
 */
type ExprRoot = string;

/** Default roots for manifest `args`/`map`/`output`/`if` expressions. */
const ALLOWED_ROOTS = new Set<string>(['input', 'steps', 'env', 'user', 'context']);
/** Recognized but not available this phase (forward-compatible rejection). */
const DEFERRED_ROOTS = new Set<string>(['item']);

/** Guard against pathological nesting (docs/SPEC.md "bounded depth"). */
const MAX_DEPTH = 32;
const MAX_TEMPLATE_PARTS = 64;
const MAX_STRING_LENGTH = 16_384;

interface PathSegmentProp {
  readonly kind: 'prop';
  readonly name: string;
}
interface PathSegmentIndex {
  readonly kind: 'index';
  readonly value: number;
}
export type PathSegment = PathSegmentProp | PathSegmentIndex;

/** A data reference: a root plus ordered property/index segments (e.g. `steps.search.items[0].id`). */
export interface PathNode {
  readonly kind: 'path';
  readonly root: ExprRoot;
  readonly segments: readonly PathSegment[];
}

/** A literal value (boolean/number/string/null), type-preserving at runtime. */
interface LiteralNode {
  readonly kind: 'literal';
  readonly value: string | number | boolean | null;
}

type TemplatePartText = { readonly kind: 'text'; readonly value: string };
type TemplatePart = TemplatePartText | PathNode | LiteralNode;

/** String interpolation; always produces a string at runtime (docs/SPEC.md "Evaluation Rules"). */
interface TemplateNode {
  readonly kind: 'template';
  readonly parts: readonly TemplatePart[];
}

/** A literal array whose elements are themselves value expressions (e.g. a request body's list field). */
export interface ArrayNode {
  readonly kind: 'array';
  readonly items: readonly ExprNode[];
}

/** One key of an {@link ObjectNode}; the value is itself a value expression. */
export interface ObjectEntry {
  readonly key: string;
  readonly value: ExprNode;
}

/** A literal object whose field values are value expressions (e.g. a nested JSON request body). */
export interface ObjectNode {
  readonly kind: 'object';
  readonly entries: readonly ObjectEntry[];
}

/**
 * A null-coalescing fallback: evaluate `left`, and only if it resolves to `null`/`undefined` use `right`
 * (the design's "explicit fallback"). Written `${args.model ?? "sonar"}`; chains left-associatively.
 */
export interface CoalesceNode {
  readonly kind: 'coalesce';
  readonly left: ExprNode;
  readonly right: ExprNode;
}

const FUNCTION_NAMES = [
  'coalesce',
  'equals',
  'lower',
  'upper',
  'formatCurrency',
  'formatNumber',
  'formatDateTime',
  'formatRelativeTime',
  'formatUnit',
  'formatPlural',
  'urlEncode',
] as const;
type FunctionName = (typeof FUNCTION_NAMES)[number];

interface FunctionNode {
  readonly kind: 'function';
  readonly name: FunctionName;
  readonly args: readonly ExprNode[];
}

/** A value-position expression node (the result of {@link parseValue}). */
export type ExprNode =
  | PathNode
  | LiteralNode
  | TemplateNode
  | ArrayNode
  | ObjectNode
  | CoalesceNode
  | FunctionNode;

/** Operand of an equality comparison: a path or a literal. */
type Comparable = PathNode | LiteralNode;

interface CompareNode {
  readonly kind: 'cond';
  readonly op: 'eq' | 'neq';
  readonly left: Comparable;
  readonly right: Comparable;
}
interface LogicalNode {
  readonly kind: 'cond';
  readonly op: 'and' | 'or';
  readonly left: CondNode;
  readonly right: CondNode;
}
interface NotNode {
  readonly kind: 'cond';
  readonly op: 'not';
  readonly operand: CondNode;
}
/** Truthiness of a path used as a bare `if` condition (e.g. `${input.is_active}`). */
interface TruthyNode {
  readonly kind: 'truthy';
  readonly operand: PathNode;
}

/** A condition-position node (the result of {@link parseCondition}). */
export type CondNode = CompareNode | LogicalNode | NotNode | TruthyNode;

const FALLBACK_VALUE: ExprNode = { kind: 'literal', value: null };
const FALLBACK_COND: CondNode = {
  kind: 'truthy',
  operand: { kind: 'path', root: 'input', segments: [] },
};

// ─── Tokenizer ──────────────────────────────────────────────────────────────

type TokenType =
  | 'ident'
  | 'number'
  | 'string'
  | 'true'
  | 'false'
  | 'null'
  | 'dot'
  | 'lbracket'
  | 'rbracket'
  | 'lparen'
  | 'rparen'
  | 'comma'
  | 'eq'
  | 'neq'
  | 'and'
  | 'or'
  | 'not'
  | 'coalesce'
  | 'eof';

interface Token {
  readonly type: TokenType;
  readonly value: string;
}

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;
const FUNCTION_NAME_SET = new Set<string>(FUNCTION_NAMES);

/** Tokenize the inner text of a `${...}` expression. Throws {@link ExprError} on a bad token. */
function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (c === '.') {
      tokens.push({ type: 'dot', value: '.' });
      i++;
    } else if (c === '[') {
      tokens.push({ type: 'lbracket', value: '[' });
      i++;
    } else if (c === ']') {
      tokens.push({ type: 'rbracket', value: ']' });
      i++;
    } else if (c === '(') {
      tokens.push({ type: 'lparen', value: '(' });
      i++;
    } else if (c === ')') {
      tokens.push({ type: 'rparen', value: ')' });
      i++;
    } else if (c === ',') {
      tokens.push({ type: 'comma', value: ',' });
      i++;
    } else if (c === '=') {
      if (src.startsWith('===', i)) {
        tokens.push({ type: 'eq', value: '===' });
        i += 3;
      } else {
        throw new ExprError('invalid_expression', "use '===' for equality");
      }
    } else if (c === '!') {
      if (src.startsWith('!==', i)) {
        tokens.push({ type: 'neq', value: '!==' });
        i += 3;
      } else {
        tokens.push({ type: 'not', value: '!' });
        i++;
      }
    } else if (c === '&') {
      if (src.startsWith('&&', i)) {
        tokens.push({ type: 'and', value: '&&' });
        i += 2;
      } else {
        throw new ExprError('invalid_expression', "use '&&' for logical and");
      }
    } else if (c === '|') {
      if (src.startsWith('||', i)) {
        tokens.push({ type: 'or', value: '||' });
        i += 2;
      } else {
        throw new ExprError('invalid_expression', "use '||' for logical or");
      }
    } else if (c === '?') {
      if (src.startsWith('??', i)) {
        tokens.push({ type: 'coalesce', value: '??' });
        i += 2;
      } else {
        throw new ExprError('invalid_expression', "use '??' for a fallback value");
      }
    } else if (c === '"' || c === "'") {
      const quote = c;
      let str = '';
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < src.length) {
          str += src[i + 1];
          i += 2;
        } else {
          str += src[i];
          i++;
        }
      }
      if (i >= src.length) throw new ExprError('invalid_expression', 'unterminated string literal');
      i++; // closing quote
      tokens.push({ type: 'string', value: str });
    } else if (DIGIT.test(c) || (c === '-' && DIGIT.test(src[i + 1] ?? ''))) {
      let num = c;
      i++;
      while (i < src.length && DIGIT.test(src[i] as string)) {
        num += src[i];
        i++;
      }
      if (src[i] === '.') {
        num += '.';
        i++;
        if (!DIGIT.test(src[i] ?? '')) {
          throw new ExprError('invalid_expression', 'malformed number');
        }
        while (i < src.length && DIGIT.test(src[i] as string)) {
          num += src[i];
          i++;
        }
      }
      tokens.push({ type: 'number', value: num });
    } else if (IDENT_START.test(c)) {
      let id = c;
      i++;
      while (i < src.length && IDENT_PART.test(src[i] as string)) {
        id += src[i];
        i++;
      }
      if (id === 'true') tokens.push({ type: 'true', value: id });
      else if (id === 'false') tokens.push({ type: 'false', value: id });
      else if (id === 'null') tokens.push({ type: 'null', value: id });
      else tokens.push({ type: 'ident', value: id });
    } else {
      throw new ExprError('invalid_expression', `unexpected character '${c}'`);
    }
  }
  tokens.push({ type: 'eof', value: '' });
  return tokens;
}

// ─── Parser ─────────────────────────────────────────────────────────────────

class Parser {
  private pos = 0;
  constructor(
    private readonly tokens: Token[],
    private readonly allowedRoots: ReadonlySet<string> = ALLOWED_ROOTS,
  ) {}

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }
  private next(): Token {
    return this.tokens[this.pos++] as Token;
  }
  private expect(type: TokenType): Token {
    const t = this.peek();
    if (t.type !== type) throw new ExprError('invalid_expression', `expected ${type}`);
    return this.next();
  }
  private peekNext(): Token {
    return this.tokens[this.pos + 1] ?? ({ type: 'eof', value: '' } as Token);
  }

  /** Reject an operator token that appears in value mode. */
  private guardNoOperator(t: Token): void {
    if (
      t.type === 'eq' ||
      t.type === 'neq' ||
      t.type === 'and' ||
      t.type === 'or' ||
      t.type === 'not'
    ) {
      throw new ExprError(
        'expr_operator_not_allowed',
        `operator '${t.value}' is only allowed in an 'if' condition`,
        { got: t.value },
      );
    }
  }

  private literal(): LiteralNode {
    const t = this.next();
    switch (t.type) {
      case 'string':
        return { kind: 'literal', value: t.value };
      case 'number':
        return { kind: 'literal', value: Number(t.value) };
      case 'true':
        return { kind: 'literal', value: true };
      case 'false':
        return { kind: 'literal', value: false };
      case 'null':
        return { kind: 'literal', value: null };
      default:
        throw new ExprError('invalid_expression', `unexpected token '${t.value || t.type}'`);
    }
  }

  private path(): PathNode {
    const rootTok = this.expect('ident');
    const root = rootTok.value;
    if (DEFERRED_ROOTS.has(root)) {
      throw new ExprError(
        'expr_root_unavailable',
        `root '${root}' is recognized but not available in this phase`,
        { got: root, expected: [...this.allowedRoots].join(', ') },
      );
    }
    if (!this.allowedRoots.has(root)) {
      throw new ExprError('expr_unknown_root', `unknown expression root '${root}'`, {
        got: root,
        expected: [...this.allowedRoots].join(', '),
      });
    }
    const segments: PathSegment[] = [];
    for (;;) {
      const t = this.peek();
      if (t.type === 'dot') {
        this.next();
        const name = this.expect('ident');
        segments.push({ kind: 'prop', name: name.value });
      } else if (t.type === 'lbracket') {
        this.next();
        const num = this.expect('number');
        if (!/^[0-9]+$/.test(num.value)) {
          throw new ExprError('invalid_expression', `array index must be a non-negative integer`);
        }
        this.expect('rbracket');
        segments.push({ kind: 'index', value: Number(num.value) });
      } else {
        break;
      }
    }
    if (segments.length > MAX_DEPTH) {
      throw new ExprError('invalid_expression', 'expression path is too deep');
    }
    return { kind: 'path', root: root as ExprRoot, segments };
  }

  private functionCall(): FunctionNode {
    const name = this.expect('ident').value;
    if (!isFunctionName(name)) {
      throw new ExprError('invalid_expression', `function '${name}' is not allowed`);
    }
    this.expect('lparen');
    const args: ExprNode[] = [];
    if (this.peek().type !== 'rparen') {
      for (;;) {
        args.push(this.valueExpr(new Set<TokenType>(['comma', 'rparen'])));
        if (this.peek().type === 'comma') {
          this.next();
          continue;
        }
        break;
      }
    }
    this.expect('rparen');
    return { kind: 'function', name, args };
  }

  /** A primary value operand: a path or a single literal (no operators). */
  private primary(): ExprNode {
    const t = this.peek();
    this.guardNoOperator(t);
    if (t.type === 'ident' && this.peekNext().type === 'lparen') return this.functionCall();
    return t.type === 'ident' ? this.path() : this.literal();
  }

  private valueExpr(stop: ReadonlySet<TokenType>): ExprNode {
    let node = this.primary();
    while (this.peek().type === 'coalesce') {
      this.next();
      node = { kind: 'coalesce', left: node, right: this.primary() };
    }
    const trailing = this.peek();
    if (!stop.has(trailing.type)) {
      this.guardNoOperator(trailing);
      throw new ExprError('invalid_expression', `unexpected token '${trailing.value}'`);
    }
    return node;
  }

  /**
   * A value expression: a primary, optionally followed by one or more `??` fallbacks
   * (left-associative). Comparison/boolean operators remain rejected here — they belong to `if` only.
   */
  parseValue(): ExprNode {
    return this.valueExpr(new Set<TokenType>(['eof']));
  }

  /** A comparable operand for an equality comparison: a path or a literal. */
  private comparable(): Comparable {
    const t = this.peek();
    return t.type === 'ident' ? this.path() : this.literal();
  }

  private condOr(depth: number): CondNode {
    let left = this.condAnd(depth);
    while (this.peek().type === 'or') {
      this.next();
      const right = this.condAnd(depth);
      left = { kind: 'cond', op: 'or', left, right };
    }
    return left;
  }
  private condAnd(depth: number): CondNode {
    let left = this.condUnary(depth);
    while (this.peek().type === 'and') {
      this.next();
      const right = this.condUnary(depth);
      left = { kind: 'cond', op: 'and', left, right };
    }
    return left;
  }
  private condUnary(depth: number): CondNode {
    if (depth > MAX_DEPTH)
      throw new ExprError('invalid_expression', 'expression nested too deeply');
    if (this.peek().type === 'not') {
      this.next();
      return { kind: 'cond', op: 'not', operand: this.condUnary(depth + 1) };
    }
    if (this.peek().type === 'lparen') {
      this.next();
      const inner = this.condOr(depth + 1);
      this.expect('rparen');
      return inner;
    }
    const left = this.comparable();
    const t = this.peek();
    if (t.type === 'eq' || t.type === 'neq') {
      this.next();
      const right = this.comparable();
      return { kind: 'cond', op: t.type, left, right };
    }
    // No operator: a bare path is truthiness; a bare literal is not a boolean condition.
    if (left.kind === 'path') return { kind: 'truthy', operand: left };
    throw new ExprError(
      'expr_if_not_boolean',
      'an `if` condition must be a boolean expression, not a bare literal',
    );
  }

  parseCondition(): CondNode {
    const node = this.condOr(0);
    if (this.peek().type !== 'eof') {
      throw new ExprError('invalid_expression', `unexpected token '${this.peek().value}'`);
    }
    return node;
  }
}

// ─── `${...}` scanning + templates ────────────────────────────────────────────

/**
 * Find the end of a `${...}` starting at `start` (the index of `$`). Returns the inner text and the
 * index just past the closing `}`. Brace scanning is quote-aware so `}` inside a string literal does
 * not close the expression. Throws {@link ExprError} if unterminated.
 */
function scanExpr(text: string, start: number): { inner: string; end: number } {
  let i = start + 2; // skip `${`
  let quote: string | null = null;
  let inner = '';
  while (i < text.length) {
    const c = text[i] as string;
    if (quote) {
      inner += c;
      if (c === '\\' && i + 1 < text.length) {
        inner += text[i + 1];
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
    } else if (c === '"' || c === "'") {
      quote = c;
      inner += c;
      i++;
    } else if (c === '}') {
      return { inner, end: i + 1 };
    } else {
      inner += c;
      i++;
    }
  }
  throw new ExprError('invalid_expression', "unterminated '${' expression");
}

/** Parse the inner text of a `${...}` as a value expression. */
function parseInnerValue(inner: string, allowedRoots: ReadonlySet<string>): ExprNode {
  if (inner.trim() === '') throw new ExprError('invalid_expression', 'empty `${}` expression');
  return new Parser(tokenize(inner), allowedRoots).parseValue();
}

/**
 * Split a raw string into literal-text and `${...}` parts. `$${` is an escaped literal `${`.
 * Returns the ordered parts; callers classify (whole-field vs template vs plain literal).
 */
function splitTemplate(raw: string, allowedRoots: ReadonlySet<string>): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let text = '';
  let i = 0;
  while (i < raw.length) {
    if (raw.startsWith('$${', i)) {
      text += '${';
      i += 3;
    } else if (raw.startsWith('${', i)) {
      const { inner, end } = scanExpr(raw, i);
      if (text) {
        parts.push({ kind: 'text', value: text });
        text = '';
      }
      const node = parseInnerValue(inner, allowedRoots);
      // A nested template cannot occur (inner is a single expression), so node is path|literal.
      parts.push(node as PathNode | LiteralNode);
      i = end;
    } else {
      text += raw[i];
      i++;
    }
  }
  if (text) parts.push({ kind: 'text', value: text });
  return parts;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface ParseValueResult {
  readonly node: ExprNode;
  readonly errors: CompileError[];
}

export interface ParseConditionResult {
  readonly node: CondNode;
  readonly errors: CompileError[];
}

/**
 * Parse an `args`/`map`/`output` value. Classifies the raw value:
 * - non-string scalar -> `literal` (type preserved)
 * - string with no `${` -> `literal` string (with `$${`->`${` unescaping)
 * - string that is exactly one whole `${...}` -> the inner path/literal (type-preserving)
 * - string mixing `${...}` with text or multiple expressions -> `template` (string result)
 * - array -> `array` node whose items are parsed recursively
 * - plain object -> `object` node whose values are parsed recursively
 *
 * Nesting is bounded by `MAX_DEPTH` so a structured value (e.g. a JSON request body with a `messages`
 * list) can be expressed declaratively while staying within the bounded-evaluation guarantees
 * (docs/SPEC.md "Expression language").
 */
export function parseValue(
  raw: unknown,
  path: string,
  allowedRoots: ReadonlySet<string> = ALLOWED_ROOTS,
): ParseValueResult {
  const errors: CompileError[] = [];
  const node = parseValueNode(raw, path, allowedRoots, 0, errors);
  return { node, errors };
}

/**
 * Recursive worker for {@link parseValue}. Child errors are accumulated into `errors`; a failing node
 * falls back to a null literal (the caller fails the compile when `errors` is non-empty, so the fallback
 * is never evaluated).
 */
function parseValueNode(
  raw: unknown,
  path: string,
  allowedRoots: ReadonlySet<string>,
  depth: number,
  errors: CompileError[],
): ExprNode {
  try {
    if (depth > MAX_DEPTH) {
      throw new ExprError('invalid_expression', 'mapping value is nested too deeply');
    }
    if (Array.isArray(raw)) {
      const items = raw.map((el, i) =>
        parseValueNode(el, `${path}[${i}]`, allowedRoots, depth + 1, errors),
      );
      return { kind: 'array', items };
    }
    if (typeof raw !== 'string') {
      if (raw === null || typeof raw === 'boolean' || typeof raw === 'number') {
        return { kind: 'literal', value: raw };
      }
      if (typeof raw === 'object') {
        const entries: ObjectEntry[] = Object.entries(raw as Record<string, unknown>).map(
          ([key, value]) => ({
            key,
            value: parseValueNode(value, `${path}.${key}`, allowedRoots, depth + 1, errors),
          }),
        );
        return { kind: 'object', entries };
      }
      throw new ExprError('invalid_expression', 'unsupported mapping value');
    }
    if (raw.length > MAX_STRING_LENGTH) {
      throw new ExprError('invalid_expression', 'expression string is too large');
    }
    if (!raw.includes('${')) {
      // Plain string literal (still honor `$${` escaping to a literal `${`).
      return { kind: 'literal', value: raw.replace(/\$\$\{/g, '${') };
    }
    const parts = splitTemplate(raw, allowedRoots);
    if (parts.length > MAX_TEMPLATE_PARTS) {
      throw new ExprError('invalid_expression', 'expression template has too many parts');
    }
    const exprParts = parts.filter((p) => p.kind !== 'text');
    if (exprParts.length === 0) {
      // Only literal text (e.g. produced entirely by `$${` escapes): a literal string.
      const text = parts.map((p) => (p as TemplatePartText).value).join('');
      return { kind: 'literal', value: text };
    }
    if (parts.length === 1) {
      // A single whole `${...}` with no surrounding text: type-preserving path or literal.
      return parts[0] as ExprNode;
    }
    return { kind: 'template', parts };
  } catch (err) {
    if (err instanceof ExprError) {
      errors.push(exprErrorToCompileError(err, path));
      return FALLBACK_VALUE;
    }
    throw err;
  }
}

/**
 * Parse a step `if` condition. The value must be a single whole `${...}` boolean expression: a bare
 * path is truthiness; equality/boolean operators are permitted here only. A plain string, a template,
 * or a bare literal is `expr_if_not_boolean`.
 */
export function parseCondition(
  raw: unknown,
  path: string,
  allowedRoots: ReadonlySet<string> = ALLOWED_ROOTS,
): ParseConditionResult {
  try {
    if (typeof raw !== 'string') {
      throw new ExprError(
        'expr_if_not_boolean',
        'an `if` condition must be a single `${...}` boolean expression',
      );
    }
    if (raw.length > MAX_STRING_LENGTH) {
      throw new ExprError('invalid_expression', 'expression string is too large');
    }
    if (!raw.startsWith('${') || !raw.endsWith('}')) {
      throw new ExprError(
        'expr_if_not_boolean',
        'an `if` condition must be a single `${...}` boolean expression',
      );
    }
    const { inner, end } = scanExpr(raw, 0);
    if (end !== raw.length) {
      // Trailing text after the first `${...}` -> not a single whole expression.
      throw new ExprError(
        'expr_if_not_boolean',
        'an `if` condition must be a single `${...}` boolean expression',
      );
    }
    if (inner.trim() === '') throw new ExprError('invalid_expression', 'empty `${}` expression');
    const node = new Parser(tokenize(inner), allowedRoots).parseCondition();
    return { node, errors: [] };
  } catch (err) {
    if (err instanceof ExprError) {
      return { node: FALLBACK_COND, errors: [exprErrorToCompileError(err, path)] };
    }
    throw err;
  }
}

/** Collect every {@link PathNode} reachable from a value or condition node (depth-first). */
export function collectPaths(node: ExprNode | CondNode): PathNode[] {
  const out: PathNode[] = [];
  const visit = (n: ExprNode | CondNode | TemplatePart | Comparable): void => {
    switch (n.kind) {
      case 'path':
        out.push(n);
        break;
      case 'template':
        for (const p of n.parts) visit(p);
        break;
      case 'array':
        for (const item of n.items) visit(item);
        break;
      case 'object':
        for (const entry of n.entries) visit(entry.value);
        break;
      case 'coalesce':
        visit(n.left);
        visit(n.right);
        break;
      case 'function':
        for (const arg of n.args) visit(arg);
        break;
      case 'cond':
        if (n.op === 'not') visit(n.operand);
        else {
          visit(n.left);
          visit(n.right);
        }
        break;
      case 'truthy':
        out.push(n.operand);
        break;
      // 'literal' and 'text' carry no paths.
    }
  };
  visit(node);
  return out;
}

function isFunctionName(value: string): value is FunctionName {
  return FUNCTION_NAME_SET.has(value);
}
