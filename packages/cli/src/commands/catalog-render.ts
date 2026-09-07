/**
 * Renders the command catalog (`catalog.ts`) into every human/machine surface: the branded,
 * sectioned `usage()` banner (founder-approved 2026-07-06 layout), per-command `--help` text,
 * `noodle commands` (human + `--json`), and did-you-mean error text for unknown commands and
 * subcommands. Colour/glyph degrade to plain aligned ASCII under `color: 'none'` (pipes / CI /
 * NO_COLOR) and `glyph: 'ascii'` — the invariant is zero ANSI escapes on non-capable streams.
 */
import { isDeepStrictEqual } from 'node:util';
import {
  AMBER,
  type ColorMode,
  detectColorMode,
  detectGlyphMode,
  type GlyphMode,
  mix,
  ORANGE,
  paint,
  type RGB,
  ROSE,
} from '../gradient.js';
import { type Column, renderTable } from '../table.js';
import { currentCliVersion } from '../update.js';
import {
  type ArgumentSpec,
  CATALOG,
  type CommandSpec,
  closestCommands,
  closestSubcommands,
  type FlagSpec,
  STANDARD_EXIT_CODES,
  type SubcommandSpec,
} from './catalog.js';
import type { CommandSection } from './catalog-types.js';

const NAME_COLUMN = 14;
/** Dim ink for footers, hints, and collapsed rows (matches `DIM_GRAY` in resource views). */
const DIM: RGB = [115, 115, 115];
/** Muted stone tone (#a8a29e) for flag/subcommand names in per-command help. */
const MUTED: RGB = [168, 162, 158];
/** Per-section row cap in `usage()`; overflow collapses into one dim `+N more` row. */
const MAX_SECTION_ROWS = 5;

interface HelpSection {
  readonly key: CommandSection;
  readonly title: string;
  /** ASCII-glyph fallback when the title carries a non-ASCII character (em dash). */
  readonly asciiTitle?: string;
}

/** The six `noodle --help` sections, in approved render order. */
const HELP_SECTIONS: readonly HelpSection[] = [
  { key: 'start', title: 'START HERE' },
  { key: 'build', title: 'BUILD & TEST LOCALLY' },
  { key: 'operate', title: 'DEPLOY & OPERATE' },
  { key: 'github', title: 'GITHUB — DEPLOY ON PUSH', asciiTitle: 'GITHUB - DEPLOY ON PUSH' },
  { key: 'resources', title: 'YOUR RESOURCES' },
  { key: 'account', title: 'ACCOUNT & CONFIG' },
];

/** Stream style for the human help surfaces. Callers may override for tests or forced modes;
 * defaults come from the same stdout detection the resource tables use. */
export interface HelpRenderOptions {
  readonly color?: ColorMode;
  readonly glyph?: GlyphMode;
  readonly maxTableWidth?: number;
  /** CLI version shown in the `usage()` title (defaults to the installed version). */
  readonly version?: string;
}

interface HelpStyle {
  readonly color: ColorMode;
  readonly glyph: GlyphMode;
  readonly maxTableWidth?: number;
}

function resolveStyle(options: HelpRenderOptions): HelpStyle {
  const width = options.maxTableWidth ?? process.stdout.columns;
  return {
    color: options.color ?? detectColorMode(process.stdout),
    glyph: options.glyph ?? detectGlyphMode(),
    ...(width !== undefined ? { maxTableWidth: width } : {}),
  };
}

function flagToken(flag: FlagSpec): string {
  if (flag.type === 'boolean') return `--${flag.name}`;
  const choices = flag.constraints?.choices;
  const value =
    choices !== undefined && choices.length > 0
      ? choices.map((choice) => String(choice)).join('|')
      : (flag.value ?? '<value>');
  return `--${flag.name} ${value}`;
}

function argumentToken(argument: ArgumentSpec): string {
  const choices = argument.constraints.choices;
  const placeholder =
    choices !== undefined && choices.length > 0
      ? choices.map((choice) => String(choice)).join('|')
      : `<${argument.name}>`;
  const variadic = argument.variadic ? `${placeholder}...` : placeholder;
  return argument.required ? variadic : `[${variadic}]`;
}

function argumentTokens(arguments_: readonly ArgumentSpec[] | undefined): string {
  return (arguments_ ?? []).map(argumentToken).join(' ');
}

