import { Window } from 'happy-dom';
import { describe, expect, it, vi } from 'vitest';
import { DEVTOOLS_DESIGN_ELEMENT_CLIENT_JS } from '../src/devtools-design-element.js';
import { DEVTOOLS_DESIGN_PREVIEW_CLIENT_JS } from '../src/devtools-design-preview.js';

interface DesignClient {
  configure(options: Record<string, unknown>): void;
  enter(): Promise<unknown>;
  leave(): Promise<unknown>;
  select(element: Element): Record<string, unknown> | null;
  setSelecting(enabled: boolean): void;
  previewChanges(changes: Record<string, unknown>[]): void;
  saveAnnotation(annotation: Record<string, unknown>): void;
  undo(): void;
  redo(): void;
  persist(): Promise<unknown>;
  state(): {
    selecting: boolean;
    selectionId: number;
    selected: { element: Element; target: Record<string, unknown> } | null;
    session: { updatedAt: string; annotations: Record<string, unknown>[] };
    historyLength: number;
    futureLength: number;
  };
}

function draft() {
  return {
    version: 1,
    id: '3f375327-003d-4d2f-822e-27dc3c19362d',
    status: 'draft',
    project: { entrypoint: 'src/server.ts', toolName: 'open_ordering' },
    viewport: { width: 820, height: 640, device: 'desktop', theme: 'dark' },
    createdAt: '2026-07-29T10:00:00.000Z',
    updatedAt: '2026-07-29T10:00:00.000Z',
    annotations: [],
  };
}

