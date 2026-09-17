import type { CommandSpec, FlagSpec, SubcommandSpec } from '../../src/commands/catalog-types.js';

export function flagMap(flags: readonly FlagSpec[] | undefined): ReadonlyMap<string, FlagSpec> {
  return new Map((flags ?? []).map((flag) => [flag.name, flag]));
}

export type RecursiveSubcommand = SubcommandSpec & {
  readonly subcommands?: readonly RecursiveSubcommand[];
};

export function nestedSubcommands(
  value: CommandSpec | SubcommandSpec,
): readonly RecursiveSubcommand[] {
  return (
    (
      value as CommandSpec & {
        readonly subcommands?: readonly RecursiveSubcommand[];
      }
    ).subcommands ?? []
  );
}

export function walkSubcommands(
  value: CommandSpec | RecursiveSubcommand,
  path: readonly string[] = [],
): readonly { readonly path: readonly string[]; readonly value: RecursiveSubcommand }[] {
  return nestedSubcommands(value).flatMap((child) => [
    { path: [...path, child.name], value: child },
    ...walkSubcommands(child, [...path, child.name]),
  ]);
}
