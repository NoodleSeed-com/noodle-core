/** Loopback-only synthetic host. Replace its demo identity with your existing login in a real app. */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAssistantSession } from '@noodleseed/assistant/server';

const publicOrigin = 'http://localhost:3001';
const appOrigin = 'http://localhost:3002';
const serviceUrl = process.env.NOODLE_SERVICE_URL ?? 'https://cloud.noodleseed.dev';
const embedId = process.env.NOODLE_EMBED_ID;
const credentialFile = process.env.NOODLE_ASSISTANT_CREDENTIALS_FILE;
if (!embedId?.match(/^pub_[a-z0-9]+$/i)) {
  throw new Error('Set NOODLE_EMBED_ID from the hosted deployment.');
}
if (new URL(serviceUrl).protocol !== 'https:')
  throw new Error('The hosted service must use HTTPS.');
// Consume only the explicitly supplied backend credential file. Its content is never sent to the browser.
const credentials = credentialFile ? JSON.parse(await readFile(credentialFile, 'utf8')) : undefined;
if (
  credentials &&
  (typeof credentials.clientId !== 'string' || typeof credentials.clientSecret !== 'string')
) {
  throw new Error('The backend credential file is not a CLI-created assistant client file.');
}
const sdkDir = dirname(fileURLToPath(import.meta.resolve('@noodleseed/assistant')));
const siteDir = dirname(fileURLToPath(import.meta.url));
const transactions = new Map();
const lifetime = 10 * 60 * 1000;

function send(res, status, value, type = 'application/json') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(type === 'application/json' ? JSON.stringify(value) : value);
}
function redirect(res, destination) {
  res.writeHead(303, { Location: destination, 'Cache-Control': 'no-store' });
  res.end();
}
function current(req) {
  const id = /(?:^|;\s*)brief_demo=([a-f0-9-]+)/.exec(req.headers.cookie ?? '')?.[1];
  return id ? transactions.get(id) : undefined;
}
async function jsonBody(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk.toString();
    if (Buffer.byteLength(text) > 8192) throw new Error('Request too large');
  }
  return JSON.parse(text);
}

function handler(origin) {
  return async (req, res) => {
    // The fixed loopback host is intentional: never deploy this synthetic-login server to the internet.
    if (req.headers.host !== new URL(origin).host) return send(res, 403, { error: 'Wrong host' });
    for (const [id, transaction] of transactions) {
      if (transaction.expiresAt <= Date.now()) transactions.delete(id);
    }
    const path = new URL(req.url ?? '/', origin).pathname;
    try {
      if (req.method === 'GET' && path === '/') {
        return send(
          res,
          200,
          await readFile(join(siteDir, 'index.html')),
          'text/html; charset=utf-8',
        );
      }
      if (req.method === 'GET' && path === '/demo-config') {
        return send(res, 200, {
          serviceUrl,
          embedId,
          authenticated: origin === appOrigin,
          signedIn: Boolean(current(req)?.user),
        });
      }
      if (req.method === 'GET' && path === '/client.js') {
        return send(res, 200, await readFile(join(siteDir, 'client.js')), 'text/javascript');
      }
      if (req.method === 'GET' && /^\/sdk\/[a-z0-9._-]+\.js$/i.test(path)) {
        return send(res, 200, await readFile(join(sdkDir, path.slice(5))), 'text/javascript');
      }
      if (req.method === 'POST') {
        if (req.headers.origin !== origin) return send(res, 403, { error: 'Wrong origin' });
        if (origin === publicOrigin && path === '/start') {
          if (!credentials)
            return send(res, 503, {
              error:
                'Signup demonstration needs an authorized backend client. The anonymous brief is still available.',
            });
          if (transactions.size >= 40) return send(res, 429, { error: 'Please try again later' });
          const body = await jsonBody(req);
          if (typeof body.signInTicket !== 'string' || body.signInTicket.length > 4096) {
            return send(res, 400, { error: 'Missing continuation ticket' });
          }
          const id = randomUUID();
          transactions.set(id, {
            signInTicket: body.signInTicket,
            expiresAt: Date.now() + lifetime,
          });
          res.setHeader(
            'Set-Cookie',
            `brief_demo=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`,
          );
          return send(res, 200, { destination: appOrigin });
        }
        if (origin === appOrigin && path === '/demo-login') {
          const transaction = current(req);
          if (!transaction)
            return send(res, 410, { error: 'Demo expired. Start again on the public page.' });
          // Synthetic identity only. A production route must verify its existing application session.
          transaction.user ??= { id: `demo_${randomUUID()}`, name: 'Demo visitor' };
          return redirect(res, '/');
        }
      }
      if (origin === appOrigin && req.method === 'GET' && path === '/assistant-session') {
        if (!credentials) return send(res, 503, { error: 'Configure the backend client first' });
        if (req.headers['sec-fetch-site'] !== 'same-origin')
          return send(res, 403, { error: 'Same-origin request required' });
        const transaction = current(req);
        if (!transaction?.user)
          return send(res, 401, { error: 'Choose the synthetic demo account first' });
        // Reuse the in-flight result so concurrent mounts cannot spend the single-use ticket twice.
        transaction.session ??= createAssistantSession({
          serviceUrl,
          clientId: credentials.clientId,
          clientSecret: credentials.clientSecret,
          origin: appOrigin,
          user: transaction.user,
          signInTicket: transaction.signInTicket,
        });
        const session = await transaction.session;
        delete transaction.signInTicket;
        return send(res, 200, session);
      }
      return send(res, 404, { error: 'Not found' });
    } catch {
      // Do not log credentials, tickets, requests, or raw provider errors.
      return send(res, 409, {
        error: 'Continuation was not completed. Return to the public page and start again.',
      });
    }
  };
}
for (const [port, origin] of [
  [3001, publicOrigin],
  [3002, appOrigin],
]) {
  createServer(handler(origin)).listen(port, '127.0.0.1');
}
console.log(`Synthetic onboarding demo: ${publicOrigin}`);
console.log('Loopback only. Uses the hosted assistant; demo signup is not a real account.');
