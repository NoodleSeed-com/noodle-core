import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { readJsonBody } from '../src/request-body.js';

function request(body: string): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  req.push(Buffer.from(body));
  req.push(null);
  return req;
}

describe('bounded request body readers', () => {
  it('parses a bounded JSON object', async () => {
    await expect(readJsonBody(request('{"ok":true}'), 64)).resolves.toEqual({
      ok: true,
      value: { ok: true },
    });
  });

  it('rejects malformed and oversized request bodies', async () => {
    await expect(readJsonBody(request('{'), 64)).resolves.toMatchObject({
      ok: false,
      status: 400,
    });
    await expect(readJsonBody(request('{"too":"large"}'), 4)).resolves.toEqual({
      ok: false,
      status: 413,
      error: 'request body too large',
    });
  });
});