function constraintFacts(flag: FlagSpec): readonly string[] {
  const constraints = flag.constraints ?? {};
  const facts: string[] = [];
  if (flag.required === true) facts.push('required');
  if (flag.repeatable === true) facts.push('repeatable');
  if (flag.aliases !== undefined && flag.aliases.length > 0) {
    facts.push(`aliases: ${flag.aliases.map((alias) => `--${alias}`).join(', ')}`);
  }
  if (flag.conflictsWith !== undefined && flag.conflictsWith.length > 0) {
    facts.push(`conflicts: ${flag.conflictsWith.map((conflict) => `--${conflict}`).join(', ')}`);
  }
  if (constraints.default !== undefined) facts.push(`default ${String(constraints.default)}`);
  if (constraints.minimum !== undefined && constraints.maximum !== undefined) {
    facts.push(`range ${constraints.minimum}-${constraints.maximum}`);
  } else if (constraints.minimum !== undefined) {
    facts.push(`minimum ${constraints.minimum}`);
  } else if (constraints.maximum !== undefined) {
    facts.push(`maximum ${constraints.maximum}`);
  }
  if (
    constraints.minLength !== undefined &&
    constraints.maxLength !== undefined &&
    constraints.minLength === constraints.maxLength
  ) {
    facts.push(`${constraints.minLength} characters`);
  } else if (constraints.minLength !== undefined && constraints.maxLength !== undefined) {
    facts.push(`${constraints.minLength}-${constraints.maxLength} characters`);
  } else if (constraints.minLength !== undefined) {
    facts.push(`at least ${constraints.minLength} characters`);
  } else if (constraints.maxLength !== undefined) {
    facts.push(`at most ${constraints.maxLength} characters`);
  }
  return facts;
}

function flagDescription(flag: FlagSpec): string {
  const facts = constraintFacts(flag);
  const summary = flag.summary;
  return facts.length === 0
    ? summary
    : `${summary}${summary.length > 0 ? ' ' : ''}(${facts.join('; ')})`;
}

function commandUsageToken(entry: CommandSpec): string {
  if (entry.usage !== undefined) return entry.usage;
  if (entry.subcommands !== undefined && entry.subcommands.length > 0) {
    return entry.subcommands.map((sub) => sub.name).join('|');
  }
  return argumentTokens(entry.arguments);
}

function joinSuggestions(names: readonly string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0] as string;
  if (names.length === 2) return `${names[0]} or ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, or ${names[names.length - 1]}`;
}

/** `🍜 ` brand mark on unicode terminals; nothing under ascii glyphs (never emoji tofu). */
function brandMark(glyph: GlyphMode): string {
  return glyph === 'ascii' ? '' : '🍜 ';
}

function dash(glyph: GlyphMode): string {
  return glyph === 'ascii' ? '-' : '—';
}

// --- usage() -----------------------------------------------------------------

interface UsageRow {
  readonly command: string;
  readonly summary: string;
  /** The collapsed `+N more` overflow row renders both cells dim. */
  readonly dim: boolean;
}

/** Non-removed commands of one section, ordered by `helpRank` (lower first), then data order. */
function sectionEntries(key: CommandSection): readonly CommandSpec[] {
  return CATALOG.map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.removed === undefined && entry.section === key)
    .sort(
      (a, b) =>
        (a.entry.helpRank ?? Number.MAX_SAFE_INTEGER) -
          (b.entry.helpRank ?? Number.MAX_SAFE_INTEGER) || a.index - b.index,
    )
    .map(({ entry }) => entry);
}

function commandCell(entry: CommandSpec): string {
  const arguments_ = argumentTokens(entry.arguments);
  return arguments_.length > 0 ? `${entry.name} ${arguments_}` : entry.name;
}

/** Section rows: at most `MAX_SECTION_ROWS` commands, plus one dim `+N more` collapse row. */
function sectionRows(entries: readonly CommandSpec[], glyph: GlyphMode): readonly UsageRow[] {
  const toRow = (entry: CommandSpec): UsageRow => ({
    command: commandCell(entry),
    summary: entry.summary,
    dim: false,
  });
  if (entries.length <= MAX_SECTION_ROWS) return entries.map(toRow);
  const rest = entries.slice(MAX_SECTION_ROWS);
  const sep = glyph === 'ascii' ? ', ' : ' · ';
  return [
    ...entries.slice(0, MAX_SECTION_ROWS).map(toRow),
    {
      command: `+${rest.length} more`,
      summary: rest.map((entry) => entry.name).join(sep),
      dim: true,
    },
  ];
}

/** Flat border tint for section `index`: the warm ramp ROSE → ORANGE → AMBER down the page. */
function sectionTint(index: number, count: number): RGB {
  if (count <= 1) return ORANGE;
  const t = index / (count - 1);
  return t <= 0.5 ? mix(ROSE, ORANGE, t * 2) : mix(ORANGE, AMBER, (t - 0.5) * 2);
}

