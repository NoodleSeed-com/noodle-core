import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const srcRoot = join(import.meta.dirname, '..', 'src');
const outputModule = join(srcRoot, 'commands', 'output.ts');
const HUMAN_SINK_MARKER = 'cli-output-drift-allow: human-only';

function cliSources(dir = srcRoot): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return cliSources(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('CLI JSON output ownership', () => {
  it('keeps direct JSON serializers and process stdio sinks behind canonical or explicit human-only boundaries', () => {
    const offenders = cliSources().flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      const sinkPatterns = [
        /(?:console\.(?:log|error)|\b(?:log|logError|write|emit))\(\s*JSON\.stringify/g,
        /process\.(?:stdout|stderr)\.write/g,
      ];
      return sinkPatterns.flatMap((pattern) =>
        [...source.matchAll(pattern)]
          .filter((match) => {
            if (path === outputModule && pattern === sinkPatterns[0]) return false;
            const before = source.slice(0, match.index).split('\n');
            return !before.slice(-2).some((line) => line.includes(HUMAN_SINK_MARKER));
          })
          .map(
            (match) =>
              `${relative(process.cwd(), path)}:${source.slice(0, match.index).split('\n').length}`,
          ),
      );
    });

    expect(offenders).toEqual([]);
  });
});
