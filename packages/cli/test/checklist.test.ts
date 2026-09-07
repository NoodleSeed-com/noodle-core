import { describe, expect, it } from 'vitest';
import { type ChecklistItem, renderChecklist } from '../src/checklist.js';

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const strip = (s: string): string => s.replace(ANSI, '');

const ITEMS: readonly ChecklistItem[] = [
  { label: 'Node', tone: 'ok', detail: 'v24.2.0' },
  { label: 'Endpoint health', tone: 'warn', detail: 'stale metadata', fix: 'Deploy again.' },
  {
    label: 'Login',
    tone: 'fail',
    detail: 'missing',
    cause: 'No saved login token was found.',
    fix: 'Sign in to the target service.',
    command: 'noodle login',
  },
];

describe('renderChecklist', () => {
  it('aligns the label column and renders the dim detail after it', () => {
    const out = renderChecklist(ITEMS, { color: 'none', glyph: 'unicode' });
    const lines = out.split('\n');
    expect(lines[0]).toBe('✔ Node              v24.2.0');
    expect(lines[1]).toBe('⚠ Endpoint health   stale metadata');
    // Every detail starts at the same column: glyph + space + label padded to widest (15) + 3 spaces.
    expect(lines[0]).toMatch(/^. .{15} {3}\S/);
    expect(lines[1]).toMatch(/^. .{15} {3}\S/);
  });

  it('failing items get indented dim Cause:/Fix: lines and a plain-ink command beneath', () => {
    const out = renderChecklist(ITEMS, { color: 'none', glyph: 'unicode' });
    expect(out).toContain('  Fix: Deploy again.');
    expect(out).toContain('  Cause: No saved login token was found.');
    expect(out).toContain('  Fix: Sign in to the target service.');
    expect(out).toContain('  noodle login');
    // ok items never grow sub-lines even if fix text is present.
    const okOnly = renderChecklist(
      [{ label: 'CLI', tone: 'ok', detail: '1.0.0', fix: 'nope', command: 'noodle nope' }],
      { color: 'none', glyph: 'unicode' },
    );
    expect(okOnly).not.toContain('Fix:');
    expect(okOnly).not.toContain('noodle nope');
  });

  it('ends with the dim summary line, pluralizing warnings', () => {
    const out = renderChecklist(ITEMS, { color: 'none', glyph: 'unicode' });
    const lines = out.split('\n');
    expect(lines.at(-1)).toBe('1 ok · 1 warning · 1 failing');
    const many = renderChecklist(
      [
        { label: 'a', tone: 'warn' },
        { label: 'b', tone: 'warn' },
      ],
      { color: 'none', glyph: 'unicode' },
    );
    expect(many.split('\n').at(-1)).toBe('0 ok · 2 warnings · 0 failing');
  });

  it('color is a pure overlay: stripped colored output equals the plain rendering', () => {
    const plain = renderChecklist(ITEMS, { color: 'none', glyph: 'unicode' });
    const colored = renderChecklist(ITEMS, { color: 'truecolor', glyph: 'unicode' });
    expect(strip(colored)).toBe(plain);
  });

  it('tones map to green/amber/rose glyphs with dim details under truecolor', () => {
    const colored = renderChecklist(ITEMS, { color: 'truecolor', glyph: 'unicode' });
    expect(colored).toContain(`38;2;34;197;94m✔`); // ok green glyph
    expect(colored).toContain(`38;2;245;158;11m⚠`); // warn amber glyph
    expect(colored).toContain(`38;2;244;63;94m✗`); // fail rose glyph
    expect(colored).toContain('38;2;115;115;115'); // dim detail/summary
    // The command line stays plain ink (no dim wrap directly before it).
    const commandLine = colored.split('\n').find((line) => strip(line).trim() === 'noodle login');
    expect(commandLine).toBe('  noodle login');
  });

  it('degrades to ASCII glyphs (+ ! x) and stays escape-free under color none', () => {
    const out = renderChecklist(ITEMS, { color: 'none', glyph: 'ascii' });
    expect(out).not.toContain(ESC);
    expect(out).toContain('+ Node');
    expect(out).toContain('! Endpoint health');
    expect(out).toContain('x Login');
  });
});
