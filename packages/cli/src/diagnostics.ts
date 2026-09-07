export interface RecoveryDiagnostic {
  readonly command: string;
  readonly cause: string;
  readonly fix: string;
  readonly next: string;
  /**
   * Short failure summary for the first line (`${command}: ${message}`). Falls back to `cause` when
   * omitted, so existing callers that only ever had one string keep their prior output unchanged.
   */
  readonly message?: string;
}

export function printRecovery(
  diagnostic: RecoveryDiagnostic,
  write: (line: string) => void = console.error,
): void {
  write(`${diagnostic.command}: ${diagnostic.message ?? diagnostic.cause}`);
  write(`Cause: ${diagnostic.cause}`);
  write(`Fix: ${diagnostic.fix}`);
  write(`Next: ${diagnostic.next}`);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
