/** Static human onboarding banner. Machine output never carries the wordmark. */
import { NOODLE_WORDMARK } from '@noodle-borg/agent-kit';
import {
  type ColorMode,
  cyclic,
  detectColorMode,
  detectGlyphMode,
  type GlyphMode,
  paint,
  type RGB,
} from './gradient.js';

const WIDTH = Math.max(...NOODLE_WORDMARK.map((line) => [...line].length));

export function renderBanner(mode: ColorMode, glyph: GlyphMode, columns: number): string {
  const width = Math.max(1, columns);
  const lines = glyph === 'unicode' && width >= WIDTH ? NOODLE_WORDMARK : ['NOODLE SEED'];
  const colored = lines.map((line) =>
    [...line]
      .slice(0, width)
      .map((char, index) => {
        let color: RGB = cyclic((index / Math.max(1, line.length - 1)) * 0.5);
        if (lines === NOODLE_WORDMARK && char !== '█')
          color = [
            Math.round(color[0] * 0.45),
            Math.round(color[1] * 0.45),
            Math.round(color[2] * 0.45),
          ];
        return char === ' ' ? char : paint(color, char, mode);
      })
      .join(''),
  );
  return `\n${colored.join('\n')}\n${'Welcome to Noodle Seed!'.slice(0, width)}\n\n`;
}

export function printBanner({ json = false }: { json?: boolean } = {}): void {
  if (json || process.stdout.isTTY !== true || process.env.CI !== undefined) return;
  // cli-output-drift-allow: human-only onboarding wordmark; gated above for JSON, pipes, and CI.
  process.stdout.write(
    renderBanner(detectColorMode(process.stdout), detectGlyphMode(), process.stdout.columns ?? 80),
  );
}
