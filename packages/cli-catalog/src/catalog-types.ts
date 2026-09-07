/**
 * Types for the CLI's declarative command catalog (`catalog.ts`). Pure type definitions — no
 * runtime code — so this module has zero import cost for anything that only needs the shapes
 * (including the doc/skill generator scripts, which read the sibling data modules directly).
 */

export type CatalogValueType = 'string' | 'boolean' | 'integer' | 'number';

export interface CatalogValueConstraints {
  readonly choices?: readonly (string | number | boolean)[];
  readonly default?: string | number | boolean;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
}

export interface ArgumentSpec {
  readonly name: string;
  readonly type: CatalogValueType;
  readonly summary: string;
  readonly required: boolean;
  readonly variadic: boolean;
  readonly sensitive: boolean;
  readonly constraints: CatalogValueConstraints;
}

export interface FlagSpec {
  /** Flag name without leading dashes, e.g. `'org'` renders as `--org`. */
  readonly name: string;
  readonly type: CatalogValueType;
  /** Placeholder shown for a value-taking flag, e.g. `'<slug>'`. Omitted for booleans. */
  readonly value?: string;
  /** One-line meaning shown in help. Machine-readable facts belong in `constraints`. */
  readonly summary: string;
  readonly required: boolean;
  readonly repeatable: boolean;
  readonly sensitive: boolean;
  readonly aliases: readonly string[];
  readonly conflictsWith: readonly string[];
  readonly constraints?: CatalogValueConstraints;
}

export interface JsonOutputSpec {
  /** Default framing when no conditional streaming flag is present. */
  readonly mode: 'single' | 'stream';
  /** Canonical flag names or aliases that switch a default-single command to NDJSON framing. */
  readonly streamWhenAnyFlag?: readonly string[];
}

export interface SubcommandSpec {
  readonly name: string;
  readonly summary: string;
  readonly arguments: readonly ArgumentSpec[];
  /** Nested grammar nodes for multi-token command paths. Leaf nodes own applicable flags/arguments. */
  readonly subcommands?: readonly SubcommandSpec[];
  readonly flags: readonly FlagSpec[];
  readonly jsonOutput?: JsonOutputSpec;
  /** Full usage-line override for a subcommand whose shape doesn't fit name+arguments+flags. */
  readonly usage?: string;
}

/** A hard-removed verb: no longer runs, but stays in the catalog so `commands --json` and
 * did-you-mean can point at its replacement instead of silently forgetting it existed. */
export interface RemovedSpec {
  readonly use: string;
}

/** The `noodle --help` section a command renders under (founder-approved 2026-07-06 layout).
 * Every spec carries one — including removed verbs, which keep their slot but never render. */
export type CommandSection = 'start' | 'build' | 'operate' | 'github' | 'resources' | 'account';

interface CommandSpecBase {
  readonly name: string;
  readonly summary: string;
  /** Which `noodle --help` section this command belongs to. */
  readonly section: CommandSection;
}

export interface ActiveCommandSpec extends CommandSpecBase {
  /** Priority within the help section when it overflows the row cap (lower = earlier).
   * Unranked commands keep catalog data order after every ranked one. */
  readonly helpRank?: number;
  /** Follow-up command lines for the per-command help `NEXT` footer (only where obvious). */
  readonly next?: readonly string[];
  readonly arguments: readonly ArgumentSpec[];
  readonly subcommands?: readonly SubcommandSpec[];
  /** Top-level flags. Shown alongside subcommands (flags common to all of them) or standalone
   * for a command with no subcommands. */
  readonly flags: readonly FlagSpec[];
  readonly jsonOutput?: JsonOutputSpec;
  /** Full usage-line override when derived rendering (name + arguments + flags) isn't a good fit. */
  readonly usage?: string;
  /** Exit codes beyond the standard 0–4 taxonomy (e.g. `update`'s 10–14, ADR 0118). */
  readonly exitCodes?: Readonly<Record<number, string>>;
  readonly removed?: never;
  /** No account/service required — the command only touches the local project/filesystem. */
  readonly local?: boolean;
}

export interface RemovedCommandSpec extends CommandSpecBase {
  readonly removed: RemovedSpec;
  readonly helpRank?: never;
  readonly next?: never;
  readonly arguments?: never;
  readonly subcommands?: never;
  readonly flags?: never;
  readonly jsonOutput?: never;
  readonly usage?: never;
  readonly exitCodes?: never;
  readonly local?: never;
}

export type CommandSpec = ActiveCommandSpec | RemovedCommandSpec;