describe('devtools reversible Design state', () => {
  it('intercepts widget actions and supports save, undo, redo, persistence, and restore', async () => {
    const shell = new Window({ url: 'http://127.0.0.1:8789/' });
    const widget = new Window({ url: 'http://127.0.0.1:8789/widget' });
    widget.document.body.innerHTML =
      '<button id="search" aria-label="Search stores"><span>Search stores</span></button>';
    const button = widget.document.querySelector('button');
    const buttonLabel = widget.document.querySelector('button span');
    if (!button) throw new Error('fixture button missing');
    if (!buttonLabel) throw new Error('fixture button label missing');

    let actions = 0;
    button.addEventListener('click', () => actions++);
    let persisted = draft();
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.startsWith('/design/session?')) {
        return new Response(JSON.stringify({ ok: true, session: persisted }), { status: 200 });
      }
      if (input === '/design/session' && init?.method === 'PUT') {
        persisted = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ ok: true, session: persisted }), { status: 200 });
      }
      throw new Error(`unexpected request: ${input}`);
    });
    (shell as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    shell.eval(DEVTOOLS_DESIGN_ELEMENT_CLIENT_JS);
    shell.eval(DEVTOOLS_DESIGN_PREVIEW_CLIENT_JS);
    const client = (shell as unknown as { NoodleDesign: DesignClient }).NoodleDesign;
    client.configure({
      frame: { contentDocument: widget.document },
      getContext: () => ({
        toolName: 'open_ordering',
        width: 820,
        height: 640,
        device: 'desktop',
        theme: 'dark',
      }),
      onChange: () => {},
      onStatus: () => {},
    });

    await client.enter();
    expect(client.state().selecting).toBe(false);

    button.dispatchEvent(new widget.MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(actions).toBe(1);
    expect(client.state().selected).toBeNull();
    expect(widget.document.getElementById('noodle-design-overlay')?.style.display).toBe('none');

    client.setSelecting(true);
    expect(client.state().selecting).toBe(true);
    expect(widget.document.documentElement.style.cursor).toContain('data:image/svg+xml');
    buttonLabel.dispatchEvent(new widget.MouseEvent('mousemove', { bubbles: true }));
    const hoverOverlay = widget.document.getElementById('noodle-design-overlay');
    expect(hoverOverlay?.dataset.state).toBe('hover');
    expect(hoverOverlay?.textContent).toContain('button');
    expect(hoverOverlay?.parentElement).toBe(widget.document.body);
    expect(hoverOverlay?.style.top).toBe('0px');
    expect(hoverOverlay?.style.left).toBe('0px');

    buttonLabel.dispatchEvent(new widget.MouseEvent('pointerover', { bubbles: true }));
    expect(widget.document.getElementById('noodle-design-overlay')?.dataset.state).toBe('hover');
    expect(widget.document.getElementById('noodle-design-overlay')?.textContent).toContain(
      'button',
    );

    buttonLabel.dispatchEvent(new widget.MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(actions).toBe(1);
    expect(client.state().selected?.target).toMatchObject({
      tagName: 'button',
      accessibleName: 'Search stores',
    });
    expect(widget.document.getElementById('noodle-design-overlay')).toMatchObject({
      textContent: expect.stringContaining('button'),
    });
    expect(widget.document.getElementById('noodle-design-overlay')?.dataset.state).toBe('selected');
    expect(widget.document.getElementById('noodle-design-overlay')?.style.borderColor).toBe(
      '#f97316',
    );

    const target = client.state().selected?.target;
    if (!target) throw new Error('selection missing');
    client.previewChanges([
      {
        property: '--outside-design-contract',
        from: '',
        to: '#ff6b35',
      },
    ]);
    expect(widget.document.getElementById('noodle-design-draft-styles')).toBeNull();
    expect(button.hasAttribute('data-noodle-design-draft')).toBe(false);

    client.previewChanges([
      {
        property: 'background-color',
        from: 'buttonface',
        to: '#ff6b35',
      },
    ]);
    expect(widget.document.getElementById('noodle-design-draft-styles')?.textContent).toContain(
      'background-color:#ff6b35!important',
    );
    expect(button.getAttribute('data-noodle-design-draft')).toBe('true');

    client.saveAnnotation({
      id: 'annotation-1',
      intent: 'Make this action feel primary.',
      target,
      changes: [
        {
          property: 'background-color',
          from: 'buttonface',
          to: '#ff6b35',
        },
      ],
      acceptanceCriteria: [],
      preserve: [],
    });
    expect(client.state().session.annotations).toHaveLength(1);
    expect(client.state().selected).toBeNull();
    expect(client.state().selecting).toBe(true);
    expect(widget.document.getElementById('noodle-design-preview-styles')?.textContent).toContain(
      'background-color:#ff6b35!important',
    );
    expect(widget.document.getElementById('noodle-design-draft-styles')).toBeNull();
    expect(button.hasAttribute('data-noodle-design-draft')).toBe(false);

    client.undo();
    expect(client.state().session.annotations).toHaveLength(0);
    client.redo();
    expect(client.state().session.annotations).toHaveLength(1);
    await client.persist();
    expect(fetchMock).toHaveBeenCalledWith(
      '/design/session',
      expect.objectContaining({ method: 'PUT' }),
    );

    await client.leave();
    button.dispatchEvent(new widget.MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(actions).toBe(2);
  });

  it('restores the server-confirmed timestamp after a failed save so retry uses the same precondition', async () => {
    const shell = new Window({ url: 'http://127.0.0.1:8789/' });
    const widget = new Window({ url: 'http://127.0.0.1:8789/widget' });
    widget.document.body.innerHTML = '<button id="search">Search stores</button>';
    const button = widget.document.querySelector('button');
    if (!button) throw new Error('fixture button missing');

    const serverDraft = draft();
    const preconditions: string[] = [];
    let putAttempts = 0;
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.startsWith('/design/session?')) {
        return new Response(JSON.stringify({ ok: true, session: serverDraft }), { status: 200 });
      }
      if (input === '/design/session' && init?.method === 'PUT') {
        preconditions.push(new Headers(init.headers).get('if-unmodified-since') ?? '');
        putAttempts++;
        if (putAttempts === 1) {
          return new Response(
            JSON.stringify({
              ok: false,
              error: { code: 'design_conflict', message: 'The design draft changed.' },
            }),
            { status: 409 },
          );
        }
        const persisted = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ ok: true, session: persisted }), { status: 200 });
      }
      throw new Error(`unexpected request: ${input}`);
    });
    (shell as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    shell.eval(DEVTOOLS_DESIGN_ELEMENT_CLIENT_JS);
    shell.eval(DEVTOOLS_DESIGN_PREVIEW_CLIENT_JS);
    const client = (shell as unknown as { NoodleDesign: DesignClient }).NoodleDesign;
    client.configure({
      frame: { contentDocument: widget.document },
      getContext: () => ({
        toolName: 'open_ordering',
        width: 820,
        height: 640,
        device: 'desktop',
        theme: 'dark',
      }),
      onChange: () => {},
      onStatus: () => {},
    });

    await client.enter();
    const target = client.select(button);
    if (!target) throw new Error('selection missing');
    client.saveAnnotation({
      id: 'annotation-retry',
      intent: 'Make this easier to spot.',
      target,
      changes: [],
      acceptanceCriteria: [],
      preserve: [],
    });

    await expect(client.persist()).rejects.toThrow('The design draft changed.');
    expect(client.state().session.updatedAt).toBe(serverDraft.updatedAt);
    await client.persist();
    expect(preconditions).toEqual([serverDraft.updatedAt, serverDraft.updatedAt]);
  });

  it('assigns a unique identity to each selection even when fingerprints share visible fallbacks', async () => {
    const shell = new Window({ url: 'http://127.0.0.1:8789/' });
    const widget = new Window({ url: 'http://127.0.0.1:8789/widget' });
    widget.document.body.innerHTML = '<div>Same label</div><div>Same label</div>';
    const elements = widget.document.querySelectorAll('div');

    (shell as unknown as { fetch: typeof fetch }).fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ ok: true, session: draft() }), { status: 200 });
    }) as unknown as typeof fetch;
    shell.eval(DEVTOOLS_DESIGN_ELEMENT_CLIENT_JS);
    shell.eval(DEVTOOLS_DESIGN_PREVIEW_CLIENT_JS);
    const client = (shell as unknown as { NoodleDesign: DesignClient }).NoodleDesign;
    client.configure({
      frame: { contentDocument: widget.document },
      getContext: () => ({
        toolName: 'open_ordering',
        width: 820,
        height: 640,
        device: 'desktop',
        theme: 'dark',
      }),
      onChange: () => {},
      onStatus: () => {},
    });

    await client.enter();
    client.select(elements[0]);
    const first = client.state().selectionId;
    client.select(elements[1]);
    expect(client.state().selectionId).toBeGreaterThan(first);
  });
});
