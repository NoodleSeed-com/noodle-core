/**
 * Minimal HTTP plumbing for knowledge route handlers. Byte-compatible with the service's
 * wire behavior but deliberately independent of it — a module package never imports the
 * service (the feedback-operations precedent).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

export async function readBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<{ ok: true; body: Buffer } | { ok: false; status: number; error: string }> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buffer.length;
    if (total > maxBytes) {
      return { ok: false, status: 413, error: `request body exceeds ${maxBytes} bytes` };
    }
    chunks.push(buffer);
  }
  return { ok: true, body: Buffer.concat(chunks) };
}
