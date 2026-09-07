// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_APPEARANCE, resolveAppearance } from '../src/appearance.js';
import {
  ASSISTANT_TAG_NAME,
  NoodleAssistantElement,
  registerNoodleAssistant,
} from '../src/index.js';

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('Noodle assistant element', () => {
  it('mounts closed with a usable launcher that opens the same assistant panel', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          token: 'session-token',
          expiresAt: '2030-01-01T00:00:00Z',
          endpoints: { turns: '/turns', toolConfirmations: '/confirmations' },
        }),
      ),
    );
    const element = new NoodleAssistantElement();
    element.sessionEndpoint = '/api/assistant/session';
    document.body.append(element);
    await vi.waitFor(() => expect(element.hasAttribute('data-presentation-ready')).toBe(true));

    const launcher = element.shadowRoot?.querySelector<HTMLButtonElement>('.launcher-trigger');
    const launcherForm = element.shadowRoot?.querySelector<HTMLFormElement>('.launcher-form');
    expect(launcher).toBeTruthy();
    expect(element.hasAttribute('open')).toBe(false);
    expect(launcher?.hidden).toBe(false);
    expect(launcher?.getAttribute('aria-controls')).toBe('assistant-launcher-form');
    expect(launcher?.getAttribute('aria-expanded')).toBe('false');

    launcher?.click();
    expect(element.hasAttribute('launcher-expanded')).toBe(true);
    expect(element.hasAttribute('open')).toBe(false);
    expect(launcher?.getAttribute('aria-expanded')).toBe('true');

    launcherForm?.requestSubmit();
    expect(element.hasAttribute('open')).toBe(true);
    expect(launcher?.getAttribute('aria-expanded')).toBe('false');
    expect(launcher?.getAttribute('aria-busy')).toBe('false');

    await vi.waitFor(() => {
      expect(element.hasAttribute('data-presentation-ready')).toBe(true);
      expect(launcher?.getAttribute('aria-expanded')).toBe('false');
      expect(element.shadowRoot?.activeElement).toBe(element.shadowRoot?.querySelector('textarea'));
    });

    element.removeAttribute('open');
    expect(launcher?.getAttribute('aria-expanded')).toBe('false');
    element.setAttribute('open', '');
    expect(launcher?.getAttribute('aria-expanded')).toBe('false');
    element.shadowRoot?.querySelector<HTMLButtonElement>('.close')?.click();
    expect(launcher?.getAttribute('aria-expanded')).toBe('false');
    expect(element.shadowRoot?.activeElement).toBe(launcher);
  });

  it('does not restore a stale bootstrap session after reset', async () => {
    let resolveSession!: (response: Response) => void;
    let bodyRead = false;
    const pendingSession = new Promise<Response>((resolve) => {
      resolveSession = resolve;
    });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockReturnValue(pendingSession));
    const element = new NoodleAssistantElement();
    element.sessionEndpoint = '/api/assistant/session';
    const sessionStarted = vi.fn();
    element.addEventListener('assistant-session-started', sessionStarted);
    document.body.append(element);

    expect(element.dataset.sessionState).toBe('loading');
    element.resetSession();
    expect(element.dataset.sessionState).toBe('idle');

    resolveSession({
      ok: true,
      status: 200,
      json: async () => {
        bodyRead = true;
        return {
          token: 'stale-session',
          expiresAt: '2030-01-01T00:00:00Z',
          endpoints: { turns: '/turns', toolConfirmations: '/confirmations' },
          configuration: { branding: { name: 'Stale Assistant' } },
        };
      },
    } as Response);
    await vi.waitFor(() => expect(bodyRead).toBe(true));
    await Promise.resolve();

    expect(element.dataset.sessionState).toBe('idle');
    expect(element.shadowRoot?.textContent).not.toContain('Stale Assistant');
    expect(sessionStarted).not.toHaveBeenCalled();
  });

  it('drops late stream content when reset interrupts an active turn', async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          token: 'session-token',
          expiresAt: '2030-01-01T00:00:00Z',
          endpoints: { turns: '/turns', toolConfirmations: '/confirmations' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const element = new NoodleAssistantElement();
    element.sessionEndpoint = '/api/assistant/session';
    document.body.append(element);

    const turn = element.sendMessage('Message before reset');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    element.resetSession();
    stream.enqueue(new TextEncoder().encode('event: content\ndata: {"delta":"Late reply"}\n\n'));
    stream.close();
    await turn;

    expect(element.shadowRoot?.querySelectorAll('.message')).toHaveLength(0);
    expect(element.shadowRoot?.textContent).not.toContain('Late reply');
    expect(element.hasAttribute('busy')).toBe(false);
  });

  it('applies server-authored startOpen once the bootstrap configuration arrives', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          token: 'session-token',
          expiresAt: '2030-01-01T00:00:00Z',
          endpoints: { turns: '/turns', toolConfirmations: '/confirmations' },
          configuration: { assistant: { behavior: { startOpen: true } } },
        }),
      ),
    );
    const element = new NoodleAssistantElement();
    element.sessionEndpoint = '/api/assistant/session';
    document.body.append(element);

    await vi.waitFor(() => expect(element.dataset.sessionState).toBe('ready'));
    expect(element.hasAttribute('open')).toBe(true);
  });

  it('drops late confirmation narration when reset interrupts confirmation streaming', async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          token: 'session-token',
          expiresAt: '2030-01-01T00:00:00Z',
          endpoints: { turns: '/turns', toolConfirmations: '/confirmations' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const element = new NoodleAssistantElement();
    element.sessionEndpoint = '/api/assistant/session';
    const completed = vi.fn();
    element.addEventListener('assistant-tool-completed', completed);
    document.body.append(element);
    await vi.waitFor(() => expect(element.dataset.sessionState).toBe('ready'));

    const confirmation = element.confirmTool('confirm_1');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    element.resetSession();
    stream.enqueue(
      new TextEncoder().encode(
        'event: tool_completed\ndata: {"result":{"updated":true}}\n\nevent: content\ndata: {"delta":"Late confirmation"}\n\n',
      ),
    );
    stream.close();
    await confirmation;

    expect(element.shadowRoot?.querySelectorAll('.message')).toHaveLength(0);
    expect(element.shadowRoot?.textContent).not.toContain('Late confirmation');
    expect(completed).not.toHaveBeenCalled();
  });

  it('ships complete customer-neutral light and dark defaults', () => {
    expect(DEFAULT_APPEARANCE.theme.defaultMode).toBe('auto');
    expect(DEFAULT_APPEARANCE.theme.light.panel).toMatch(/^#/);
    expect(DEFAULT_APPEARANCE.theme.dark.panel).toMatch(/^#/);
    expect(DEFAULT_APPEARANCE.labels.composerPlaceholder).toBeTruthy();
    expect(JSON.stringify(DEFAULT_APPEARANCE)).not.toContain('Noodle');
  });

  it('derives both assistant themes from the shared server brand kit', () => {
    const appearance = resolveAppearance({
      branding: {
        name: 'Acme Assistant',
        accent: '#112233',
        surfaceDark: '#010203',
        theme: { dark: { accent: '#AABBCC' } },
      },
    });
    expect(appearance.brand.name).toBe('Acme Assistant');
    expect(appearance.theme.light.accent).toBe('#112233');
    expect(appearance.theme.light.panel).toBe(DEFAULT_APPEARANCE.theme.light.panel);
    expect(appearance.theme.dark.accent).toBe('#AABBCC');
    expect(appearance.theme.dark.panel).toBe('#010203');
  });

  it('derives a contrast-safe accent foreground unless branding supplies one', () => {
    const bright = resolveAppearance({ branding: { accent: '#FFF000' } });
    expect(bright.theme.light.accentText).toBe('#09090B');
    expect(bright.theme.dark.accentText).toBe('#09090B');

    const explicit = resolveAppearance({
      branding: { theme: { light: { accent: '#FFF000', accentText: '#123456' } } },
    });
    expect(explicit.theme.light.accentText).toBe('#123456');
  });

  it('applies session-provided branding in place without replacing the chat container', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            token: 'session-token',
            expiresAt: '2030-01-01T00:00:00Z',
            endpoints: {
              turns: '/v1/assistant/turns',
              toolConfirmations: '/v1/assistant/tool-confirmations',
            },
            configuration: {
              branding: {
                name: 'Acme Assistant',
                accent: '#AABBCC',
                surfaceDark: '#010203',
                colorScheme: 'dark',
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(new Response('event: done\ndata: {}\n\n', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    registerNoodleAssistant();
    expect(customElements.get(ASSISTANT_TAG_NAME)).toBe(NoodleAssistantElement);
    const element = document.createElement(ASSISTANT_TAG_NAME) as NoodleAssistantElement;
    element.sessionEndpoint = '/api/assistant/session';
    document.body.append(element);
    const panel = element.shadowRoot?.querySelector('.panel');
    const messagesBeforeSession = element.shadowRoot?.querySelector('.messages');
    await element.sendMessage('Hello');

    expect(element.shadowRoot?.querySelector('.panel')).toBe(panel);
    expect(element.shadowRoot?.querySelector('.messages')).toBe(messagesBeforeSession);
    expect(element.shadowRoot?.textContent).toContain('Acme Assistant');
    expect(element.shadowRoot?.querySelector('header strong')?.textContent).toBe('Acme Assistant');
    expect(element.shadowRoot?.querySelector('.powered-by-name')?.textContent).toBe('Noodle Seed');
    expect(element.style.getPropertyValue('--ns-assistant-default-accent')).toBe('#AABBCC');
    expect(element.getAttribute('data-theme')).toBe('dark');

    element.open();
    expect(element.hasAttribute('open')).toBe(true);
    const messages = element.shadowRoot?.querySelector('.messages');
    element.setAttribute('theme', 'light');
    expect(element.shadowRoot?.querySelector('.messages')).toBe(messages);
    expect(element.getAttribute('data-theme')).toBe('light');
    element.close();
    expect(element.hasAttribute('open')).toBe(false);
  });

  it('keeps the returned session token in memory and sends it only as a bearer header', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            token: 'opaque-session-token',
            expiresAt: '2030-01-01T00:00:00Z',
            endpoints: {
              turns: '/v1/assistant/turns',
              toolConfirmations: '/v1/assistant/tool-confirmations',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response('event: content\ndata: {"delta":"Hello"}\n\nevent: done\ndata: {}\n\n', {
          status: 200,
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const element = new NoodleAssistantElement();
    element.sessionEndpoint = '/api/assistant/session';
    document.body.append(element);
    await element.sendMessage('Hello');

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/v1/assistant/turns',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer opaque-session-token' }),
      }),
    );
    expect(document.documentElement.innerHTML).not.toContain('opaque-session-token');
    expect(sessionStorage.length).toBe(0);
    expect(localStorage.length).toBe(0);
  });

  it('renders sanitized GitHub-flavored Markdown only for assistant responses', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          token: 'session-token',
          expiresAt: '2030-01-01T00:00:00Z',
          endpoints: { turns: '/turns', toolConfirmations: '/confirmations' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          'event: content\ndata: {"delta":"**Bold** and `code`\\n\\n- one\\n- two\\n\\n<script>alert(1)</script>"}\n\nevent: done\ndata: {}\n\n',
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const element = new NoodleAssistantElement();
    element.sessionEndpoint = '/api/assistant/session';
    document.body.append(element);
    await element.sendMessage('Show **literal user markdown**');

    const assistant = element.shadowRoot?.querySelector('.message.assistant .markdown');
    const user = element.shadowRoot?.querySelector('.message.user');
    expect(assistant?.querySelector('strong')?.textContent).toBe('Bold');
    expect(assistant?.querySelector('code')?.textContent).toBe('code');
    expect(assistant?.querySelectorAll('li')).toHaveLength(2);
    expect(assistant?.querySelector('script')).toBeNull();
    expect(assistant?.textContent).not.toContain('alert(1)');
    expect(user?.querySelector('strong')).toBeNull();
    expect(user?.textContent).toContain('**literal user markdown**');
  });

  it('sends on Enter and preserves Shift+Enter for a newline', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          token: 'prefetched-session',
          expiresAt: '2030-01-01T00:00:00Z',
          endpoints: { turns: '/turns', toolConfirmations: '/confirmations' },
        }),
      ),
    );
    const element = new NoodleAssistantElement();
    element.sessionEndpoint = '/api/assistant/session';
    document.body.append(element);
    const send = vi.spyOn(element, 'sendMessage').mockResolvedValue();
    const textarea = element.shadowRoot?.querySelector('textarea');
    if (!textarea) throw new Error('missing composer');

    textarea.value = 'Hello from Enter';
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(send).toHaveBeenCalledWith('Hello from Enter');

    send.mockClear();
    textarea.value = 'First line';
    textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }),
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps a composer draft while streaming and turns send into a safe stop action', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          token: 'session-token',
          expiresAt: '2030-01-01T00:00:00Z',
          endpoints: { turns: '/turns', toolConfirmations: '/confirmations' },
        }),
      )
      .mockImplementationOnce(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('Stopped', 'AbortError')),
            );
          }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const element = new NoodleAssistantElement();
    element.sessionEndpoint = '/api/assistant/session';
    document.body.append(element);

    const pending = element.sendMessage('Start a long answer');
    await vi.waitFor(() => expect(element.hasAttribute('busy')).toBe(true));
    const textarea = element.shadowRoot?.querySelector<HTMLTextAreaElement>('textarea');
    const send = element.shadowRoot?.querySelector<HTMLButtonElement>('.send');
    expect(textarea?.disabled).toBe(false);
    expect(send?.getAttribute('aria-label')).toBe('Stop');
    if (textarea) textarea.value = 'Keep this draft';

    element.stop();
    await pending;

    expect(textarea?.value).toBe('Keep this draft');
    expect(element.hasAttribute('busy')).toBe(false);
    expect(send?.getAttribute('aria-label')).toBe('Send');
    expect(element.shadowRoot?.textContent).toContain('Stopped');
  });

  it('forwards replace-in-place model context without starting a turn', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          token: 'session-token',
          expiresAt: '2030-01-01T00:00:00Z',
          endpoints: {
            turns: '/v1/assistant/turns',
            toolConfirmations: '/v1/assistant/tool-confirmations',
          },
        }),
      )
      .mockResolvedValueOnce(new Response('event: done\ndata: {}\n\n'));
    vi.stubGlobal('fetch', fetchMock);
    const element = new NoodleAssistantElement();
    element.sessionEndpoint = '/api/assistant/session';
    document.body.append(element);

    element.updateModelContext({
      structuredContent: { widget: { name: 'leave-form', lifecycle: 'mounted' } },
    });
    // The element eagerly exchanges its session so server-authored presentation is stable before
    // the first turn; replacing model context must not start an additional request.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await element.sendMessage('Can you see the form?');

    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      message: 'Can you see the form?',
      clientContext: expect.any(Object),
      modelContext: {
        structuredContent: { widget: { name: 'leave-form', lifecycle: 'mounted' } },
      },
    });
  });

  it('renders a native confirmation card and executes it through the single-use confirmation route', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            token: 'session-token',
            expiresAt: '2030-01-01T00:00:00Z',
            endpoints: {
              turns: 'https://cloud.example/v1/assistant/turns',
              toolConfirmations: 'https://cloud.example/v1/assistant/tool-confirmations',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          'event: tool_proposed\ndata: {"id":"confirm_1","tool":"update_account","requiresConfirmation":true}\n\nevent: done\ndata: {}\n\n',
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          'event: tool_completed\ndata: {"id":"confirm_1","tool":"update_account","result":{"updated":"New name"}}\n\nevent: done\ndata: {}\n\n',
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const element = new NoodleAssistantElement();
    element.sessionEndpoint = '/api/assistant/session';
    document.body.append(element);
    await element.sendMessage('Change my name');
    expect(element.shadowRoot?.textContent).toContain('Update account');
    expect(element.shadowRoot?.textContent).toContain('Confirm');

    await element.confirmTool('confirm_1');
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'https://cloud.example/v1/assistant/tool-confirmations',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer session-token' }),
      }),
    );
    expect(element.shadowRoot?.textContent).toContain('New name');
  });

  it('omits technical confirmation details while preserving the native business review', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          token: 'session-token',
          expiresAt: '2030-01-01T00:00:00Z',
          endpoints: {
            turns: 'https://cloud.example/v1/assistant/turns',
            toolConfirmations: 'https://cloud.example/v1/assistant/tool-confirmations',
            interactions: 'https://cloud.example/v1/assistant/interactions',
          },
          configuration: {
            assistant: { behavior: { showConfirmationDetails: false } },
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          'event: tool_proposed\ndata: {"id":"confirm_1","tool":"complete_task","title":"Complete task","description":"Marks the selected task complete.","arguments":{"taskId":"task_123","action":{"connector":"tasks@1.0","operation":"complete"}}}\n\nevent: done\ndata: {}\n\n',
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const element = new NoodleAssistantElement();
    element.sessionEndpoint = '/api/assistant/session';
    document.body.append(element);

    await element.sendMessage('Complete the task');

    const text = element.shadowRoot?.textContent ?? '';
    expect(text).toContain('Complete task');
    expect(text).toContain('Marks the selected task complete.');
    expect(text).toContain('task_123');
    expect(text).toContain('Confirm');
    expect(text).toContain("Don't proceed");
    expect(text).not.toContain('Additional details');
    expect(text).not.toContain('tasks@1.0');
    expect(element.shadowRoot?.querySelector('.proposal-details')).toBeNull();
  });

  it('shows exact proposal arguments and resolves accept, decline, and cancel through interactions', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          token: 'session-token',
          expiresAt: '2030-01-01T00:00:00Z',
          endpoints: {
            turns: 'https://cloud.example/v1/assistant/turns',
            toolConfirmations: 'https://cloud.example/v1/assistant/tool-confirmations',
            interactions: 'https://cloud.example/v1/assistant/interactions',
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          'event: tool_proposed\ndata: {"id":"confirm_1","tool":"book_time_off","arguments":{"type":"VACATION","start":"2026-07-23","end":"2026-07-24"}}\n\nevent: done\ndata: {}\n\n',
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          'event: interaction_resolved\ndata: {"id":"confirm_1"}\n\nevent: done\ndata: {}\n\n',
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const element = new NoodleAssistantElement();
    element.sessionEndpoint = '/api/assistant/session';
    document.body.append(element);
    await element.sendMessage('Book it');

    const text = element.shadowRoot?.textContent ?? '';
    expect(text).toContain('VACATION');
    expect(text).toContain('2026-07-23');
    expect(text).toContain('2026-07-24');
    expect(
      [
        ...(element.shadowRoot?.querySelectorAll<HTMLButtonElement>('.proposal-actions button') ??
          []),
      ].map((button) => button.textContent),
    ).toEqual(['Confirm', "Don't proceed"]);

    await element.respond('confirm_1', { action: 'decline' });
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'https://cloud.example/v1/assistant/interactions',
      expect.objectContaining({ body: JSON.stringify({ id: 'confirm_1', action: 'decline' }) }),
    );

    expect(element.shadowRoot?.querySelector('.tool-proposal')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('renders schema-driven elicitation controls and submits structured input', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          token: 'session-token',
          expiresAt: '2030-01-01T00:00:00Z',
          endpoints: {
            turns: 'https://cloud.example/v1/assistant/turns',
            toolConfirmations: 'https://cloud.example/v1/assistant/tool-confirmations',
            interactions: 'https://cloud.example/v1/assistant/interactions',
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          'event: input_requested\ndata: {"id":"input_1","message":"Choose a team and start date","requestedSchema":{"type":"object","properties":{"teamId":{"type":"string","title":"Team","enum":["noodle","platform"]},"start":{"type":"string","title":"Start date","format":"date"},"notify":{"type":"boolean","title":"Notify my team"}},"required":["teamId","start","notify"]},"expiresAt":"2030-01-01T00:10:00Z"}\n\nevent: done\ndata: {}\n\n',
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          'event: interaction_resolved\ndata: {"id":"input_1","action":"accept"}\n\nevent: tool_completed\ndata: {"id":"input_1","tool":"book_time_off","result":{"ok":true}}\n\nevent: done\ndata: {}\n\n',
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const element = new NoodleAssistantElement();
    element.sessionEndpoint = '/api/assistant/session';
    document.body.append(element);

    await element.sendMessage('Book time off');

    const form = element.shadowRoot?.querySelector<HTMLFormElement>('.input-request form');
    const team = form?.querySelector<HTMLSelectElement>('[name="teamId"]');
    const start = form?.querySelector<HTMLInputElement>('[name="start"]');
    const notify = form?.querySelector<HTMLInputElement>('[name="notify"]');
    expect(form?.textContent).toContain('Choose a team and start date');
    expect(team?.tagName).toBe('SELECT');
    expect(start?.type).toBe('date');
    expect(notify?.type).toBe('checkbox');
    expect(notify?.required).toBe(false);
    if (!form || !team || !start || !notify) {
      throw new Error('elicitation form was not rendered');
    }
    team.value = 'platform';
    start.value = '2030-01-03';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'https://cloud.example/v1/assistant/interactions',
      expect.objectContaining({
        body: JSON.stringify({
          id: 'input_1',
          action: 'accept',
          content: { teamId: 'platform', start: '2030-01-03', notify: false },
        }),
      }),
    );
    await vi.waitFor(() => expect(element.shadowRoot?.querySelector('.input-request')).toBeNull());
  });

  it('applies elicitation defaults, titled choices, multi-selects, and RFC3339 date-times', async () => {
    const requestedSchema = {
      type: 'object',
      properties: {
        method: {
          type: 'string',
          title: 'Fulfilment method',
          oneOf: [
            { const: 'pickup', title: 'Pick up at the counter' },
            { const: 'delivery', title: 'Deliver to me' },
          ],
          default: 'delivery',
        },
        extras: {
          type: 'array',
          title: 'Extras',
          items: {
            anyOf: [
              { const: 'utensils', title: 'Include utensils' },
              { const: 'napkins', title: 'Extra napkins' },
            ],
          },
          default: ['utensils'],
        },
        guests: { type: 'integer', title: 'Guests', default: 3 },
        notify: { type: 'boolean', title: 'Notify me', default: true },
        startsAt: {
          type: 'string',
          title: 'Starts at',
          format: 'date-time',
          default: '2030-01-03T12:30:00Z',
        },
      },
      required: ['method', 'extras', 'guests', 'notify', 'startsAt'],
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          token: 'session-token',
          expiresAt: '2030-01-01T00:00:00Z',
          endpoints: {
            turns: 'https://cloud.example/v1/assistant/turns',
            toolConfirmations: 'https://cloud.example/v1/assistant/tool-confirmations',
            interactions: 'https://cloud.example/v1/assistant/interactions',
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          `event: input_requested\ndata: ${JSON.stringify({
            id: 'input_defaults',
            message: 'Choose delivery details',
            requestedSchema,
            expiresAt: '2030-01-01T00:10:00Z',
          })}\n\nevent: done\ndata: {}\n\n`,
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          'event: interaction_resolved\ndata: {"id":"input_defaults","action":"accept"}\n\nevent: done\ndata: {}\n\n',
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const element = new NoodleAssistantElement();
    element.sessionEndpoint = '/api/assistant/session';
    document.body.append(element);

    await element.sendMessage('Plan it');

    const form = element.shadowRoot?.querySelector<HTMLFormElement>('.input-request form');
    const method = form?.querySelector<HTMLSelectElement>('[name="method"]');
    const extras = form?.querySelector<HTMLSelectElement>('[name="extras"]');
    const guests = form?.querySelector<HTMLInputElement>('[name="guests"]');
    const notify = form?.querySelector<HTMLInputElement>('[name="notify"]');
    const startsAt = form?.querySelector<HTMLInputElement>('[name="startsAt"]');
    expect([...(method?.options ?? [])].map((item) => item.textContent)).toEqual([
      'Pick up at the counter',
      'Deliver to me',
    ]);
    expect(method?.value).toBe('delivery');
    expect(extras?.multiple).toBe(true);
    expect([...(extras?.options ?? [])].map((item) => [item.textContent, item.selected])).toEqual([
      ['Include utensils', true],
      ['Extra napkins', false],
    ]);
    expect(guests?.value).toBe('3');
    expect(notify?.checked).toBe(true);
    expect(notify?.required).toBe(false);
    expect(startsAt?.type).toBe('datetime-local');
    expect(startsAt?.value).not.toBe('');
    if (!form) throw new Error('elicitation form was not rendered');
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const request = fetchMock.mock.calls[2]?.[1];
    const body = JSON.parse(String(request?.body)) as {
      readonly content: Record<string, unknown>;
    };
    expect(body.content).toMatchObject({
      method: 'delivery',
      extras: ['utensils'],
      guests: 3,
      notify: true,
    });
    expect(body.content.startsAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(new Date(String(body.content.startsAt)).toISOString()).toBe(body.content.startsAt);
  });

  it('renders the narrated reply after a confirmation and suppresses the raw result JSON', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            token: 'session-token',
            expiresAt: '2030-01-01T00:00:00Z',
            endpoints: {
              turns: 'https://cloud.example/v1/assistant/turns',
              toolConfirmations: 'https://cloud.example/v1/assistant/tool-confirmations',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          'event: tool_proposed\ndata: {"id":"confirm_1","tool":"update_account","requiresConfirmation":true}\n\nevent: done\ndata: {}\n\n',
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          'event: tool_completed\ndata: {"id":"confirm_1","tool":"update_account","result":{"updated":"New name"}}\n\nevent: content\ndata: {"delta":"Done — your name"}\n\nevent: content\ndata: {"delta":" is now New name."}\n\nevent: done\ndata: {}\n\n',
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const element = new NoodleAssistantElement();
    element.sessionEndpoint = '/api/assistant/session';
    document.body.append(element);
    await element.sendMessage('Change my name');
    await element.confirmTool('confirm_1');
    const text = element.shadowRoot?.textContent ?? '';
    expect(text).toContain('Done — your name is now New name.');
    expect(text).not.toContain('{"updated"'); // narration replaces the raw JSON bubble
  });

  it('re-exchanges an expired session and retries a turn exactly once', async () => {
    const errors: string[] = [];
    const expired: string[] = [];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          token: 'expired-token',
          expiresAt: '2030-01-01T00:00:00Z',
          endpoints: {
            turns: 'https://cloud.example/v1/assistant/turns',
            toolConfirmations: 'https://cloud.example/v1/assistant/tool-confirmations',
          },
          configuration: { branding: { name: 'Acme Assistant' } },
        }),
      )
      .mockResolvedValueOnce(Response.json({ error: 'expired' }, { status: 401 }))
      .mockResolvedValueOnce(
        Response.json({
          token: 'fresh-token',
          expiresAt: '2030-01-01T00:00:00Z',
          endpoints: {
            turns: 'https://cloud.example/v1/assistant/turns',
            toolConfirmations: 'https://cloud.example/v1/assistant/tool-confirmations',
          },
          configuration: { branding: { name: 'Acme Assistant' } },
        }),
      )
      .mockResolvedValueOnce(
        new Response('event: content\ndata: {"delta":"Recovered"}\n\nevent: done\ndata: {}\n\n'),
      );
    vi.stubGlobal('fetch', fetchMock);
    const element = new NoodleAssistantElement();
    element.sessionEndpoint = '/api/assistant/session';
    element.addEventListener('assistant-session-expired', () => expired.push('expired'));
    element.addEventListener('assistant-error', (event) =>
      errors.push((event as CustomEvent<{ code: string }>).detail.code),
    );
    document.body.append(element);

    await element.sendMessage('Hello');

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(expired).toEqual(['expired']);
    expect(errors).toEqual([]);
    expect(element.shadowRoot?.textContent).toContain('Recovered');
    expect(element.shadowRoot?.textContent?.match(/Hello/g)).toHaveLength(1);
  });
});

