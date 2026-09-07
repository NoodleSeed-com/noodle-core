import type { AssistantConfiguration } from './appearance.js';
import { parseAssistantConfiguration } from './assistant-configuration-schema.js';
import { publicConfigurationUrl } from './session-source.js';

interface PublicConfigurationSource {
  readonly embedId: string;
  readonly serviceUrl: string;
  readonly fetch: typeof fetch | undefined;
}

/** Loads browser-safe public appearance without minting or holding a session credential. */
export class AssistantElementPublicConfigurationController {
  readonly #source: () => PublicConfigurationSource;
  readonly #apply: (configuration: AssistantConfiguration) => void;
  readonly #loadingChanged: (loading: boolean) => void;
  #generation = 0;
  #bootstrap: Promise<void> | undefined;
  #abort: AbortController | undefined;

  constructor(
    source: () => PublicConfigurationSource,
    apply: (configuration: AssistantConfiguration) => void,
    loadingChanged: (loading: boolean) => void,
  ) {
    this.#source = source;
    this.#apply = apply;
    this.#loadingChanged = loadingChanged;
  }

  connect(): void {
    this.#restart();
  }

  refresh(): void {
    this.#restart();
  }

  disconnect(): void {
    this.#generation += 1;
    this.#abort?.abort();
    this.#abort = undefined;
    this.#bootstrap = undefined;
  }

  #restart(): void {
    this.disconnect();
    this.#prime();
  }

  #prime(): void {
    const source = this.#source();
    if (!source.embedId || this.#bootstrap) return;
    const generation = this.#generation;
    const abort = new AbortController();
    this.#abort = abort;
    const fetcher = source.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#loadingChanged(true);
    const bootstrap = Promise.resolve()
      .then(() =>
        fetcher(publicConfigurationUrl(source.serviceUrl, source.embedId), {
          method: 'GET',
          headers: { accept: 'application/json' },
          credentials: 'omit',
          cache: 'no-cache',
          signal: abort.signal,
        }),
      )
      .then(async (response) => {
        if (!response.ok) return;
        const value: unknown = await response.json();
        if (generation !== this.#generation || !isRecord(value)) {
          return;
        }
        const configuration = parseAssistantConfiguration(value.configuration);
        if (configuration !== undefined) this.#apply(configuration);
      })
      .catch(() => undefined)
      .finally(() => {
        if (generation === this.#generation) this.#loadingChanged(false);
        if (this.#bootstrap === bootstrap) {
          this.#bootstrap = undefined;
          this.#abort = undefined;
        }
      });
    this.#bootstrap = bootstrap;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
