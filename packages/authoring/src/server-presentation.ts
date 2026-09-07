import type { Manifest } from '@noodle-borg/compiler';
import type { EmbeddedAssistantConfig } from './assistant.js';
import type { ServerOptions } from './server.js';

export function manifestShell(
  shell: NonNullable<ServerOptions['shell']>,
): NonNullable<Manifest['server']['shell']> {
  return {
    ...(shell.displayMode !== undefined ? { displayMode: shell.displayMode } : {}),
    ...(shell.header !== undefined
      ? {
          header: {
            ...(shell.header.title !== undefined ? { title: shell.header.title } : {}),
            ...(shell.header.subtitle !== undefined ? { subtitle: shell.header.subtitle } : {}),
          },
        }
      : {}),
    ...(shell.navigation !== undefined
      ? {
          navigation: {
            variant: shell.navigation.variant,
            items: shell.navigation.items.map((item) => ({ ...item })),
          },
        }
      : {}),
    ...(shell.persistentActions !== undefined
      ? {
          persistentActions: shell.persistentActions.map((action) => ({
            ...action,
          })),
        }
      : {}),
  };
}

export function manifestAssistant(
  assistant: EmbeddedAssistantConfig,
): NonNullable<Manifest['server']['assistant']> {
  const { suggestedPrompts, ...configuration } = assistant;
  // `structuredClone()` creates ordinary mutable arrays at runtime, but its TypeScript return type
  // preserves the author's readonly input modifiers. Normalize that type at the manifest boundary so
  // nested presentation lists (header actions, heading segments, and features) match the generated
  // mutable manifest type without weakening the public authoring API.
  const clonedConfiguration = structuredClone(configuration) as DeepMutable<typeof configuration>;
  return {
    ...clonedConfiguration,
    model: { ...configuration.model },
    allowedOrigins: [...configuration.allowedOrigins],
    ...(suggestedPrompts ? { suggestedPrompts: [...suggestedPrompts] } : {}),
  };
}

type DeepMutable<T> = T extends readonly (infer Item)[]
  ? DeepMutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
    : T;
