import { ASSISTANT_TAG_NAME, registerNoodleAssistant } from './element.js';

/**
 * The script-tag bootstrap: everything between `<script src=…>` and a working assistant.
 *
 * This entry exists because a marketing page has no build step. The npm mount gives a React app
 * `<NoodleAssistant embedId=… />`; here the tag itself is the only configuration, so the loader reads
 * its own attributes, mounts the element, and gets out of the way.
 *
 * `serviceUrl` defaults to the origin the script was served from, which is what makes one pasted
 * snippet work unchanged in dev, staging, and production — the URL a developer copied already names the
 * service they deployed to.
 */

export function bootstrapAssistantEmbed(script: HTMLScriptElement | null): void {
  const embedId = script?.dataset.embedId ?? '';
  if (!embedId) {
    // Loud, because the alternative is a marketing page that silently shows nothing. This is the top
    // support cost for an embedded widget, so it must name the missing attribute, not just fail.
    console.error(
      '[noodle-assistant] the embed script tag is missing data-embed-id; run `noodle deploy` and paste the snippet it prints',
    );
    return;
  }
  const serviceUrl = script?.dataset.serviceUrl ?? originOf(script?.src);

  const mount = (): void => {
    // Idempotent: a page that pastes the snippet twice, or a framework that re-runs it on navigation,
    // gets one assistant rather than two overlapping launchers.
    if (document.querySelector(ASSISTANT_TAG_NAME)) return;
    registerNoodleAssistant();
    const element = document.createElement(ASSISTANT_TAG_NAME);
    element.setAttribute('embed-id', embedId);
    if (serviceUrl) element.setAttribute('service-url', serviceUrl);
    document.body.append(element);
  };

  // `async` in <head> can run before <body> exists; anywhere else the document is already usable.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
}

function originOf(src: string | undefined): string {
  if (!src) return '';
  try {
    return new URL(src, document.baseURI).origin;
  } catch {
    return '';
  }
}

bootstrapAssistantEmbed(document.currentScript as HTMLScriptElement | null);
