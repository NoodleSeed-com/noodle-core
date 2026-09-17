/** Read decoded response bytes with bounded memory, cancellation and body cleanup on every path. */
export async function readBoundedBody(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const reader = response.body?.getReader();
  if (reader === undefined) return new ArrayBuffer(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      signal?.throwIfAborted();
      const next = await reader.read();
      signal?.throwIfAborted();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) throw new Error('response_size_exceeded');
      chunks.push(next.value);
    }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result.buffer;
  } finally {
    signal?.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