function usageTitle(style: HelpStyle, version: string): string {
  const tagline = ` v${version} ${dash(style.glyph)} author, deploy, and operate MCP apps`;
  return `${brandMark(style.glyph)}${paint(ORANGE, 'noodle', style.color)}${paint(DIM, tagline, style.color)}`;
}

function usageFooter(style: HelpStyle): string {
  const arrow = style.glyph === 'ascii' ? '->' : '→';
  const dot = style.glyph === 'ascii' ? '|' : '·';
  const text = `noodle <command> --help ${arrow} details & flags   ${dot}   agents: noodle commands --json   ${dot}   docs.noodleseed.dev`;
  return paint(DIM, text, style.color);
}

/** Render the full sectioned usage banner (`noodle --help` / `noodle -h` / bare unknown command). */
export function renderUsageText(options: HelpRenderOptions = {}): string {
  const style = resolveStyle(options);
  const version = options.version ?? currentCliVersion();
  const rowsBySection = HELP_SECTIONS.map((section) =>
    sectionRows(sectionEntries(section.key), style.glyph),
  );

  // Shared column widths across all six tables so the boxes align down the page.
  const allRows = rowsBySection.flat();
  const commandWidth = Math.max('COMMAND'.length, ...allRows.map((r) => [...r.command].length));
  const summaryWidth = Math.max('SUMMARY'.length, ...allRows.map((r) => [...r.summary].length));
  const columns: readonly Column<UsageRow>[] = [
    {
      header: 'COMMAND',
      get: (r) => r.command.padEnd(commandWidth),
      color: (r) => (r.dim ? DIM : ORANGE),
    },
    {
      header: 'SUMMARY',
      get: (r) => r.summary.padEnd(summaryWidth),
      color: (r) => (r.dim ? DIM : undefined),
    },
  ];

  const lines: string[] = [
    usageTitle(style, version),
    paint(DIM, 'usage: noodle <command>', style.color),
  ];
  HELP_SECTIONS.forEach((section, index) => {
    const title =
      style.glyph === 'ascii' && section.asciiTitle !== undefined
        ? section.asciiTitle
        : section.title;
    lines.push('', paint(AMBER, title, style.color));
    lines.push(
      renderTable(columns, rowsBySection[index] as readonly UsageRow[], {
        ...style,
        borderTint: sectionTint(index, HELP_SECTIONS.length),
      }),
    );
  });
  lines.push('', usageFooter(style));
  return lines.join('\n');
}

// --- per-command --help --------------------------------------------------------

interface SubcommandLeaf {
  readonly path: readonly string[];
  readonly value: SubcommandSpec;
}

function subcommandLeaves(
  subcommands: readonly SubcommandSpec[],
  prefix: readonly string[] = [],
): readonly SubcommandLeaf[] {
  return subcommands.flatMap((subcommand) => {
    const path = [...prefix, subcommand.name];
    return subcommand.subcommands !== undefined && subcommand.subcommands.length > 0
      ? subcommandLeaves(subcommand.subcommands, path)
      : [{ path, value: subcommand }];
  });
}

function subcommandLines(entry: CommandSpec, style: HelpStyle): readonly string[] {
  const leaves = subcommandLeaves(entry.subcommands ?? []);
  const topLevelFlags = entry.flags ?? [];
  const tokenLines = leaves.map(({ path, value }) =>
    (
      value.usage ?? [path.join(' '), argumentTokens(value.arguments)].filter(Boolean).join(' ')
    ).split('\n'),
  );
  // Align summaries on the longest token, capped so one long usage override can't
  // push every other summary off to the right.
  const width = Math.min(
    30,
    Math.max(...tokenLines.flatMap((tokens) => tokens.map((token) => [...token].length)), 0),
  );
  const lines: string[] = ['', paint(DIM, 'SUBCOMMANDS', style.color)];
  leaves.forEach(({ value }, i) => {
    const tokens = tokenLines[i] as readonly string[];
    tokens.forEach((token, tokenIndex) => {
      const pad = ' '.repeat(Math.max(2, width + 2 - [...token].length));
      lines.push(
        `  ${paint(MUTED, token, style.color)}${pad}${tokenIndex === 0 ? value.summary : ''}`,
      );
    });
    // A subcommand's own flags (e.g. `tools call --args`) render indented under it, so per-command
    // `--help` documents them instead of dropping them the way it did before.
    for (const flag of value.flags.filter(
      (leafFlag) =>
        !topLevelFlags.some((topLevelFlag) => isDeepStrictEqual(topLevelFlag, leafFlag)),
    )) {
      const description = flagDescription(flag);
      const summary = description.length > 0 ? `  ${description}` : '';
      lines.push(`    ${paint(MUTED, flagToken(flag), style.color)}${summary}`);
    }
  });
  return lines;
}

