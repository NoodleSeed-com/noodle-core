import { AMBER, type ColorMode, type GlyphMode, paint, type RGB } from './gradient.js';

/**
 * The branded "checklist" — the one renderer for report commands that settle a list of named
 * checks (`doctor`, `check`; the sibling of `detail-card.ts` for single things). Anatomy: a
 * semantic glyph per item (✔ green / ⚠ amber / ✗ rose), an aligned label column, a dim detail
 * after it, indented dim `Cause:`/`Fix:` lines plus a plain-ink command beneath non-ok items,
 * and a dim `N ok · N warnings · N failing` summary line at the end.
 *
 * Same output contract as `detail-card.ts`/`table.ts`: color is a pure overlay
 * (`stripAnsi(colored)` equals the plain rendering), `color: 'none'` emits escape-free aligned
 * text, ASCII glyphs (`+`/`!`/`x`) replace the Unicode set under `glyph: 'ascii'`, and callers
 * suppress the checklist entirely under `--json`/`--agent-output`.
 */

type ChecklistTone = 'ok' | 'warn' | 'fail';

export interface ChecklistItem {
  readonly label: string;
  readonly tone: ChecklistTone;
  /** Dim detail rendered after the aligned label column. */
  readonly detail?: string;
  /** Indented dim `Cause:` line beneath the item (rendered only for non-ok items). */
  readonly cause?: string;
  /** Indented dim `Fix:` line beneath the item (rendered only for non-ok items). */
  readonly fix?: string;
  /** Indented plain-ink follow-up command beneath the fix (rendered only for non-ok items). */
  readonly command?: string;
}

export interface ChecklistOptions {
  readonly color: ColorMode;
  readonly glyph: GlyphMode;
}

const GOOD: RGB = [34, 197, 94];
const BAD: RGB = [244, 63, 94];
const DIM: RGB = [115, 115, 115];

const GLYPHS_UNICODE: Record<ChecklistTone, string> = { ok: '✔', warn: '⚠', fail: '✗' };
const GLYPHS_ASCII: Record<ChecklistTone, string> = { ok: '+', warn: '!', fail: 'x' };
const TONE_COLOR: Record<ChecklistTone, RGB> = { ok: GOOD, warn: AMBER, fail: BAD };

/** Render the checklist: aligned toned items, non-ok remediation sub-lines, dim summary. */
export function renderChecklist(items: readonly ChecklistItem[], opts: ChecklistOptions): string {
  const glyphs = opts.glyph === 'ascii' ? GLYPHS_ASCII : GLYPHS_UNICODE;
  const labelWidth = Math.max(0, ...items.map((item) => [...item.label].length));
  const dim = (s: string): string => (opts.color === 'none' ? s : paint(DIM, s, opts.color));
  const lines: string[] = [];
  const counts: Record<ChecklistTone, number> = { ok: 0, warn: 0, fail: 0 };
  for (const item of items) {
    counts[item.tone] += 1;
    const glyph =
      opts.color === 'none'
        ? glyphs[item.tone]
        : paint(TONE_COLOR[item.tone], glyphs[item.tone], opts.color);
    const detail = item.detail === undefined ? '' : `${' '.repeat(3)}${dim(item.detail)}`;
    const label = item.detail === undefined ? item.label : item.label.padEnd(labelWidth);
    lines.push(`${glyph} ${label}${detail}`);
    if (item.tone === 'ok') continue;
    if (item.cause !== undefined) lines.push(`  ${dim(`Cause: ${item.cause}`)}`);
    if (item.fix !== undefined) lines.push(`  ${dim(`Fix: ${item.fix}`)}`);
    if (item.command !== undefined) lines.push(`  ${item.command}`);
  }
  const warnings = counts.warn === 1 ? 'warning' : 'warnings';
  lines.push('');
  lines.push(dim(`${counts.ok} ok · ${counts.warn} ${warnings} · ${counts.fail} failing`));
  return lines.join('\n');
}
