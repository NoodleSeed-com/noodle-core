import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  renderRepairNotice,
  renderUpdateAvailable,
  renderUpdated,
  renderUpToDate,
} from '../src/update-render.js';

/**
 * Branded update output (founder rule: the CLI design language - warm palette,
 * step glyphs - carries into the update flow). The 'none' color mode must stay
 * byte-identical to the plain spec copy: it is what agents, CI, pipes, and the
 * update-command tests see.
 */
describe('update renderers', () => {
  // detectGlyphMode branches on locale/terminal env; pin it so the unicode
  // assertions test the renderers, not the executing shell.
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const key of ['LANG', 'LC_ALL', 'LC_CTYPE', 'TERM_PROGRAM', 'WT_SESSION']) {
      saved[key] = process.env[key];
    }
    process.env.LANG = 'en_US.UTF-8';
    process.env.LC_ALL = 'en_US.UTF-8';
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('plain mode is byte-identical to the spec copy', () => {
    expect(renderUpdateAvailable('0.10.0', '0.10.1', 'none')).toBe(
      'Noodle CLI update available: 0.10.0 -> 0.10.1',
    );
    expect(renderUpToDate('0.10.1', 'none')).toBe('Noodle CLI is up to date. (v0.10.1)');
    expect(renderUpdated('0.10.0', '0.10.1', 'none')).toBe('Updated Noodle CLI: 0.10.0 -> 0.10.1');
    expect(renderRepairNotice('blocked at /x/noodle', 'none')).toBe('blocked at /x/noodle');
  });

  it('plain mode contains no escape codes', () => {
    for (const line of [
      renderUpdateAvailable('1.0.0', '2.0.0', 'none'),
      renderUpToDate('1.0.0', 'none'),
      renderUpdated('1.0.0', '2.0.0', 'none'),
      renderRepairNotice('warning line', 'none'),
    ]) {
      expect(line).not.toContain('[');
    }
  });

  it('truecolor mode paints the new version and uses a real arrow', () => {
    const line = renderUpdateAvailable('0.10.0', '0.10.1', 'truecolor');
    expect(line).toContain('0.10.0');
    expect(line).toContain('0.10.1');
    expect(line).toContain('[38;2;'); // warm truecolor paint
    expect(line).toContain('→');
    expect(line).not.toContain('->');
  });

  it('truecolor settled lines carry the step glyphs', () => {
    expect(renderUpToDate('0.10.1', 'truecolor')).toContain('✔');
    expect(renderUpdated('0.10.0', '0.10.1', 'truecolor')).toContain('✔');
    expect(renderRepairNotice('an old binary blocks npm', 'truecolor')).toContain('⚠');
  });
});
