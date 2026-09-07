import type { IncomingMessage } from 'node:http';
import { gunzipSync } from 'node:zlib';

export async function readBody(
  req: IncomingMessage,
  max: number,
): Promise<{ ok: true; text: string } | { ok: false; receivedBytes: number; maxBytes: number }> {
  const body = await readBodyBuffer(req, max);
  return body.ok ? { ok: true, text: body.buffer.toString('utf8') } : body;
}

async function readBodyBuffer(
  req: IncomingMessage,
  max: number,
): Promise<{ ok: true; buffer: Buffer } | { ok: false; receivedBytes: number; maxBytes: number }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > max) return { ok: false, receivedBytes: size, maxBytes: max };
    chunks.push(buf);
  }
  return { ok: true, buffer: Buffer.concat(chunks) };
}

export async function readDeployBody(
  req: IncomingMessage,
  max: number,
): Promise<
  | { ok: true; text: string; encoding: 'identity' | 'gzip' }
  | {
      ok: false;
      status: 400 | 413 | 415;
      error: string;
      receivedBytes?: number;
      maxBytes?: number;
    }
> {
  const encoding = (req.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
  if (encoding !== 'identity' && encoding !== 'gzip') {
    return { ok: false, status: 415, error: `unsupported content encoding "${encoding}"` };
  }
  const body = await readBodyBuffer(req, max);
  if (!body.ok) {
    return {
      ok: false,
      status: 413,
      error: `${encoding === 'gzip' ? 'compressed deploy' : 'deploy'} request exceeds the ${body.maxBytes} byte limit (received at least ${body.receivedBytes} bytes)`,
      receivedBytes: body.receivedBytes,
      maxBytes: body.maxBytes,
    };
  }
  if (encoding === 'identity') {
    return { ok: true, text: body.buffer.toString('utf8'), encoding };
  }
  try {
    const expanded = gunzipSync(body.buffer, { maxOutputLength: max });
    return { ok: true, text: expanded.toString('utf8'), encoding };
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : '';
    if (code === 'ERR_BUFFER_TOO_LARGE') {
      return {
        ok: false,
        status: 413,
        error: `expanded deploy request exceeds the ${max} byte limit`,
        maxBytes: max,
      };
    }
    return { ok: false, status: 400, error: 'invalid gzip deploy request' };
  }
}

export async function readJsonBody(
  req: IncomingMessage,
  max: number,
): Promise<{ ok: true; value: unknown } | { ok: false; status: 400 | 413; error: string }> {
  const body = await readBody(req, max);
  if (!body.ok) return { ok: false, status: 413, error: 'request body too large' };
  try {
    return { ok: true, value: JSON.parse(body.text) as unknown };
  } catch (error) {
    return { ok: false, status: 400, error: `invalid JSON: ${(error as Error).message}` };
  }
}
