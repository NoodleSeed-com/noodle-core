import {
  SANDBOX_AUTHORING_LIMITS,
  SandboxAuthoringError,
  SandboxedAuthoringLoader,
} from '@noodle-borg/authoring/sandbox-authoring';
import {
  type ApplicationDraftSource,
  ApplicationDraftSourceSchema,
} from '@noodle-borg/wire-contracts';
import { DraftArtifactChecker } from './artifact-checker.js';
import { type DraftArtifactCheck, draftCompileFailure } from './compiler-result.js';
import { DraftValidationUnavailableError } from './contracts.js';
import { applicationDraftSourceDigest } from './store.js';

export type DraftCompileResult =
  | {
      readonly ok: true;
      readonly sourceDigest: string;
      readonly compilerDigest: string;
      readonly artifactDigest: string;
    }
  | Extract<DraftArtifactCheck, { ok: false }>;

/** One lifecycle-owned compiler per service composition. No publication or execution authority. */
export class ApplicationDraftCompiler {
  readonly #loader = new SandboxedAuthoringLoader();
  readonly #checker = new DraftArtifactChecker();
  #active = 0;
  #closed = false;

  async compile(source: ApplicationDraftSource): Promise<DraftCompileResult> {
    if (this.#closed) throw new DraftValidationUnavailableError('unavailable');
    if (this.#active >= SANDBOX_AUTHORING_LIMITS.concurrentBuilds)
      throw new DraftValidationUnavailableError('busy');
    const parsed = ApplicationDraftSourceSchema.safeParse(source);
    if (!parsed.success) return draftCompileFailure('invalid_source');
    this.#active++;
    try {
      const loaded = await this.#loader.load({
        entrypoint: parsed.data.entrypoint,
        files: Object.fromEntries(parsed.data.files.map(({ path, content }) => [path, content])),
      });
      // A fresh trusted worker independently validates potentially forged VM output as data.
      // It never receives source files, credentials, a filesystem root, or a runnable operation.
      const checked = await this.#checker.check(
        {
          manifest: loaded.manifest,
          ...(loaded.connectors === undefined ? {} : { connectors: loaded.connectors }),
        },
        SANDBOX_AUTHORING_LIMITS.timeoutMs,
      );
      if (!checked.ok) return checked;
      return {
        ...checked,
        sourceDigest: applicationDraftSourceDigest(parsed.data),
        compilerDigest: loaded.compilerDigest,
      };
    } catch (error) {
      if (error instanceof DraftValidationUnavailableError) throw error;
      if (error instanceof SandboxAuthoringError) {
        if (['busy', 'closed', 'unavailable'].includes(error.code))
          throw new DraftValidationUnavailableError(error.code === 'busy' ? 'busy' : 'unavailable');
        return draftCompileFailure(error.code);
      }
      throw new DraftValidationUnavailableError('unavailable');
    } finally {
      this.#active--;
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all([this.#loader.close(), this.#checker.close()]);
  }
}
