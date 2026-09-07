// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrapAssistantEmbed } from '../src/embed.js';
import { ASSISTANT_TAG_NAME } from '../src/index.js';

/**
 * The script-tag path, which is the only one a marketing page has.
 *
 * Tested through the exported bootstrap rather than by evaluating the built IIFE: the module's own
 * `document.currentScript` call is one line, and driving it with an explicit script element is what
 * lets these cases exist at all.
 */

function scriptTag(attributes: Readonly<Record<string, string>>): HTMLScriptElement {
  const script = document.createElement('script');
  for (const [name, value] of Object.entries(attributes)) script.setAttribute(name, value);
  // Deliberately not attached: the bootstrap reads the tag's attributes, and attaching it would make
  // the test environment try to fetch the URL.
  return script;
}

afterEach(() => {
  document.body.replaceChildren();
  document.head.replaceChildren();
  vi.restoreAllMocks();
});

describe('the embed script bootstrap', () => {
  it('mounts the assistant from the tag’s own attributes', () => {
    bootstrapAssistantEmbed(
      scriptTag({ src: 'https://cloud.test/v1/assistant/embed.js', 'data-embed-id': 'pub_abc' }),
    );

    const element = document.querySelector(ASSISTANT_TAG_NAME);
    expect(element?.getAttribute('embed-id')).toBe('pub_abc');
  });

  /**
   * One snippet, every environment. The URL the developer pasted already names the service they
   * deployed to, so deriving the origin from it beats asking them to keep a second value in sync.
   */
  it('defaults the service origin to wherever the script itself was served from', () => {
    bootstrapAssistantEmbed(
      scriptTag({ src: 'https://staging.test/v1/assistant/embed.js', 'data-embed-id': 'pub_abc' }),
    );

    expect(document.querySelector(ASSISTANT_TAG_NAME)?.getAttribute('service-url')).toBe(
      'https://staging.test',
    );
  });

  it('lets an explicit data-service-url win', () => {
    bootstrapAssistantEmbed(
      scriptTag({
        src: 'https://cdn.test/embed.js',
        'data-embed-id': 'pub_abc',
        'data-service-url': 'https://cloud.test',
      }),
    );

    expect(document.querySelector(ASSISTANT_TAG_NAME)?.getAttribute('service-url')).toBe(
      'https://cloud.test',
    );
  });

  /**
   * A dead widget on a marketing page is the top support cost for an embed, so a missing id must say so
   * by name rather than leave a developer inspecting an empty DOM.
   */
  it('says what is missing instead of failing silently', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    bootstrapAssistantEmbed(scriptTag({ src: 'https://cloud.test/v1/assistant/embed.js' }));

    expect(error.mock.calls[0]?.[0]).toContain('data-embed-id');
    expect(document.querySelector(ASSISTANT_TAG_NAME)).toBeNull();
  });

  it('mounts once when a page pastes the snippet twice', () => {
    const tag = { src: 'https://cloud.test/v1/assistant/embed.js', 'data-embed-id': 'pub_abc' };
    bootstrapAssistantEmbed(scriptTag(tag));
    bootstrapAssistantEmbed(scriptTag(tag));

    expect(document.querySelectorAll(ASSISTANT_TAG_NAME)).toHaveLength(1);
  });
});
