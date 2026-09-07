import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

export interface ProjectDotenv {
  readonly path: string;
  readonly values: Record<string, string>;
}

export class ProjectDotenvError extends Error {
  constructor(readonly line?: number) {
    super(
      line === undefined
        ? 'invalid .env syntax (value redacted)'
        : `invalid .env syntax at line ${line} (value redacted)`,
    );
    this.name = 'ProjectDotenvError';
  }
}

/**
 * Read the ordinary `.env` file at one exact project root. The parser follows Node's dotenv value
 * semantics, does not expand `$VARS`, and validates every non-comment record first so malformed input
 * cannot be silently skipped before a deploy import.
 */
export function readProjectDotenv(projectRoot: string): ProjectDotenv | undefined {
  const path = join(projectRoot, '.env');
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, 'utf8');
  validateDotenvSyntax(text);
  try {
    const parsed = parseEnv(text);
    const values = Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    return { path, values };
  } catch {
    throw invalidDotenvSyntax();
  }
}

function validateDotenvSyntax(text: string): void {
  let offset = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  while (offset < text.length) {
    while (isHorizontalSpace(text[offset])) offset++;
    if (isLineBreak(text[offset])) {
      ({ offset, line } = consumeLineBreak(text, offset, line));
      continue;
    }
    if (text[offset] === '#') {
      offset = skipComment(text, offset);
      continue;
    }

    const recordLine = line;
    if (text.startsWith('export', offset) && isHorizontalSpace(text[offset + 'export'.length])) {
      offset += 'export'.length;
      while (isHorizontalSpace(text[offset])) offset++;
    }
    if (!isKeyStart(text[offset])) throw invalidDotenvSyntax(recordLine);
    offset++;
    while (isKeyPart(text[offset])) offset++;
    while (isHorizontalSpace(text[offset])) offset++;
    if (text[offset] !== '=') throw invalidDotenvSyntax(recordLine);
    offset++;
    while (isHorizontalSpace(text[offset])) offset++;

    const quote = text[offset];
    if (quote === "'" || quote === '"' || quote === '`') {
      offset++;
      let closed = false;
      while (offset < text.length) {
        if (text[offset] === quote && !isEscaped(text, offset)) {
          closed = true;
          offset++;
          break;
        }
        if (isLineBreak(text[offset])) {
          ({ offset, line } = consumeLineBreak(text, offset, line));
        } else {
          offset++;
        }
      }
      if (!closed) throw invalidDotenvSyntax(recordLine);
      while (isHorizontalSpace(text[offset])) offset++;
      if (text[offset] === '#') offset = skipComment(text, offset);
      if (offset < text.length && !isLineBreak(text[offset])) {
        throw invalidDotenvSyntax(recordLine);
      }
    } else {
      while (offset < text.length && !isLineBreak(text[offset])) offset++;
    }
    if (isLineBreak(text[offset])) {
      ({ offset, line } = consumeLineBreak(text, offset, line));
    }
  }
}

function invalidDotenvSyntax(line?: number): Error {
  return new ProjectDotenvError(line);
}

function isHorizontalSpace(char: string | undefined): boolean {
  return char === ' ' || char === '\t';
}

function isLineBreak(char: string | undefined): boolean {
  return char === '\n' || char === '\r';
}

function isKeyStart(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z_]/u.test(char);
}

function isKeyPart(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_]/u.test(char);
}

function isEscaped(text: string, offset: number): boolean {
  let slashes = 0;
  for (let index = offset - 1; index >= 0 && text[index] === '\\'; index--) slashes++;
  return slashes % 2 === 1;
}

function skipComment(text: string, offset: number): number {
  while (offset < text.length && !isLineBreak(text[offset])) offset++;
  return offset;
}

function consumeLineBreak(
  text: string,
  offset: number,
  line: number,
): { offset: number; line: number } {
  const first = text[offset];
  offset++;
  if (first === '\r' && text[offset] === '\n') offset++;
  return { offset, line: line + 1 };
}
