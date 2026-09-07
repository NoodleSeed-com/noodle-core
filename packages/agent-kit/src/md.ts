/** Shared markdown helpers for the skill reference renderers. */

/** A raw `|` inside a cell splits the GFM column grid; escape so cells stay rectangular. */
function escapeCell(text: string): string {
  return text.replaceAll('|', '\\|');
}

export function mdTable(
  headers: readonly string[],
  rows: ReadonlyArray<readonly string[]>,
): string {
  return [
    `| ${headers.map(escapeCell).join(' | ')} |`,
    `| ${headers.map(() => ':--').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(escapeCell).join(' | ')} |`),
  ].join('\n');
}
