/**
 * The post-sign-in resume decision and its platform message (issue #1177). When a spent ticket
 * elevates a session, the service may run one assistant turn so the model re-attempts the
 * intercepted intent under the new principal — the visitor signed in to get an answer, and the
 * panel's first content should be that answer, not silence. Transport-free like the elevation
 * decision; `packages/service` adapts.
 */

/**
 * Whether a successful elevation arms the one-shot resume. ON by default — the demo-magic case is
 * the default experience — with the exchange-side `resume: false` as the single disable knob (it
 * lives in the integrator's own session endpoint, the code that spends the ticket).
 */
export function shouldAutoResume(override: boolean | undefined): boolean {
  return override ?? true;
}

/**
 * The `[platform]` message that drives the resume turn, persisted to history as a user-role
 * message like the interaction-resolution narration. It must countermand the interception's own
 * guidance ("ask them to sign in, then offer to try again") — the sign-in already happened, and
 * asking the visitor to repeat themselves is the silence this feature removes. Arguments are not
 * replayed: the model re-derives them from history under the new principal.
 */
export function resumeTurnMessage(tool: string): string {
  return (
    `[platform] The visitor has just signed in. Their last request needed the "${tool}" tool, ` +
    `which returned sign_in_required. Call "${tool}" now to complete that request yourself — do ` +
    'not ask them to repeat or re-confirm it — then reply naturally with the outcome.'
  );
}

/**
 * The honest fail-closed variant: the elevation landed the conversation on a surface whose
 * projection does not offer the intercepted tool (ADR 0201 amendment 2026-08-26). Silence would
 * read as a hang and a hallucinated attempt would be worse, so the model is told plainly to say
 * the action is not available here and to offer what this surface can do.
 */
export function resumeUnavailableMessage(tool: string): string {
  return (
    `[platform] The visitor has just signed in. Their pre-sign-in request needed the "${tool}" ` +
    'tool, but the surface this signed-in conversation continues on does not offer it. Tell them ' +
    'plainly that this action is not available here, and offer what the current tools can do ' +
    'instead. Do not pretend to run it.'
  );
}
