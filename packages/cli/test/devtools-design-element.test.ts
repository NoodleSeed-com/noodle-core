import { Window } from 'happy-dom';
import { describe, expect, it, vi } from 'vitest';
import { DEVTOOLS_DESIGN_ELEMENT_CLIENT_JS } from '../src/devtools-design-element.js';

interface DesignElementClient {
  capture(element: Element): Record<string, unknown>;
  resolve(
    document: Document,
    fingerprint: Record<string, unknown>,
  ):
    | { element: Element; confidence: number; evidence: string[] }
    | {
        element: null;
        confidence: number;
        evidence: string[];
        reason: 'ambiguous' | 'not_found';
      };
}

function browser(): { window: Window; client: DesignElementClient } {
  const window = new Window({ url: 'http://127.0.0.1:8789/widget' });
  window.eval(DEVTOOLS_DESIGN_ELEMENT_CLIENT_JS);
  return {
    window,
    client: (window as unknown as { NoodleDesignElement: DesignElementClient }).NoodleDesignElement,
  };
}

describe('devtools Design element evidence', () => {
  it('captures safe semantic evidence and the bounded computed-style subset', () => {
    const { window, client } = browser();
    window.document.body.innerHTML = `
      <main data-component="OrderingCard">
        <button
          id="search-stores"
          class="primary action"
          data-testid="search-action"
          data-session-token="secret-session"
          aria-label="Search stores"
          value="private-value"
        >
          Search <span hidden>hidden secret</span> stores
        </button>
      </main>
    `;
    const button = window.document.querySelector('button');
    if (!button) throw new Error('fixture button missing');
    button.style.backgroundColor = 'rgb(255, 107, 53)';

    const captured = client.capture(button);
    const serialized = JSON.stringify(captured);

    expect(captured).toMatchObject({
      tagName: 'button',
      role: 'button',
      accessibleName: 'Search stores',
      stableId: 'search-stores',
      classNames: ['action', 'primary'],
      authorHints: { testId: 'search-action' },
    });
    expect((captured.computedStyles as Record<string, string>)['background-color']).toBe(
      'rgb(255, 107, 53)',
    );
    expect(serialized).not.toContain('private-value');
    expect(serialized).not.toContain('secret-session');
    expect(serialized).not.toContain('hidden secret');
  });

  it('resolves a strong fingerprint and fails closed on ambiguous or missing targets', () => {
    const { window, client } = browser();
    window.document.body.innerHTML = `
      <section><button id="checkout" data-testid="checkout">Continue</button></section>
    `;
    const button = window.document.querySelector('button');
    if (!button) throw new Error('fixture button missing');
    const fingerprint = client.capture(button);

    const resolved = client.resolve(window.document, fingerprint);
    expect(resolved.element).toBe(button);
    expect(resolved.confidence).toBeGreaterThanOrEqual(55);

    button.removeAttribute('id');
    button.removeAttribute('data-testid');
    button.insertAdjacentHTML('afterend', '<button>Continue</button>');
    const ambiguous = client.resolve(window.document, {
      ...fingerprint,
      stableId: undefined,
      authorHints: {},
    });
    expect(ambiguous).toMatchObject({ element: null, reason: 'ambiguous' });

    window.document.body.innerHTML = '<p>Nothing similar</p>';
    expect(client.resolve(window.document, fingerprint)).toMatchObject({
      element: null,
      reason: 'not_found',
    });
  });

  it('does not scan same-tag candidates after an exact id resolves with high confidence', () => {
    const { window, client } = browser();
    window.document.body.innerHTML =
      '<button id="checkout" data-testid="checkout">Continue</button>' +
      Array.from({ length: 50 }, (_, index) => `<button>Other ${index}</button>`).join('');
    const button = window.document.getElementById('checkout');
    if (!button) throw new Error('fixture button missing');
    const fingerprint = client.capture(button);
    const querySelectorAll = vi.spyOn(window.document, 'querySelectorAll');

    expect(client.resolve(window.document, fingerprint).element).toBe(button);
    expect(querySelectorAll).not.toHaveBeenCalledWith('button');
  });
});
