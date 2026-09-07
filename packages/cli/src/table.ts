/**
 * Branded, alignment-safe table renderer for the CLI's resource commands
 * (`apps`/`envs`/`deployments`/`orgs` list views).
 *
 * The core guarantee: columns never drift. Widths are computed from ANSI-stripped
 * content, capped per column, truncated with an ellipsis, and shrunk to fit the
 * terminal — so a single wide row (e.g. `financial-contact-center-6221745c`) can't
 * shove the rest of the table out of alignment the way naive space-padding does.
 *
 * Colour is a pure overlay: the warm Noodle gradient tints the box-drawing borders
 * and per-cell semantic colours tint cell text, but neither ever changes the visible
 * layout. The invariant `stripAnsi(colored) === plain` holds and is tested. Under
 * `color: 'none'` (pipes / CI / NO_COLOR / non-TTY) it emits plain, escape-free,
 * still-aligned ASCII; callers suppress it entirely under `--json`.
 *
 * The animated gradient sweep lives in the `--watch`/loading redraw path (status.ts),
 * not here — a one-shot printed table carries a static gradient.
 */
import { AMBER, type ColorMode, cyclic, type GlyphMode, paint, type RGB } from './gradient.js';

export interface Column<Row> {
  /** Column heading (also participates in width; may be truncated if narrower than `maxWidth`). */
  readonly header: string;
  /** Extract the raw (uncoloured) cell text for a row. */
  readonly get: (row: Row) => string;
  /** Horizontal alignment of the cell content within the column (default `left`). */
  readonly align?: 'left' | 'right';
  /** Hard cap on the column's content width; longer cells truncate with an ellipsis. */
  readonly maxWidth?: number;
  /** Optional per-row semantic colour for the cell text (e.g. active→green). */
  readonly color?: (row: Row) => RGB | undefined;
}

export interface TableOptions {
  /** Colour capability of the target stream (from `detectColorMode`). */
  readonly color: ColorMode;
  /** Glyph capability of the target terminal (from `detectGlyphMode`). */
  readonly glyph: GlyphMode;
  /** Total width budget (e.g. `process.stdout.columns`); columns shrink to fit when set. */
  readonly maxTableWidth?: number;
  /** Tint the borders with the warm gradient (default `true`; inert under `color: 'none'`). */
  readonly gradient?: boolean;
  /** Tint every border glyph one flat colour instead of the positional gradient (e.g. the
   * per-section warm-ramp tints in `noodle --help`). Inert under `color: 'none'`. */
  readonly borderTint?: RGB;
}

const HEADER_RGB: RGB = AMBER;
const MIN_COLUMN_WIDTH = 3;

// Build the ANSI-strip matcher without a literal control char in source (matches gradient.ts style).
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const stripAnsi = (s: string): string => s.replace(ANSI, '');
const visibleWidth = (s: string): number => [...stripAnsi(s)].length;

interface BorderGlyphs {
  readonly h: string; // horizontal rule
  readonly v: string; // vertical bar
  readonly topL: string;
  readonly topM: string;
  readonly topR: string;
  readonly midL: string;
  readonly midM: string;
  readonly midR: string;
  readonly botL: string;
  readonly botM: string;
  readonly botR: string;
}

const UNICODE: BorderGlyphs = {
  h: '─',
  v: '│',
  topL: '┌',
  topM: '┬',
  topR: '┐',
  midL: '├',
  midM: '┼',
  midR: '┤',
  botL: '└',
  botM: '┴',
  botR: '┘',
};

const ASCII: BorderGlyphs = {
  h: '-',
  v: '|',
  topL: '+',
  topM: '+',
  topR: '+',
  midL: '+',
  midM: '+',
  midR: '+',
  botL: '+',
  botM: '+',
  botR: '+',
};

function ellipsis(glyph: GlyphMode): string {
  return glyph === 'ascii' ? '..' : '…';
}

function truncate(text: string, width: number, glyph: GlyphMode): string {
  if (visibleWidth(text) <= width) return text;
  const ell = ellipsis(glyph);
  const keep = Math.max(0, width - ell.length);
  return [...text].slice(0, keep).join('') + ell;
}

