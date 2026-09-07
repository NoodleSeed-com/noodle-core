/**
 * Pre-dispatch catalog interception for `cli.ts`: per-command `--help`, bare-noun help for
 * subcommand dispatchers, unknown-subcommand did-you-mean, and unknown-top-level-command
 * did-you-mean. Kept out of `cli.ts` itself so it stays a thin dispatch table (see its doc
 * comment) — this module owns the catalog-facing behavior, `cli.ts` just calls it.
 */

import { type CommandSpec, type FlagSpec, findCommand, SUBCOMMAND_DISPATCHERS } from './catalog.js';
import { renderCommandHelp, unknownCommandInfo, unknownSubcommandInfo } from './catalog-render.js';
import { EXIT, printJsonFailure } from './output.js';

function isFlag(token: string | undefined): boolean {
  return token?.startsWith('-') ?? false;
}

/** Runtime-only legacy paths. Never expose these through catalog, help, or generated docs. */
const COMPATIBILITY_SUBCOMMANDS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['agents', new Set(['context'])],
]);

function isCompatibilitySubcommand(command: string, subcommand: string): boolean {
  return COMPATIBILITY_SUBCOMMANDS.get(command)?.has(subcommand) ?? false;
}

/**
 * Runs before `cli.ts`'s dispatch switch for any `command` that matches a catalog entry.
 * Returns an exit code when it fully handled the invocation (help, bare-noun, or unknown
 * subcommand); returns `undefined` when the normal command handler should run.
 */
export function interceptCatalogHelp(
  command: string | undefined,
  rest: readonly string[],
): number | undefined {
  const entry = findCommand(command);
  if (entry === undefined) return undefined;

  const machineUsage = interceptMachineUsage(entry, rest);
  if (machineUsage !== undefined) return machineUsage;

  if (rest.includes('--help') || rest.includes('-h')) {
    console.log(renderCommandHelp(entry));
    return EXIT.OK;
  }

  if (entry.subcommands === undefined || !SUBCOMMAND_DISPATCHERS.has(entry.name)) return undefined;

  const json = rest.includes('--json');
  const first = rest[0];
  if (first === undefined || isFlag(first)) {
    return printMissingSubcommand(entry, json);
  }
  if (
    !entry.subcommands.some((sub) => sub.name === first) &&
    !isCompatibilitySubcommand(entry.name, first)
  ) {
    return printUnknownSubcommand(entry, first, json);
  }
  return undefined;
}

function declaresJson(flags: readonly FlagSpec[] | undefined, usage?: string): boolean {
  return flags?.some((flag) => flag.name === 'json') === true || usage?.includes('--json') === true;
}

function interceptMachineUsage(entry: CommandSpec, rest: readonly string[]): number | undefined {
  if (!rest.includes('--json')) return undefined;
  const subcommand = entry.subcommands?.find((candidate) => candidate.name === rest[0]);
  if (
    !declaresJson(entry.flags, entry.usage) &&
    !declaresJson(subcommand?.flags, subcommand?.usage)
  ) {
    return undefined;
  }

  const path = [entry.name, ...(subcommand === undefined ? [] : [subcommand.name])].join(' ');
  if (rest.filter((arg) => arg === '--json').length > 1) {
    return printJsonFailure(
      {
        code: 'duplicate_option',
        message: `noodle ${path}: --json may be supplied once`,
        fix: 'Remove the duplicate --json flag.',
        next: `noodle ${path} --help`,
      },
      EXIT.USAGE,
    );
  }

  if (rest.includes('--help') || rest.includes('-h')) {
    return printJsonFailure(
      {
        code: 'unsupported_json_help',
        message: `noodle ${path}: --help does not have a JSON representation`,
        fix: 'Remove --json for human help, or inspect the machine-readable command catalog.',
        next: 'noodle commands --json',
      },
      EXIT.USAGE,
    );
  }

  // Billing's catalog entry describes several nested grammars with one shared flag superset. Its
  // parsers already emit canonical, action-specific usage failures, so keep those established error
  // codes instead of replacing them with a less precise catalog-level failure.
  const valueFlags =
    entry.name === 'billing'
      ? new Set<string>()
      : new Set(
          [...(entry.flags ?? []), ...(subcommand?.flags ?? [])]
            .filter((flag) => flag.type !== 'boolean')
            .map((flag) => `--${flag.name}`),
        );
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    if (flag === undefined || !valueFlags.has(flag)) continue;
    const value = rest[index + 1];
    if (value !== undefined && !value.startsWith('--')) continue;
    return printJsonFailure(
      {
        code: 'missing_option_value',
        message: `noodle ${path}: ${flag} requires a value`,
        fix: `Pass a value immediately after ${flag}.`,
        next: `noodle ${path} --help`,
      },
      EXIT.USAGE,
    );
  }
  return undefined;
}

function printMissingSubcommand(entry: CommandSpec, json: boolean): number {
  if (json) {
    return printJsonFailure(
      {
        code: 'missing_subcommand',
        message: `noodle ${entry.name} requires a subcommand`,
        fix: `Choose one of: ${(entry.subcommands ?? []).map((sub) => sub.name).join(', ')}.`,
        next: `noodle ${entry.name} --help`,
      },
      EXIT.USAGE,
    );
  } else {
    console.error(renderCommandHelp(entry));
  }
  return EXIT.USAGE;
}

function printUnknownSubcommand(entry: CommandSpec, input: string, json: boolean): number {
  const info = unknownSubcommandInfo(entry, input);
  if (json) {
    return printJsonFailure(
      {
        code: 'unknown_subcommand',
        message: info.message,
        fix: `Choose one of: ${(entry.subcommands ?? []).map((sub) => sub.name).join(', ')}.`,
        next: `noodle ${entry.name} --help`,
        suggestions: info.suggestions,
      },
      EXIT.USAGE,
    );
  } else {
    console.error(info.message);
  }
  return EXIT.USAGE;
}

/** Handle a top-level verb with no catalog entry at all (`cli.ts`'s `default:` case). */
export function handleUnknownCommand(command: string, rest: readonly string[]): number {
  // A leading flag with no verb (e.g. `noodle --json`) is not an unknown command to did-you-mean —
  // the user named a flag but no command. Point at the one canonical machine-readable surface,
  // `noodle commands --json`, instead of a dead-end "Unknown command". One canonical way: do not fork a
  // second top-level listing here. (`--help`/`--version` are handled earlier in cli.ts's switch.)
  if (command.startsWith('-')) {
    // `--json` failures go to stdout via the shared envelope helper — agent loops parse stdout.
    if ([command, ...rest].includes('--json')) {
      return printJsonFailure(
        {
          code: 'no_command',
          message: `noodle needs a command; \`${command}\` is a flag, not a command.`,
          fix: 'Run `noodle commands --json` to list every command as JSON.',
          next: 'noodle commands --json',
        },
        EXIT.USAGE,
      );
    }
    console.error(
      `noodle: \`${command}\` is a flag, not a command. Run \`noodle commands\` to list commands.`,
    );
    return EXIT.USAGE;
  }

  const info = unknownCommandInfo(command);
  const json = rest.includes('--json');
  if (json) {
    return printJsonFailure(
      {
        code: 'unknown_command',
        message: info.message,
        fix: 'Run `noodle commands` to list every supported command.',
        next: 'noodle commands',
        suggestions: info.suggestions,
      },
      EXIT.USAGE,
    );
  } else {
    console.error(info.message);
  }
  return EXIT.USAGE;
}
