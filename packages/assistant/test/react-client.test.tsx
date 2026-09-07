// @vitest-environment happy-dom
import { act, StrictMode, Suspense, startTransition, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type UseNoodleAssistantResult, useNoodleAssistant } from '../src/react-client.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function sessionResponse(token = 'session-token'): Response {
  return Response.json({
    token,
    expiresAt: '2030-01-01T00:00:00Z',
    endpoints: {
      turns: 'https://cloud.example/v1/assistant/turns',
      toolConfirmations: 'https://cloud.example/v1/assistant/tool-confirmations',
      interactions: 'https://cloud.example/v1/assistant/interactions',
    },
  });
}

function eventStream(...frames: readonly string[]): Response {
  return new Response(`${frames.join('\n\n')}\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

let root: Root | undefined;
let current: UseNoodleAssistantResult | undefined;

function Probe({
  endpoint = '/api/assistant/session',
  fetch,
  locale,
  account,
  modelState,
  principalKey = 'principal-1',
  suspend = false,
}: {
  readonly endpoint?: string;
  readonly fetch: typeof globalThis.fetch;
  readonly locale?: string;
  readonly account?: string;
  readonly modelState?: string;
  readonly principalKey?: string;
  readonly suspend?: boolean;
}) {
  const next = useNoodleAssistant({
    sessionEndpoint: endpoint,
    fetch,
    principalKey,
    ...(locale ? { clientContext: () => ({ locale }) } : {}),
    ...(account ? { pageContext: { account } } : {}),
    ...(modelState ? { modelContext: { structuredContent: { state: modelState } } } : {}),
  });
  if (suspend) throw new Promise<never>(() => {});
  current = next;
  return (
    <output data-status={current.status}>
      {current.messages
        .flatMap((message) =>
          message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])),
        )
        .join('|')}
    </output>
  );
}

function StrictModeFirstTurnProbe({ fetch }: { readonly fetch: typeof globalThis.fetch }) {
  const next = useNoodleAssistant({
    sessionEndpoint: '/api/assistant/session',
    fetch,
    principalKey: 'principal-1',
  });
  current = next;
  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      void next.client.sendMessage('Open my workspace').catch(() => {
        // The hook exposes the same structured failure through `error`.
      });
    });
    return () => {
      active = false;
    };
  }, [next.client]);
  return <output data-status={next.status}>{next.messages.length}</output>;
}

function result(): UseNoodleAssistantResult {
  if (!current) throw new Error('hook probe has not rendered');
  return current;
}

async function renderProbe(
  fetch: typeof globalThis.fetch,
  endpoint = '/api/assistant/session',
  strict = false,
): Promise<HTMLDivElement> {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      strict ? (
        <StrictMode>
          <Probe endpoint={endpoint} fetch={fetch} />
        </StrictMode>
      ) : (
        <Probe endpoint={endpoint} fetch={fetch} />
      ),
    );
  });
  return host;
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  current = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('useNoodleAssistant', () => {
  it('starts from detached ready state without fetching or registering the managed element', async () => {
    const fetchMock = vi.fn<typeof fetch>();

    await renderProbe(fetchMock);

    expect(result()).toMatchObject({ status: 'ready', messages: [] });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(customElements.get('noodle-assistant')).toBeUndefined();
  });

  it('keeps one client across rerenders and publishes streamed UIMessage state', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(
        eventStream(
          'event: content\ndata: {"delta":"Hello"}',
          'event: content\ndata: {"delta":" there"}',
          'event: done\ndata: {}',
        ),
      );
    const host = await renderProbe(fetchMock, '/api/assistant/session', true);
    const client = result().client;

    await act(async () => {
      await result().client.sendMessage('Hi');
    });
    await act(async () => {
      root?.render(
        <StrictMode>
          <Probe endpoint="/api/assistant/session" fetch={fetchMock} />
        </StrictMode>,
      );
    });

    expect(result().client).toBe(client);
    expect(result()).toMatchObject({
      status: 'ready',
      messages: [
        { role: 'user', parts: [{ type: 'text', text: 'Hi' }] },
        { role: 'assistant', parts: [{ type: 'text', text: 'Hello there', state: 'done' }] },
      ],
    });
    expect(host.textContent).toContain('Hi|Hello there');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(consoleError.mock.calls.flat().join('\n')).not.toMatch(
      /getSnapshot should be cached|maximum update depth/i,
    );
  });

  it('sends one cleanup-aware first turn after the stable Strict Mode mount', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(eventStream('event: done\ndata: {}'));
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(
        <StrictMode>
          <StrictModeFirstTurnProbe fetch={fetchMock} />
        </StrictMode>,
      );
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(result().messages.filter((message) => message.role === 'user')).toHaveLength(1);
    expect(result().messages[0]?.parts).toEqual([{ type: 'text', text: 'Open my workspace' }]);
  });

  it('resumes confirmations without fabricating a user transcript message', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(
        eventStream(
          'event: tool_proposed\ndata: {"id":"int_1","tool":"create_leave","title":"Book leave","arguments":{"days":2}}',
          'event: done\ndata: {}',
        ),
      )
      .mockResolvedValueOnce(
        eventStream(
          'event: interaction_resolved\ndata: {"id":"int_1","action":"accept"}',
          'event: content\ndata: {"delta":"Your leave is booked."}',
          'event: done\ndata: {}',
        ),
      );
    await renderProbe(fetchMock);

    await act(async () => {
      await result().client.sendMessage('Book two days off');
    });
    await act(async () => {
      await result().client.respond('int_1', { action: 'accept' });
    });

    expect(result().messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'assistant',
    ]);
    expect(result().messages[1]?.parts).toContainEqual(
      expect.objectContaining({
        type: 'data-confirmation',
        id: 'int_1',
        data: expect.objectContaining({ status: 'accepted' }),
      }),
    );
    expect(result().messages[2]?.parts).toEqual([
      { type: 'text', text: 'Your leave is booked.', state: 'done' },
    ]);
  });

  it('uses fresh turn context across rerenders without replacing the client or transcript', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(eventStream('event: done\ndata: {}'))
      .mockResolvedValueOnce(eventStream('event: done\ndata: {}'));
    await renderProbe(fetchMock);

    await act(async () => {
      root?.render(
        <Probe fetch={fetchMock} locale="en-US" account="account-1" modelState="mounted" />,
      );
    });
    const client = result().client;
    await act(async () => client.sendMessage('First'));

    await act(async () => {
      root?.render(
        <Probe fetch={fetchMock} locale="fr-FR" account="account-2" modelState="submitted" />,
      );
    });
    await act(async () => client.sendMessage('Second'));

    expect(result().client).toBe(client);
    expect(result().messages.filter((message) => message.role === 'user')).toHaveLength(2);
    const turnBodies = fetchMock.mock.calls
      .slice(1)
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(turnBodies).toEqual([
      expect.objectContaining({
        message: 'First',
        clientContext: { locale: 'en-US' },
        pageContext: { account: 'account-1' },
        modelContext: { structuredContent: { state: 'mounted' } },
      }),
      expect.objectContaining({
        message: 'Second',
        clientContext: { locale: 'fr-FR' },
        pageContext: { account: 'account-2' },
        modelContext: { structuredContent: { state: 'submitted' } },
      }),
    ]);
  });

  it('does not expose options from an abandoned concurrent render to the committed client', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(eventStream('event: done\ndata: {}'));
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <Suspense fallback={<span>Loading</span>}>
          <Probe fetch={fetchMock} locale="en-US" />
        </Suspense>,
      );
    });
    const client = result().client;

    await act(async () => {
      startTransition(() => {
        root?.render(
          <Suspense fallback={<span>Loading</span>}>
            <Probe fetch={fetchMock} locale="private-uncommitted-locale" suspend />
          </Suspense>,
        );
      });
    });
    await act(async () => client.sendMessage('Use committed context'));

    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      clientContext: { locale: 'en-US' },
    });
  });

  it('drops the previous identity-bound session when the principal key changes', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionResponse('principal-1-token'))
      .mockResolvedValueOnce(eventStream('event: done\ndata: {}'))
      .mockResolvedValueOnce(sessionResponse('principal-2-token'))
      .mockResolvedValueOnce(eventStream('event: done\ndata: {}'));
    const host = await renderProbe(fetchMock);
    await act(async () => result().client.sendMessage('First principal'));
    const first = result().client;
    const resetFirst = vi.spyOn(first, 'resetSession');

    await act(async () => {
      root?.render(<Probe fetch={fetchMock} principalKey="principal-2" />);
    });
    expect(host.textContent).toBe('');
    expect(result().client).not.toBe(first);
    expect(resetFirst).toHaveBeenCalledOnce();
    await act(async () => result().client.sendMessage('Second principal'));

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer principal-1-token',
    });
    expect(fetchMock.mock.calls[3]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer principal-2-token',
    });
  });

  it('aborts an in-flight turn when the injected fetch identity changes', async () => {
    let turnSignal: AbortSignal | undefined;
    const firstFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionResponse())
      .mockImplementationOnce(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            turnSignal = init?.signal ?? undefined;
            turnSignal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          }),
      );
    const secondFetch = vi.fn<typeof fetch>();
    await renderProbe(firstFetch);
    const first = result().client;
    let pending: Promise<void> | undefined;
    await act(async () => {
      pending = first.sendMessage('Wait');
      await vi.waitFor(() => expect(turnSignal).toBeDefined());
    });
    const rejection = expect(pending).rejects.toMatchObject({
      detail: { code: 'request_aborted' },
    });

    await act(async () => {
      root?.render(<Probe fetch={secondFetch} />);
    });

    expect(result().client).not.toBe(first);
    expect(turnSignal?.aborted).toBe(true);
    await rejection;
    expect(secondFetch).not.toHaveBeenCalled();
  });

  it('replaces and aborts its client when the endpoint changes, then aborts on unmount', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    await renderProbe(fetchMock);
    const first = result().client;
    const firstAbort = vi.spyOn(first, 'abort');

    await act(async () => {
      root?.render(<Probe endpoint="/api/assistant/other-session" fetch={fetchMock} />);
    });

    const second = result().client;
    expect(second).not.toBe(first);
    expect(result()).toMatchObject({ status: 'ready', messages: [] });
    expect(firstAbort).toHaveBeenCalledOnce();

    const secondAbort = vi.spyOn(second, 'abort');
    await act(async () => root?.unmount());
    root = undefined;
    expect(secondAbort).toHaveBeenCalledOnce();
  });
});
