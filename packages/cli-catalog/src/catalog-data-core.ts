/** CLI meta-command catalog data. Pure data — no runtime imports. */
import type { CommandSpec } from './catalog-types.js';

/** Canonical host values accepted by `noodle features --host` and advertised in discovery. */
export const FEATURE_HOST_CHOICES = ['claude', 'chatgpt', 'embedded'] as const;

export const CATALOG_CORE: readonly CommandSpec[] = [
  {
    name: 'help',
    arguments: [],
    section: 'account',
    helpRank: 16,
    summary: 'Print CLI usage and per-command help.',
    flags: [],
    local: true,
  },
  {
    name: 'version',
    arguments: [],
    section: 'account',
    helpRank: 14,
    summary: 'Print the installed CLI version.',
    flags: [],
    local: true,
  },
  {
    name: 'commands',
    arguments: [],
    section: 'account',
    helpRank: 15,
    summary: 'Print the machine-readable command catalog, or a compact human list.',
    flags: [
      {
        name: 'json',
        type: 'boolean',
        summary: 'Emit the command catalog.',
        required: false,
        repeatable: false,
        sensitive: false,
        aliases: [],
        conflictsWith: [],
      },
    ],
    jsonOutput: { mode: 'single' },
    local: true,
  },
  {
    name: 'features',
    arguments: [],
    section: 'account',
    helpRank: 13,
    summary: 'Show the public Claude, ChatGPT, and embedded-host compatibility registry.',
    flags: [
      {
        name: 'host',
        type: 'string',
        value: '<host>',
        summary: 'Filter entries by compatible host.',
        required: false,
        repeatable: false,
        sensitive: false,
        aliases: [],
        conflictsWith: [],
        constraints: { choices: FEATURE_HOST_CHOICES },
      },
      {
        name: 'json',
        type: 'boolean',
        summary: 'Emit the compatibility registry as JSON.',
        required: false,
        repeatable: false,
        sensitive: false,
        aliases: [],
        conflictsWith: [],
      },
      {
        name: 'markdown',
        type: 'boolean',
        summary: 'Emit the compatibility registry as Markdown.',
        required: false,
        repeatable: false,
        sensitive: false,
        aliases: [],
        conflictsWith: [],
      },
    ],
    jsonOutput: { mode: 'single' },
    local: true,
  },
];