/** Column content widths: max(header, cells), capped by `maxWidth`, then shrunk to fit the budget. */
function computeWidths<Row>(
  columns: readonly Column<Row>[],
  rows: readonly Row[],
  maxTableWidth: number | undefined,
): number[] {
  const widths = columns.map((col) => {
    const content = Math.max(col.header.length, ...rows.map((r) => visibleWidth(col.get(r))), 0);
    return col.maxWidth !== undefined ? Math.min(col.maxWidth, content) : content;
  });

  if (maxTableWidth === undefined) return widths;
  const overhead = 1 + 3 * columns.length; // edge bars + inner bars + per-cell padding
  const total = (): number => overhead + widths.reduce((a, b) => a + b, 0);
  // Repeatedly trim the widest column until the table fits or nothing can shrink further.
  while (total() > maxTableWidth) {
    let widest = MIN_COLUMN_WIDTH;
    let idx = -1;
    for (let i = 0; i < widths.length; i++) {
      if ((widths[i] as number) > widest) {
        widest = widths[i] as number;
        idx = i;
      }
    }
    if (idx === -1) break;
    widths[idx] = (widths[idx] as number) - 1;
  }
  return widths;
}

/** Bar x-positions and the total table width, so borders can be tinted by position. */
function barPositions(widths: readonly number[]): { positions: number[]; totalWidth: number } {
  const positions: number[] = [];
  let x = 0;
  for (let i = 0; i < widths.length; i++) {
    positions.push(x);
    x += 1 + (widths[i] as number) + 2; // this bar + ' ' + content + ' '
  }
  positions.push(x); // trailing bar
  return { positions, totalWidth: x + 1 };
}

/** One horizontal rule (top/mid/bottom), gradient-tinted by x-position. */
function rule(
  kind: 'top' | 'mid' | 'bottom',
  widths: readonly number[],
  g: BorderGlyphs,
  opts: TableOptions,
): string {
  const { positions, totalWidth } = barPositions(widths);
  const junctionSet: readonly [string, string, string] =
    kind === 'top'
      ? [g.topL, g.topM, g.topR]
      : kind === 'bottom'
        ? [g.botL, g.botM, g.botR]
        : [g.midL, g.midM, g.midR];
  const chars: string[] = new Array(totalWidth).fill(g.h);
  positions.forEach((p, i) => {
    chars[p] =
      i === 0 ? junctionSet[0] : i === positions.length - 1 ? junctionSet[2] : junctionSet[1];
  });
  return chars.map((ch, x) => tint(ch, x, totalWidth, opts)).join('');
}

/** Tint a border glyph: a flat `borderTint` colour when set, else by its horizontal position
 * along the warm cyclic gradient. */
function tint(ch: string, x: number, totalWidth: number, opts: TableOptions): string {
  if (opts.color === 'none' || opts.gradient === false) return ch;
  if (opts.borderTint !== undefined) return paint(opts.borderTint, ch, opts.color);
  return paint(cyclic(x / totalWidth), ch, opts.color);
}

/** Pad a (possibly coloured) cell to `width`, aligning content; padding stays outside the colour. */
function cell(
  text: string,
  width: number,
  align: 'left' | 'right',
  rgb: RGB | undefined,
  color: ColorMode,
): string {
  const pad = ' '.repeat(Math.max(0, width - visibleWidth(text)));
  const body = rgb ? paint(rgb, text, color) : text;
  return align === 'right' ? pad + body : body + pad;
}

/** A data/header row: `│ c │ c │ c │` with gradient-tinted bars and coloured cell bodies. */
function row(
  cells: readonly string[],
  widths: readonly number[],
  g: BorderGlyphs,
  opts: TableOptions,
): string {
  const { positions, totalWidth } = barPositions(widths);
  let line = tint(g.v, positions[0] as number, totalWidth, opts);
  for (let i = 0; i < cells.length; i++) {
    line += ` ${cells[i]} ${tint(g.v, positions[i + 1] as number, totalWidth, opts)}`;
  }
  return line;
}

/**
 * Render `rows` as a branded, alignment-safe table. Returns the joined multi-line
 * string (no trailing newline). Emits plain ASCII under `color: 'none'`.
 */
export function renderTable<Row>(
  columns: readonly Column<Row>[],
  rows: readonly Row[],
  opts: TableOptions,
): string {
  const g = opts.glyph === 'ascii' ? ASCII : UNICODE;
  const widths = computeWidths(columns, rows, opts.maxTableWidth);

  const headerCells = columns.map((col, i) =>
    cell(
      truncate(col.header, widths[i] as number, opts.glyph),
      widths[i] as number,
      col.align ?? 'left',
      opts.color === 'none' ? undefined : HEADER_RGB,
      opts.color,
    ),
  );
  const bodyLines = rows.map((r) =>
    row(
      columns.map((col, i) =>
        cell(
          truncate(col.get(r), widths[i] as number, opts.glyph),
          widths[i] as number,
          col.align ?? 'left',
          col.color?.(r),
          opts.color,
        ),
      ),
      widths,
      g,
      opts,
    ),
  );

  return [
    rule('top', widths, g, opts),
    row(headerCells, widths, g, opts),
    rule('mid', widths, g, opts),
    ...bodyLines,
    rule('bottom', widths, g, opts),
  ].join('\n');
}
