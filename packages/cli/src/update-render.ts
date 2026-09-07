/**
 * Branded rendering for the update flow: the warm palette and step glyphs the
 * rest of the CLI already speaks (gradient.ts + status.ts), composed - never
 * reinvented - for version deltas, settled results, and repair notices.
 *
 * The 'none' color mode is a hard contract: byte-identical plain, escape-free
 * copy. It is what agents, CI, pipes, NO_COLOR, and the update-command tests
 * see, and it matches the #242 spec strings exactly.
 */

import { AMBER, type ColorMode, detectGlyphMode, ORANGE, paint } from './gradient.js';
import { renderStep } from './status.js';

// Control codes composed per the gradient.ts convention (no raw ESC bytes in source).
const ESC = String.fromCharCode(27);
const DIM = `${ESC}[2m`;
const UNDIM = `${ESC}[22m`;

/** "Noodle CLI update available: X -> Y" - old version dimmed, arrow amber, new version orange. */
export function renderUpdateAvailable(installed: string, latest: string, mode: ColorMode): string {
  if (mode === 'none') return `Noodle CLI update available: ${installed} -> ${latest}`;
  return `Noodle CLI update available: ${DIM}${installed}${UNDIM} ${paint(AMBER, '→', mode)} ${paint(ORANGE, latest, mode)}`;
}

export function renderUpToDate(installed: string, mode: ColorMode): string {
  const text = `Noodle CLI is up to date. (v${installed})`;
  if (mode === 'none') return text;
  return renderStep('done', text, mode, detectGlyphMode());
}

export function renderUpdated(installed: string, latest: string, mode: ColorMode): string {
  if (mode === 'none') return `Updated Noodle CLI: ${installed} -> ${latest}`;
  return renderStep(
    'done',
    `Updated Noodle CLI: ${DIM}${installed}${UNDIM} ${paint(AMBER, '→', mode)} ${paint(ORANGE, latest, mode)}`,
    mode,
    detectGlyphMode(),
  );
}

/** A calm ⚠ line for repair situations; plain mode passes the text through untouched. */
export function renderRepairNotice(text: string, mode: ColorMode): string {
  if (mode === 'none') return text;
  return renderStep('warn', text, mode, detectGlyphMode());
}
