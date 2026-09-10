import { beforeEach, describe, expect, it, vi } from 'vitest';

const guardedFetchMock = vi.hoisted(() => vi.fn());

vi.mock('../src/ssrf.js', () => ({ guardedFetch: guardedFetchMock }));

import { fetchResponseWithResilience } from '../src/http-response.js';

const ONE_MIB = 1024 * 1024;
const THREE_MIB = 3 * ONE_MIB;
const SIX_MIB = 6 * ONE_MIB;
const OBSERVED_ROUND_TRIP_BYTES = 4_960_533;
const readOperation = {
  signature: { type: 'read' as const },
  responseType: 'text' as const,
};
const target = new URL('https://api.example.com/large');

function textResponse(bytes: number, headers?: HeadersInit): Response {
  return new Response('x'.repeat(bytes), { status: 200, headers });
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

beforeEach(() => {
  guardedFetchMock.mockReset();
});

describe('HTTP response-size enforcement', () => {
  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    SIX_MIB + 1,
  ])('rejects invalid internal limit %s before outbound I/O', async (maxResponseBytes) => {
    const error = await captureError(
      fetchResponseWithResilience(target, { ...readOperation, maxResponseBytes }, {}, {}),
    );

    expect(error).toMatchObject({ category: 'invalid_response' });
    expect(guardedFetchMock).not.toHaveBeenCalled();
  });

  it('rejects a connector-wide fallback above 1 MiB without an operation-local grant', async () => {
    const error = await captureError(
      fetchResponseWithResilience(target, readOperation, {}, { maxBytes: SIX_MIB }),
    );

    expect(error).toMatchObject({ category: 'invalid_response' });
    expect(guardedFetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['default minus one', undefined, ONE_MIB - 1, true],
    ['default exact', undefined, ONE_MIB, true],
    ['default plus one', undefined, ONE_MIB + 1, false],
    ['configured minus one', SIX_MIB, SIX_MIB - 1, true],
    ['configured exact', SIX_MIB, SIX_MIB, true],
    ['configured plus one', SIX_MIB, SIX_MIB + 1, false],
  ] as const)('%s has an inclusive byte boundary', async (_label, maxResponseBytes, bytes, allowed) => {
    guardedFetchMock.mockResolvedValueOnce(textResponse(bytes));

    const result = fetchResponseWithResilience(
      target,
      maxResponseBytes === undefined ? readOperation : { ...readOperation, maxResponseBytes },
      {},
      {},
    );

    if (allowed) {
      expect((await result).body).toHaveLength(bytes);
    } else {
      await expect(captureError(result)).resolves.toMatchObject({
        category: 'response_too_large',
        retryable: false,
      });
    }
  });

  it.each([
    ['the former 3 MiB grant', THREE_MIB, false],
    ['the evidence-backed 6 MiB grant', SIX_MIB, true],
  ] as const)('%s handles the observed 4,960,533-byte response as expected', async (_label, maxResponseBytes, allowed) => {
    guardedFetchMock.mockResolvedValueOnce(textResponse(OBSERVED_ROUND_TRIP_BYTES));

    const result = fetchResponseWithResilience(
      target,
      { ...readOperation, maxResponseBytes },
      {},
      {},
    );

    if (allowed) {
      expect((await result).body).toHaveLength(OBSERVED_ROUND_TRIP_BYTES);
    } else {
      await expect(captureError(result)).resolves.toMatchObject({
        category: 'response_too_large',
        retryable: false,
      });
    }
  });

  it('counts streamed bytes when Content-Length understates the decoded response', async () => {
    guardedFetchMock.mockResolvedValueOnce(textResponse(SIX_MIB + 1, { 'content-length': '1' }));

    const error = await captureError(
      fetchResponseWithResilience(target, { ...readOperation, maxResponseBytes: SIX_MIB }, {}, {}),
    );

    expect(error).toMatchObject({ category: 'response_too_large' });
  });

  it('counts decoded bytes for a compressed response instead of trusting its encoded length', async () => {
    guardedFetchMock.mockResolvedValueOnce(
      textResponse(SIX_MIB + 1, {
        'content-encoding': 'gzip',
        'content-length': '4096',
      }),
    );

    const error = await captureError(
      fetchResponseWithResilience(target, { ...readOperation, maxResponseBytes: SIX_MIB }, {}, {}),
    );

    expect(error).toMatchObject({ category: 'response_too_large' });
  });

  it('rejects a declared oversized response before acquiring its body reader', async () => {
    let readerAcquired = false;
    guardedFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': String(SIX_MIB + 1) }),
      body: {
        getReader() {
          readerAcquired = true;
          throw new Error('body reader must not be acquired');
        },
      },
    });

    const error = await captureError(
      fetchResponseWithResilience(target, { ...readOperation, maxResponseBytes: SIX_MIB }, {}, {}),
    );

    expect(error).toMatchObject({ category: 'response_too_large' });
    expect(readerAcquired).toBe(false);
  });

  it('cancels the response reader immediately after streamed overflow', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(6));
        controller.enqueue(new Uint8Array(6));
        setTimeout(() => {
          if (!cancelled) controller.close();
        }, 0);
      },
      cancel() {
        cancelled = true;
      },
    });
    guardedFetchMock.mockResolvedValueOnce(new Response(body, { status: 200 }));

    const error = await captureError(
      fetchResponseWithResilience(target, { ...readOperation, maxResponseBytes: 10 }, {}, {}),
    );

    expect(error).toMatchObject({ category: 'response_too_large' });
    expect(cancelled).toBe(true);
  });
});
