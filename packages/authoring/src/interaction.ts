import type { Manifest } from '@noodle-borg/compiler';
import type { ServerComponent } from './server.js';

/** Standard field controls every platform renderer supports (ADR 0240, tier 0). */
export type CollectControl = 'text' | 'textarea' | 'email' | 'phone' | 'url' | 'select' | 'consent';

export interface CollectFieldOptions {
  /** An input property of the action tool. */
  readonly key: string;
  readonly control: CollectControl;
  /**
   * Never enters the conversation model, transcript, logs or diagnostics. Nothing is private by
   * default; mark each field deliberately.
   */
  readonly private?: true;
  /** The person may leave it blank; the renderer submits the schema's empty value. */
  readonly optional?: true;
}

/**
 * Bounded `collect` interaction metadata (ADR 0240): one definition that a platform renderer presents
 * with the controls each channel has, a browser form or the tool's React `view` on the website and
 * natural collection in chat on messaging channels. It describes meaning, never layout: which fields
 * to collect for one confirmed action, which are private, what to review, and what to say on success.
 */
export interface ToolInteractionOptions {
  readonly kind: 'collect';
  /** The confirmed action tool (`{ confirm: true }`, not read-only) this collection prepares. */
  readonly action: ServerComponent;
  /** Action input property -> this tool's output property that seeds it before collection starts. */
  readonly initialValues?: Readonly<Record<string, { readonly fromOutput: string }>>;
  readonly fields: readonly CollectFieldOptions[];
  /** Every collected value is reviewed verbatim before confirmation. */
  readonly review: 'all';
  /** Shown only after a known successful business outcome. */
  readonly outcome: { readonly success: string };
  /** Shorten the channel profile's confirmation expiry (whole seconds); it can never be lengthened. */
  readonly confirmationExpiry?: { readonly seconds: number };
}

type ManifestToolInteraction = NonNullable<
  Extract<Manifest, { manifestVersion: '2' }>['tools'][number]['interaction']
>;

/** Serialize the authored block to manifest data: the action by name, fields verbatim. */
export function manifestToolInteraction(
  toolName: string,
  interaction: ToolInteractionOptions,
): ManifestToolInteraction {
  if (interaction.action.kind !== 'tool') {
    throw new Error(`tool "${toolName}" interaction.action must be a tool component`);
  }
  return {
    kind: 'collect',
    action: interaction.action.name,
    ...(interaction.initialValues === undefined
      ? {}
      : { initialValues: { ...interaction.initialValues } }),
    fields: interaction.fields.map((field) => ({
      key: field.key,
      control: field.control,
      ...(field.private === true ? { private: true as const } : {}),
      ...(field.optional === true ? { optional: true as const } : {}),
    })),
    review: 'all',
    outcome: { success: interaction.outcome.success },
    ...(interaction.confirmationExpiry === undefined
      ? {}
      : { confirmationExpiry: { seconds: interaction.confirmationExpiry.seconds } }),
  };
}
