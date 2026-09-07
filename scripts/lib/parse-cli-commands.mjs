/**
 * parse-cli-commands.mjs — shared parser for the `noodle` command tree.
 *
 * Extracts command names and their one-line `///` descriptions from the
 * `switch (command)` in packages/cli/src/cli.ts. Used by the agent-skill surface
 * generator (scripts/gen-agent-skill-data.mjs). The docs reference generator
 * (scripts/gen-docs-reference.mjs) reads the richer declarative command catalog
 * (packages/cli/src/commands/catalog-data-*.ts) directly instead — see its module
 * doc comment.
 */

/**
 * Parse command names and one-line descriptions from cli.ts source.
 * @param {string} source - contents of packages/cli/src/cli.ts
 * @returns {{ name: string, desc: string }[]}
 */
export function parseCommands(source) {
  const commands = [];
  const lines = source.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/case\s+'(\w[\w-]*)':/);
    if (!match) continue;
    if (lines[i].includes('// internal')) continue;
    const name = match[1];

    // Look ahead for a comment on the next line
    let desc = '';
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      const cmt = lines[j].match(/\/\/\/?\s*(.+)/);
      if (cmt) {
        desc = cmt[1].trim().replace(/`/g, '');
        break;
      }
      if (lines[j].trim().startsWith('case ') || lines[j].trim().startsWith('default:')) break;
    }

    commands.push({ name, desc });
  }

  return commands;
}