describe('no exception escapes the element into the host page', () => {
  function sessionResponse(): Response {
    return new Response(
      JSON.stringify({
        token: 'session-token',
        expiresAt: '2030-01-01T00:00:00Z',
        endpoints: {
          turns: '/v1/assistant/turns',
          toolConfirmations: '/v1/assistant/tool-confirmations',
        },
        configuration: { assistant: { suggestedPrompts: ['Show my open tasks'] } },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }

  it('dispatches assistant-error instead of leaking a rejection when a suggested prompt turn fails', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValue(new Response('down', { status: 502 }));
    vi.stubGlobal('fetch', fetchMock);
    registerNoodleAssistant();
    const element = document.createElement(ASSISTANT_TAG_NAME) as NoodleAssistantElement;
    element.sessionEndpoint = '/api/assistant/session';
    document.body.append(element);

    const errors: unknown[] = [];
    element.addEventListener('assistant-error', (event) =>
      errors.push((event as CustomEvent).detail),
    );
    let prompt: HTMLButtonElement | null | undefined;
    await vi.waitFor(() => {
      prompt = element.shadowRoot?.querySelector<HTMLButtonElement>('.suggested-prompts button');
      expect(prompt?.textContent).toBe('Show my open tasks');
    });
    prompt?.click();
    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0));
    expect(errors[0]).toMatchObject({ code: 'turn_failed', status: 502 });
  });

  it('surfaces an HTML-with-200 turn response as invalid_response instead of an empty bubble', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(
        new Response('<!doctype html><html><body>Sign in</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    registerNoodleAssistant();
    const element = document.createElement(ASSISTANT_TAG_NAME) as NoodleAssistantElement;
    element.sessionEndpoint = '/api/assistant/session';
    document.body.append(element);
    const errors: unknown[] = [];
    element.addEventListener('assistant-error', (event) =>
      errors.push((event as CustomEvent).detail),
    );
    await expect(element.sendMessage('Hello')).rejects.toThrow();
    expect(errors[0]).toMatchObject({ code: 'invalid_response' });
  });

  it('shows busy during the auto-resume and settles when it completes', async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          token: 'elevated-token',
          expiresAt: '2030-01-01T00:00:00Z',
          endpoints: { turns: '/turns', toolConfirmations: '/confirmations' },
          resume: { tool: 'time_off_balance' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const element = new NoodleAssistantElement();
    element.sessionEndpoint = '/api/assistant/session';
    document.body.append(element);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(element.hasAttribute('busy')).toBe(true));
    stream.enqueue(
      new TextEncoder().encode('event: content\ndata: {"delta":"You have 12 days."}\n\n'),
    );
    stream.enqueue(new TextEncoder().encode('event: done\ndata: {}\n\n'));
    stream.close();

    await vi.waitFor(() => expect(element.hasAttribute('busy')).toBe(false));
    // The answer streamed in with no user bubble: the visitor already asked before signing in.
    expect(element.shadowRoot?.textContent).toContain('You have 12 days.');
    expect(element.shadowRoot?.querySelectorAll('.message.user')).toHaveLength(0);
  });

  it('fires assistant-ready exactly once per element lifetime, not per reconnect', () => {
    // Routers and portal libraries reparent nodes; integrators treating the event as
    // once-per-lifetime double-ran their setup on every DOM move. No session source: readiness
    // is about the shadow DOM and imperative API, not the session.
    const element = new NoodleAssistantElement();
    let fired = 0;
    element.addEventListener('assistant-ready', () => {
      fired += 1;
    });
    document.body.append(element);
    expect(fired).toBe(1);
    element.remove();
    document.body.append(element);
    expect(fired).toBe(1);
  });

  it('a sendMessage racing the eager exchange keeps one session and injects no error card', async () => {
    let resolveSession!: (response: Response) => void;
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveSession = resolve;
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const element = new NoodleAssistantElement();
    element.sessionEndpoint = '/api/assistant/session';
    const errors: unknown[] = [];
    element.addEventListener('assistant-error', (event) =>
      errors.push((event as CustomEvent).detail),
    );
    document.body.append(element);

    const turn = element.sendMessage('Hello while connecting');
    resolveSession(
      Response.json({
        token: 'session-token',
        expiresAt: '2030-01-01T00:00:00Z',
        endpoints: { turns: '/turns', toolConfirmations: '/confirmations' },
      }),
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    stream.enqueue(new TextEncoder().encode('event: done\ndata: {}\n\n'));
    stream.close();
    await turn;

    // Exactly one session exchange happened, and the transcript carries no recovery card.
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('session'))).toHaveLength(1);
    expect(element.shadowRoot?.querySelector('.conversation-error')).toBeNull();
    expect(errors).toHaveLength(0);
  });

  it('a concurrent second sendMessage rejects without touching the transcript or busy state', async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          token: 'session-token',
          expiresAt: '2030-01-01T00:00:00Z',
          endpoints: { turns: '/turns', toolConfirmations: '/confirmations' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const element = new NoodleAssistantElement();
    element.sessionEndpoint = '/api/assistant/session';
    document.body.append(element);

    const first = element.sendMessage('First message');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    // The refusal happens before any UI mutation: no second bubble, echo intact, busy stays on.
    await expect(element.sendMessage('Second message')).rejects.toMatchObject({
      detail: { code: 'request_in_progress', retryable: true },
    });
    const bubbles = [...(element.shadowRoot?.querySelectorAll('.message.user') ?? [])];
    expect(bubbles.map((bubble) => bubble.textContent)).toEqual(['First message']);
    expect(element.hasAttribute('busy')).toBe(true);
    expect(element.shadowRoot?.querySelector('.conversation-error')).toBeNull();

    stream.enqueue(new TextEncoder().encode('event: done\ndata: {}\n\n'));
    stream.close();
    await first;
    expect(element.hasAttribute('busy')).toBe(false);
  });
});
