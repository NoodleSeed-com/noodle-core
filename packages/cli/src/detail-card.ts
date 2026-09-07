import {
  AMBER,
  type ColorMode,
  cyclic,
  type GlyphMode,
  ORANGE,
  paint,
  type RGB,
} from './gradient.js';

/**
 * The branded "detail card" — the one renderer for every command that describes a single thing
 * (`status`, `inspect`, `whoami`, `target`, `github status`; approved design 2026-07-06). Anatomy:
 * an orange title line, a gradient spine `│` down the left, aligned dim keys, semantically colored
 * values with optional dim annotations, and a `NEXT` footer naming the natural follow-up commands.
 *
 * Same output contract as `table.ts`: color is a pure overlay (`stripAnsi(colored) === plain`
 * layout-wise), `color: 'none'` emits plain aligned escape-free text, and callers suppress the card
 * entirely under `--json`.
 */

export type DetailTone = 'default' | 'good' | 'attention' | 'bad' | 'dim';

const GOOD: RGB = [34, 197, 94];
const BAD: RGB = [244, 63, 94];
const DIM: RGB = [115, 115, 115];

export interface DetailRow {
  readonly key: string;
  readonly value: string;
  /** Semantic color for the value (default = plain ink). */
  readonly tone?: DetailTone;
  /** Dim trailing annotation, rendered after the value separated by ` — ` (or ` · ` glue as given). */
  readonly note?: string;
  /** Leading state dot before the value (`●`), tinted with the row tone. */
  readonly dot?: boolean;
}

export interface DetailCardOptions {
  readonly color: ColorMode;
  readonly glyph: GlyphMode;
}

function toneColor(tone: DetailTone | undefined): RGB | undefined {
  if (tone === 'good') return GOOD;
  if (tone === 'attention') return AMBER;
  if (tone === 'bad') return BAD;
  if (tone === 'dim') return DIM;
  return undefined;
}

/**
 * Render the card. `title` is the identity line (e.g. `acme/support-bot/prod`); `next` lists
 * follow-up commands for the footer (omitted when empty).
 */
export function renderDetailCard(
  title: string,
  rows: readonly DetailRow[],
  opts: DetailCardOptions,
  next: readonly string[] = [],
): string {
  const spine = opts.glyph === 'ascii' ? '|' : '│';
  const dotGlyph = opts.glyph === 'ascii' ? '*' : '●';
  const keyWidth = Math.max(0, ...rows.map((row) => [...row.key].length));
  const lines: string[] = [];

  lines.push(opts.color === 'none' ? title : paint(ORANGE, title, opts.color));
  lines.push('');
  rows.forEach((row, index) => {
    // The spine walks the warm gradient down the card, mirroring the table borders.
    const spineTint =
      opts.color === 'none'
        ? spine
        : paint(cyclic(rows.length <= 1 ? 0 : index / (rows.length - 1)), spine, opts.color);
    const key = row.key.padEnd(keyWidth);
    const keyText = opts.color === 'none' ? key : paint(DIM, key, opts.color);
    const rgb = toneColor(row.tone);
    const dot = row.dot ? `${dotGlyph} ` : '';
    const valueRaw = `${dot}${row.value}`;
    const valueText =
      opts.color === 'none' || rgb === undefined ? valueRaw : paint(rgb, valueRaw, opts.color);
    const noteText =
      row.note === undefined
        ? ''
        : opts.color === 'none'
          ? ` ${row.note}`
          : ` ${paint(DIM, row.note, opts.color)}`;
    lines.push(`${spineTint} ${keyText}   ${valueText}${noteText}`);
  });
  if (next.length > 0) {
    lines.push('');
    const label = opts.color === 'none' ? 'NEXT' : paint(DIM, 'NEXT', opts.color);
    const sep = opts.color === 'none' ? ' · ' : ` ${paint(DIM, '·', opts.color)} `;
    lines.push(`${label}  ${next.join(sep)}`);
  }
  return lines.join('\n');
}
