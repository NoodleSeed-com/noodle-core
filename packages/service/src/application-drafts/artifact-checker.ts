import { Worker } from 'node:worker_threads';
import {
  type DraftArtifactCheck,
  type DraftArtifactInput,
  draftArtifactCheckSchema,
  draftCompileFailure,
} from './compiler-result.js';
import { DraftValidationUnavailableError } from './contracts.js';

/** Resource isolation for trusted declarative validation, separate from the untrusted-code VM. */
export class DraftArtifactChecker {
  readonly #workers = new Set<Worker>();
  #closed = false;

  check(input: DraftArtifactInput, timeoutMs: number): Promise<DraftArtifactCheck> {
    if (this.#closed) return Promise.reject(new DraftValidationUnavailableError('unavailable'));
    if (this.#workers.size >= 2) return Promise.reject(new DraftValidationUnavailableError('busy'));
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10_000)
      return Promise.resolve(draftCompileFailure('timeout'));
    return new Promise((resolve, reject) => {
      // Fixed platform-owned sibling of the emitted module, never a path supplied by the draft.
      const worker = new Worker(new URL('./compiler-worker.js', import.meta.url), {
        workerData: input,
        env: {},
        execArgv: [],
        stdout: true,
        stderr: true,
        resourceLimits: {
          maxOldGenerationSizeMb: 128,
          maxYoungGenerationSizeMb: 16,
          stackSizeMb: 4,
        },
      });
      this.#workers.add(worker);
      worker.stdout?.resume();
      worker.stderr?.resume();
      let settled = false;
      const finish = (result?: DraftArtifactCheck) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Do not free admission until termination has completed.
        void worker.terminate().then(
          () => {
            this.#workers.delete(worker);
            if (result && !this.#closed) resolve(result);
            else reject(new DraftValidationUnavailableError('unavailable'));
          },
          () => {
            this.#workers.delete(worker);
            reject(new DraftValidationUnavailableError('unavailable'));
          },
        );
      };
      const timer = setTimeout(() => finish(draftCompileFailure('timeout')), Math.ceil(timeoutMs));
      worker.once('message', (message: unknown) => {
        const parsed = draftArtifactCheckSchema.safeParse(message);
        finish(parsed.success ? parsed.data : undefined);
      });
      worker.once('error', (error: Error & { code?: string }) =>
        finish(
          error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? draftCompileFailure('memory') : undefined,
        ),
      );
      worker.once('exit', () => finish());
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all([...this.#workers].map((worker) => worker.terminate()));
  }
}
