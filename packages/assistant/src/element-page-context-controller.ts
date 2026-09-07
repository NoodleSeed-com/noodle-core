import { browserPageContext, browserPageUrl } from './browser-context.js';
import type { AssistantPageContext } from './model-context.js';

type AutomaticPageSnapshot = {
  readonly url: string;
  readonly context: AssistantPageContext | undefined;
};

type AutomaticPageSnapshotLoad = {
  readonly url: string;
  readonly promise: Promise<void>;
};

/** Keeps the public embed's untrusted page snapshot fresh for the current browser path. */
export class AssistantElementPageContextController {
  #snapshot: AutomaticPageSnapshot | undefined;
  #load: AutomaticPageSnapshotLoad | undefined;
  readonly #isEnabled: () => boolean;

  constructor(isEnabled: () => boolean) {
    this.#isEnabled = isEnabled;
  }

  current(): AssistantPageContext | undefined {
    const url = browserPageUrl();
    if (!url || this.#snapshot?.url !== url) {
      this.#snapshot = undefined;
      return undefined;
    }
    return this.#snapshot.context;
  }

  async refresh(): Promise<void> {
    while (true) {
      const url = browserPageUrl();
      if (!url) return;
      if (this.#snapshot?.url === url) return;
      this.#snapshot = undefined;
      let load = this.#load;
      if (!load || load.url !== url) {
        const promise = browserPageContext(url)
          .then((context) => {
            if (this.#isEnabled() && browserPageUrl() === url) {
              this.#snapshot = { url, context };
            }
          })
          .finally(() => {
            if (this.#load?.promise === promise) this.#load = undefined;
          });
        load = { url, promise };
        this.#load = load;
      }
      await load.promise;
      if (browserPageUrl() === url) return;
    }
  }
}