function flagTableLines(entry: CommandSpec, style: HelpStyle): readonly string[] {
  const flags = entry.removed === undefined ? entry.flags : [];
  const columns: readonly Column<FlagSpec>[] = [
    { header: 'FLAG', get: (flag) => flagToken(flag), color: () => MUTED },
    { header: 'DESCRIPTION', get: flagDescription },
  ];
  return ['', renderTable(columns, flags, { ...style, borderTint: ORANGE })];
}

/** Render the full per-command help block for `noodle <name> --help` (or a bare-noun dispatcher
 * with no subcommand given). */
export function renderCommandHelp(entry: CommandSpec, options: HelpRenderOptions = {}): string {
  const style = resolveStyle(options);
  const title = `${brandMark(style.glyph)}${paint(ORANGE, `noodle ${entry.name}`, style.color)}${paint(
    DIM,
    ` ${dash(style.glyph)} ${entry.summary}`,
    style.color,
  )}`;
  const lines: string[] = [title];
  if (entry.removed !== undefined) {
    lines.push('', `Removed. Use: ${entry.removed.use}`);
    return lines.join('\n');
  }
  const usageLine = `USAGE  noodle ${entry.name} ${commandUsageToken(entry)}`.trimEnd();
  lines.push('', paint(DIM, usageLine, style.color));
  if (entry.subcommands !== undefined && entry.subcommands.length > 0) {
    lines.push(...subcommandLines(entry, style));
  }
  if (entry.flags !== undefined && entry.flags.length > 0) {
    lines.push(...flagTableLines(entry, style));
  }
  if (entry.exitCodes !== undefined && Object.keys(entry.exitCodes).length > 0) {
    lines.push('', paint(DIM, 'EXIT CODES', style.color));
    for (const [code, meaning] of Object.entries(entry.exitCodes)) {
      lines.push(`  ${code}  ${meaning}`);
    }
  }
  if (entry.local === true) {
    lines.push(
      '',
      paint(
        DIM,
        `Runs locally ${dash(style.glyph)} no account or hosted service required.`,
        style.color,
      ),
    );
  }
  if (entry.next !== undefined && entry.next.length > 0) {
    const sep = style.glyph === 'ascii' ? '  |  ' : '   ·   ';
    lines.push('', paint(DIM, `NEXT  ${entry.next.join(sep)}`, style.color));
  }
  return lines.join('\n');
}

// --- did-you-mean ----------------------------------------------------------------

export interface UnknownCommandInfo {
  readonly message: string;
  readonly suggestions: readonly string[];
}

/** Build the plain-text + suggestion list for an unknown top-level verb. */
export function unknownCommandInfo(input: string): UnknownCommandInfo {
  const suggestions = closestCommands(input);
  const hint = suggestions.length > 0 ? ` Did you mean: ${joinSuggestions(suggestions)}?` : '';
  return { message: `Unknown command "${input}".${hint}`, suggestions };
}

/** Build the plain-text + suggestion list for an unknown subcommand of a known dispatcher. */
export function unknownSubcommandInfo(entry: CommandSpec, input: string): UnknownCommandInfo {
  const suggestions = closestSubcommands(entry, input);
  const hint = suggestions.length > 0 ? ` Did you mean: ${joinSuggestions(suggestions)}?` : '';
  return {
    message: `Unknown subcommand "${input}" for "${entry.name}".${hint}`,
    suggestions,
  };
}

// --- noodle commands ---------------------------------------------------------------

/** Compact grouped human list for `noodle commands` (no `--json`). */
export function renderCommandsHuman(): string {
  const lines: string[] = [];
  for (const entry of CATALOG) {
    if (entry.removed !== undefined) {
      lines.push(`  ${entry.name.padEnd(NAME_COLUMN)}(removed — use ${entry.removed.use})`);
      continue;
    }
    lines.push(`  ${entry.name.padEnd(NAME_COLUMN)}${entry.summary}`);
  }
  lines.push('', 'Run `noodle <command> --help` for subcommands, flags, and exit codes.');
  return lines.join('\n');
}

/** The full machine-readable catalog payload for `noodle commands --json`. */
export function buildCatalogJsonPayload(version: string): {
  readonly commands: readonly CommandSpec[];
  readonly exitCodes: Readonly<Record<number, string>>;
  readonly version: string;
} {
  return { commands: CATALOG, exitCodes: STANDARD_EXIT_CODES, version };
}
