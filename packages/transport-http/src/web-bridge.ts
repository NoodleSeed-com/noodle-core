import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

function firstHeaderValue(value: string | readonly string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return first?.split(',', 1)[0]?.trim();
}

function requestOrigin(req: IncomingMessage): string {
  const protocol = firstHeaderValue(req.headers['x-forwarded-proto']) ?? 'http';
  const host = firstHeaderValue(req.headers.host) ?? 'localhost';
  return `${protocol}://${host}`;
}

function requestHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    const name = req.rawHeaders[index];
    const value = req.rawHeaders[index + 1];
    if (name !== undefined && value !== undefined) headers.append(name, value);
  }
  return headers;
}

/**
 * Convert one already-admitted Node request to the web-standard request consumed by the MCP handler.
 * The caller supplies the body it already bounded and parsed at the security front door.
 */
export function toWebRequest(
  req: IncomingMessage,
  bufferedBody: Uint8Array | string = new Uint8Array(),
): Request {
  const method = req.method ?? 'GET';
  const canHaveBody = method !== 'GET' && method !== 'HEAD';
  const bodyLength =
    typeof bufferedBody === 'string' ? bufferedBody.length : bufferedBody.byteLength;
  return new Request(new URL(req.url ?? '/', requestOrigin(req)), {
    method,
    headers: requestHeaders(req),
    ...(canHaveBody && bodyLength > 0
      ? {
          body: typeof bufferedBody === 'string' ? bufferedBody : new Uint8Array(bufferedBody),
        }
      : {}),
  });
}

/** Write a web-standard response back to Node without collapsing repeated Set-Cookie fields. */
export async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
  if (res.headersSent) {
    throw new Error('cannot write web response: headers already sent');
  }

  res.statusCode = response.status;
  if (response.statusText !== '') res.statusMessage = response.statusText;

  const cookies = response.headers.getSetCookie();
  for (const [name, value] of response.headers) {
    if (name.toLowerCase() !== 'set-cookie') res.setHeader(name, value);
  }
  if (cookies.length > 0) res.setHeader('set-cookie', cookies);

  if (response.body === null) {
    res.end();
    return;
  }
  await pipeline(Readable.fromWeb(response.body), res);
}
