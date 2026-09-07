import { describe, expect, it } from 'vitest';
import { type Column, renderTable } from '../src/table.js';

interface Row {
  readonly app: string;
  readonly env: string;
  readonly status: string;
}

const ROWS: readonly Row[] = [
  { app: 'hello-world', env: 'prod', status: 'active' },
  { app: 'financial-contact-center', env: 'prod', status: 'inactive' },
  { app: 'smoke', env: 'dev', status: 'active' },
];

const COLUMNS: readonly Column<Row>[] = [
  { header: 'APP', get: (r) => r.app },
  { header: 'ENV', get: (r) => r.env },
  { header: 'STATUS', get: (r) => r.status, align: 'right' },
];

const stripAnsi = (s: string): string =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping SGR escapes for width/plain assertions
  s.replace(/\[[0-9;]*m/g, '');

const visibleWidth = (s: string): number => [...stripAnsi(s)].length;

describe('renderTable', () => {
  it('aligns every column even when one row is much wider than the others', () => {
    const out = renderTable(COLUMNS, ROWS, { color: 'none', glyph: 'unicode' });
    const lines = out.split('\n');
    // Every rendered line is the same visible width — the drift bug is impossible.
    const widths = new Set(lines.map(visibleWidth));
    expect(widths.size).toBe(1);
    // The header and the widest cell both appear in full (no maxWidth set here).
    expect(out).toContain('APP');
    expect(out).toContain('financial-contact-center');
  });

  it('emits zero ANSI escapes under color:none (clean for pipes/agents)', () => {
    const out = renderTable(COLUMNS, ROWS, { color: 'none', glyph: 'unicode' });
    expect(out).toBe(stripAnsi(out));
  });

  it('color never changes layout: stripping ANSI from a colored render equals the plain render', () => {
    const plain = renderTable(COLUMNS, ROWS, { color: 'none', glyph: 'unicode' });
    const colored = renderTable(COLUMNS, ROWS, {
      color: 'truecolor',
      glyph: 'unicode',
      gradient: true,
      // a semantic color on the status column must not shift alignment
    });
    expect(stripAnsi(colored)).toBe(plain);
    // ...and the colored render actually carried escapes (gradient borders + any cell color).
    expect(colored).not.toBe(plain);
  });

  it('applies a per-cell semantic color without affecting width', () => {
    const cols: readonly Column<Row>[] = [
      { header: 'APP', get: (r) => r.app },
      {
        header: 'STATUS',
        get: (r) => r.status,
        color: (r) => (r.status === 'active' ? [34, 197, 94] : [115, 115, 115]),
      },
    ];
    const plain = renderTable(cols, ROWS, { color: 'none', glyph: 'unicode' });
    const colored = renderTable(cols, ROWS, { color: 'truecolor', glyph: 'unicode' });
    expect(stripAnsi(colored)).toBe(plain);
    expect(colored).toContain('[38;2;34;197;94m'); // active green applied
  });

  it('truncates cells past maxWidth with an ellipsis and holds the column width', () => {
    const cols: readonly Column<Row>[] = [{ header: 'APP', get: (r) => r.app, maxWidth: 10 }];
    const out = renderTable(cols, ROWS, { color: 'none', glyph: 'unicode' });
    expect(out).toContain('financial…'); // 9 kept chars + ellipsis == column width 10
    expect(out).not.toContain('financial-contact-center');
    // header 'APP' (3) < maxWidth 10, so the column is exactly 10 wide throughout
    const lines = out.split('\n');
    expect(new Set(lines.map(visibleWidth)).size).toBe(1);
  });

  it('right-aligns a column by padding on the left', () => {
    const out = renderTable(COLUMNS, ROWS, { color: 'none', glyph: 'unicode' });
    // 'active' (6) is the widest STATUS value; 'dev' row's 'active' also 6, but 'prod'
    // rows carry 'active'/'inactive' — inactive (8) is widest, so 'active' gets 2 left-pad.
    expect(out).toMatch(/ {2}active/);
  });

  it('uses box-drawing borders in unicode and ASCII fallbacks otherwise', () => {
    const uni = renderTable(COLUMNS, ROWS, { color: 'none', glyph: 'unicode' });
    expect(uni).toContain('│');
    expect(uni).toContain('─');
    const ascii = renderTable(COLUMNS, ROWS, { color: 'none', glyph: 'ascii' });
    expect(ascii).toContain('|');
    expect(ascii).toContain('-');
    expect(ascii).not.toContain('│');
  });

  it('fits within maxTableWidth by shrinking the widest flexible column', () => {
    const out = renderTable(COLUMNS, ROWS, {
      color: 'none',
      glyph: 'unicode',
      maxTableWidth: 30,
    });
    const lines = out.split('\n');
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(30);
  });
});
