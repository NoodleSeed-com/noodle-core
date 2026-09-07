import type { Manifest } from '@noodle-borg/compiler';
import type { z } from 'zod';
import type { ConnectorRef } from './connectors.js';
import type { JsonSchema } from './json-schema.js';
import { toJsonSchema } from './json-schema.js';
import { type ConnectorClient, recordAmbientContext, type SymbolicScope } from './recording.js';

export interface ServerContextOptions {
  readonly defaults?: {
    readonly locale?: string;
    readonly timeZone?: string;
  };
  readonly ambient?: AmbientContextOptions;
}

export interface AmbientContextOptions {
  readonly output: JsonSchema | z.ZodType;
  /** Recorded at author time; tenant JavaScript is never invoked by the shared runtime. */
  readonly fulfil: (ctx: AmbientProviderContext) => unknown | Promise<unknown>;
}

export interface AmbientProviderContext {
  readonly user: SymbolicScope;
  readonly context: SymbolicScope;
  readonly connectors: Record<string, ConnectorClient>;
}

/** Convert TypeScript context authoring into the server-level manifest data contract. */
export async function manifestContext(
  context: ServerContextOptions | undefined,
  connectors: Readonly<Record<string, ConnectorRef>>,
): Promise<NonNullable<Manifest['server']['context']>> {
  if (context === undefined) return {};
  const ambient =
    context.ambient === undefined
      ? undefined
      : await recordAmbientContext(context.ambient.fulfil, connectors);
  return {
    ...(context.defaults !== undefined
      ? {
          defaults: {
            ...(context.defaults.locale !== undefined ? { locale: context.defaults.locale } : {}),
            ...(context.defaults.timeZone !== undefined
              ? { timeZone: context.defaults.timeZone }
              : {}),
          },
        }
      : {}),
    ...(ambient !== undefined && context.ambient !== undefined
      ? {
          ambient: {
            outputSchema: toJsonSchema(context.ambient.output),
            fulfilment: { steps: ambient.steps, output: ambient.output },
          },
        }
      : {}),
  };
}
