/** Classify the full MCP safe-read hint set for diagnostics and host planning. Confirmation is an
 * independent explicit runtime contract; use {@link requiresToolConfirmation} for execution gates. */
export function isSafeReadTool(
  annotations: Readonly<Record<string, unknown>> | undefined,
): boolean {
  return (
    annotations?.readOnlyHint === true &&
    annotations.destructiveHint === false &&
    annotations.openWorldHint === false
  );
}

/** Whether an adapter must suspend before execution. Confirmation is an explicit author contract. */
export function requiresToolConfirmation(
  annotations: Readonly<Record<string, unknown>> | undefined,
): boolean {
  return annotations?.confirm === true;
}
