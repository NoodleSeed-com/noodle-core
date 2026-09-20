import { readFile } from 'node:fs/promises';
import {
  ComputeError,
  type ComputeInstance,
  type ComputeLimits,
  QuickJsComputeEngine,
} from '@noodle-borg/compute';
import { z } from 'zod';
import {
  SANDBOX_AUTHORING_LIMITS,
  SandboxAuthoringError,
  type SandboxAuthoringInput,
  snapshotAuthoringInput,
} from './sandbox-input.js';
import { sandboxSdkPrelude } from './sandbox-prelude.js';

export {
  SANDBOX_AUTHORING_LIMITS,
  SandboxAuthoringError,
  type SandboxAuthoringInput,
} from './sandbox-input.js';

const outputSchema = z
  .object({
    manifest: z.string().min(1),
    connectors: z.string().optional(),
    // Customer-authored data, not an approved listing or publication receipt.
    distribution: z.unknown().optional(),
  })
  .strict();
export type SandboxedAuthoringOutput = z.infer<typeof outputSchema> & {
  readonly compilerDigest: string;
};

/** Trusted composition may lower limits, never raise them or supply a host capability. */
export type SandboxAuthoringOptions = Partial<
  Pick<ComputeLimits, 'timeoutMs' | 'memoryBytes' | 'maxOutputBytes'>
>;

/** One bounded loader per service composition; each invocation gets a fresh QuickJS runtime. */
export class SandboxedAuthoringLoader {
  readonly #engine = new QuickJsComputeEngine({
    maxWorkers: SANDBOX_AUTHORING_LIMITS.concurrentBuilds,
  });
  readonly #limits: ComputeLimits;
  #prepared: Promise<{ readonly instance: ComputeInstance; readonly digest: string }> | undefined;
  #active = 0;
  #closed = false;

  constructor(options: SandboxAuthoringOptions = {}) {
    const defaults = SANDBOX_AUTHORING_LIMITS;
    for (const key of ['timeoutMs', 'memoryBytes', 'maxOutputBytes'] as const) {
      const value = options[key] ?? defaults[key];
      if (!Number.isSafeInteger(value) || value < 1 || value > defaults[key])
        throw new Error(`Invalid authoring ${key}`);
    }
    this.#limits = {
      timeoutMs: options.timeoutMs ?? defaults.timeoutMs,
      memoryBytes: options.memoryBytes ?? defaults.memoryBytes,
      maxOutputBytes: options.maxOutputBytes ?? defaults.maxOutputBytes,
      maxHostCalls: 0,
    };
  }

  async load(input: SandboxAuthoringInput): Promise<SandboxedAuthoringOutput> {
    if (this.#closed) throw new SandboxAuthoringError('closed');
    if (this.#active >= SANDBOX_AUTHORING_LIMITS.concurrentBuilds)
      throw new SandboxAuthoringError('busy');
    const source = snapshotAuthoringInput(input);
    this.#active++;
    try {
      this.#prepared ??= this.#prepare();
      const { instance, digest } = await this.#prepared;
      if (this.#closed) throw new SandboxAuthoringError('closed');
      const result = await instance.invoke(source, this.#limits, {
        // Asyncify drives SDK promises. No operation/log/control authority is supplied.
        callOperation: async () => {
          throw new Error('Authoring cannot call operations');
        },
      });
      const parsed = outputSchema.safeParse(result);
      if (!parsed.success) throw new SandboxAuthoringError('invalid_output');
      return { ...parsed.data, compilerDigest: digest };
    } catch (error) {
      if (this.#closed) throw new SandboxAuthoringError('closed');
      if (error instanceof SandboxAuthoringError) throw error;
      if (error instanceof ComputeError) {
        const code =
          error.code === 'timeout' || error.code === 'queue_timeout'
            ? 'timeout'
            : error.code === 'memory'
              ? 'memory'
              : error.code === 'output_too_large'
                ? 'output_limit'
                : 'invalid_source';
        // Do not expose arbitrary thrown source, host paths or worker implementation details.
        throw new SandboxAuthoringError(code);
      }
      throw new SandboxAuthoringError('unavailable');
    } finally {
      this.#active--;
    }
  }

  async #prepare() {
    const bundle = await readFile(new URL('./sandbox-program.bundle.js', import.meta.url), 'utf8');
    const module = await this.#engine.compile(
      `async function(input) { ${sandboxSdkPrelude}\n${bundle}\nreturn NoodleSandboxProgram.run(input); }`,
    );
    const instance = await this.#engine.instantiate(module);
    return { instance, digest: module.digest };
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#engine.close();
    const prepared = await this.#prepared?.catch(() => undefined);
    prepared?.instance.dispose();
  }
}
