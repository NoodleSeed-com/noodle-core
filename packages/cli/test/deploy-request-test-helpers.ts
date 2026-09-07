import { gunzipSync } from 'node:zlib';

/** Decode a deploy request exactly as the service does, including whole-request gzip. */
export function parseDeployRequestJson(init?: RequestInit): Record<string, unknown> {
  const headers = new Headers(init?.headers);
  const body =
    headers.get('content-encoding') === 'gzip'
      ? gunzipSync(Buffer.from(init?.body as Uint8Array)).toString('utf8')
      : String(init?.body);
  return JSON.parse(body) as Record<string, unknown>;
}
