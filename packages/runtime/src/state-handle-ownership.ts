import type { ArtifactState } from '@noodle-borg/compiler';

export interface CallerStateAdoptionInput {
  readonly deploymentId: string;
  readonly handles: readonly string[];
  readonly sourceCallerSubject: string;
  readonly targetCallerSubject: string;
  /** The old anonymous session's absolute expiry; redirects never extend its authority. */
  readonly redirectExpiresAt: Date;
  readonly now: Date;
}

export type CallerStateAdoptionResult =
  | {
      readonly ok: true;
      readonly adoptedHandles: readonly string[];
      readonly adoptedRecords: number;
    }
  | { readonly ok: false; readonly reason: 'state_key_conflict' };

/** The canonical sorted declaration projection stored on an elevation ticket. */
export function claimableStateHandleNames(state: ArtifactState | undefined): readonly string[] {
  if (state === undefined) return [];
  return Object.entries(state.handles)
    .filter(([, handle]) => handle.claimOnAuthentication === true)
    .map(([name]) => name)
    .sort();
}
