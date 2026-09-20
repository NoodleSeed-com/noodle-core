/** Operational source bounds, independent of customer plan entitlements. */
export const SANDBOX_AUTHORING_LIMITS = Object.freeze({
  files: 64,
  pathChars: 240,
  fileBytes: 256 * 1024,
  totalBytes: 1024 * 1024,
  timeoutMs: 10_000,
  memoryBytes: 128 * 1024 * 1024,
  maxOutputBytes: 4 * 1024 * 1024,
  concurrentBuilds: 2,
});

export interface SandboxAuthoringInput {
  readonly entrypoint: string;
  readonly files: Readonly<Record<string, string>>;
}

export type SandboxAuthoringErrorCode =
  | 'invalid_source'
  | 'busy'
  | 'closed'
  | 'invalid_output'
  | 'timeout'
  | 'memory'
  | 'output_limit'
  | 'unavailable';
export class SandboxAuthoringError extends Error {
  constructor(readonly code: SandboxAuthoringErrorCode) {
    super(code);
    this.name = 'SandboxAuthoringError';
  }
}

/** Copy only admitted strings; caller mutation never changes an in-flight build. */
export function snapshotAuthoringInput(input: SandboxAuthoringInput): SandboxAuthoringInput {
  const invalid = () => {
    throw new SandboxAuthoringError('invalid_source');
  };
  if (
    !input ||
    typeof input !== 'object' ||
    !input.files ||
    typeof input.files !== 'object' ||
    Array.isArray(input.files)
  )
    return invalid();
  const entries = Object.entries(input.files);
  const limits = SANDBOX_AUTHORING_LIMITS;
  if (!entries.length || entries.length > limits.files) return invalid();
  let total = 0;
  for (const [path, content] of entries) {
    if (
      path.length > limits.pathChars ||
      !/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_][A-Za-z0-9_.-]*\.(?:ts|tsx|css)$/.test(
        path,
      ) ||
      typeof content !== 'string'
    )
      return invalid();
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > limits.fileBytes) return invalid();
    total += bytes;
    if (total > limits.totalBytes) return invalid();
  }
  if (
    typeof input.entrypoint !== 'string' ||
    !/\.tsx?$/.test(input.entrypoint) ||
    !Object.hasOwn(input.files, input.entrypoint)
  )
    return invalid();
  return { entrypoint: input.entrypoint, files: Object.fromEntries(entries) };
}
