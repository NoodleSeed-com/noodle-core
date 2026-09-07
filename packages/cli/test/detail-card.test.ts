import { describe, expect, it } from 'vitest';
import { renderDetailCard } from '../src/detail-card.js';

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const strip = (s: string): string => s.replace(ANSI, '');

const ROWS = [
  { key: 'deployment', value: 'support-bot-prod-8f31c2', note: '(v3)' },
  { key: 'state', value: 'active', tone: 'good' as const, dot: true },
  { key: 'access', value: 'org-members', tone: 'attention' as const, note: '— members sign in' },
  { key: 'health', value: 'failing', tone: 'bad' as const },
];

describe('renderDetailCard', () => {
  it('aligns keys to the widest key with the spine on every row', () => {
    const out = renderDetailCard('acme/support-bot/prod', ROWS, {
      color: 'none',
      glyph: 'unicode',
    });
    const lines = out.split('\n');
    expect(lines[0]).toBe('acme/support-bot/prod');
    const rowLines = lines.filter((l) => l.startsWith('│'));
    expect(rowLines).toHaveLength(4);
    // Every value starts at the same column: `│ ` + key padded to widest ('deployment' = 10) + 3 spaces.
    for (const line of rowLines) expect(line).toMatch(/^│ .{10} {3}\S/);
    expect(rowLines[1]).toContain('● active');
  });

  it('color is a pure overlay: stripped colored output equals the plain rendering', () => {
    const plain = renderDetailCard('t', ROWS, { color: 'none', glyph: 'unicode' }, ['noodle logs']);
    const colored = renderDetailCard('t', ROWS, { color: 'truecolor', glyph: 'unicode' }, [
      'noodle logs',
    ]);
    expect(strip(colored)).toBe(plain);
  });

  it('tones map to the semantic palette (green/amber/rose) and keys render dim', () => {
    const colored = renderDetailCard('t', ROWS, { color: 'truecolor', glyph: 'unicode' });
    expect(colored).toContain('38;2;34;197;94'); // good
    expect(colored).toContain('38;2;245;158;11'); // attention
    expect(colored).toContain('38;2;244;63;94'); // bad
    expect(colored).toContain('38;2;115;115;115'); // dim keys
  });

  it('renders the NEXT footer only when follow-ups exist', () => {
    const bare = renderDetailCard('t', ROWS, { color: 'none', glyph: 'unicode' });
    expect(bare).not.toContain('NEXT');
    const withNext = renderDetailCard('t', ROWS, { color: 'none', glyph: 'unicode' }, [
      'noodle logs --tail',
      'noodle metrics',
    ]);
    expect(withNext).toContain('NEXT  noodle logs --tail · noodle metrics');
  });

  it('degrades to ASCII glyphs (| and *) and stays escape-free under color none', () => {
    const out = renderDetailCard('t', ROWS, { color: 'none', glyph: 'ascii' }, ['noodle logs']);
    expect(out).not.toContain(ESC);
    expect(out).toContain('| ');
    expect(out).toContain('* active');
  });
});
