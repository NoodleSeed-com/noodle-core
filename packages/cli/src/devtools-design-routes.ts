import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DESIGN_AGENT_INSTRUCTION } from './devtools-design-brief.js';
import {
  DESIGN_MAX_BODY_BYTES,
  type DesignSessionV1,
  validateDesignSession,
} from './devtools-design-contract.js';
import {
  createDesignStore,
  type DesignStore,
  DesignStoreConflictError,
  DesignStoreCorruptError,
} from './devtools-design-store.js';

export interface DesignRouteContext {
  readonly projectRoot: string;
  readonly entrypoint: string;
}

const DESIGN_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'cross-origin-resource-policy': 'same-origin',
} as const;

function reply(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, DESIGN_HEADERS);
  res.end(JSON.stringify(value));
}

function error(res: ServerResponse, status: number, code: string, message: string): void {
  reply(res, status, { ok: false, error: { code, message } });
}

function boundedInteger(
  raw: string | null,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = Number(raw);
  return Number.isInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

function safeText(raw: string | null, fallback: string, maximum: number): string {
  if (raw === null) return fallback;
  const normalized = raw.replace(/\s+/g, ' ').trim();
  return normalized.length > 0 ? normalized.slice(0, maximum) : fallback;
}

function newDraft(url: URL, context: DesignRouteContext): DesignSessionV1 {
  const now = new Date().toISOString();
  const device = url.searchParams.get('device') === 'mobile' ? 'mobile' : 'desktop';
  const theme = url.searchParams.get('theme') === 'dark' ? 'dark' : 'light';
  const resourceUri = safeText(url.searchParams.get('resourceUri'), '', 500);
  return validateDesignSession({
    version: 1,
    id: randomUUID(),
    status: 'draft',
    project: {
      entrypoint: context.entrypoint,
      toolName: safeText(url.searchParams.get('toolName'), 'widget', 200),
      ...(resourceUri ? { resourceUri } : {}),
    },
    viewport: {
      width: boundedInteger(url.searchParams.get('width'), 820, 280, 3840),
      height: boundedInteger(url.searchParams.get('height'), 640, 200, 2160),
      device,
      theme,
    },
    createdAt: now,
    updatedAt: now,
    annotations: [],
  });
}

export function readOrCreateDesignDraft(
  store: DesignStore,
  url: URL,
  context: DesignRouteContext,
): DesignSessionV1 {
  const current = store.readDraft();
  if (current) return current;
  const session = newDraft(url, context);
  try {
    store.writeDraft(session);
    return session;
  } catch (caught) {
    if (!(caught instanceof DesignStoreConflictError)) throw caught;
    const raced = store.readDraft();
    if (raced) return raced;
    throw caught;
  }
}

function readJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
  onBody: (body: Record<string, unknown>) => void,
): void {
  if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    error(res, 415, 'design_media_type', 'Design requests require application/json.');
    req.resume();
    return;
  }
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > DESIGN_MAX_BODY_BYTES) {
    error(res, 413, 'design_body_too_large', 'Design request is too large.');
    req.resume();
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let rejected = false;
  req.on('data', (chunk: Buffer) => {
    if (rejected) return;
    size += chunk.byteLength;
    if (size > DESIGN_MAX_BODY_BYTES) {
      rejected = true;
      error(res, 413, 'design_body_too_large', 'Design request is too large.');
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (rejected) return;
    try {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('body must be an object');
      }
      onBody(parsed as Record<string, unknown>);
    } catch {
      error(res, 400, 'design_invalid_json', 'Design request contains invalid JSON.');
    }
  });
}

/**
 * Handle loopback-only Design requests. The trusted filesystem context comes from the CLI process, never
 * from the browser request.
 */
export function handleDesignRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  context: DesignRouteContext | undefined,
): boolean {
  if (!url.pathname.startsWith('/design/')) return false;
  if (!context) {
    error(res, 409, 'design_project_missing', 'Design needs a local Noodle project.');
    return true;
  }

  const store = createDesignStore(context.projectRoot);
  try {
    if (url.pathname === '/design/session' && req.method === 'GET') {
      const session = readOrCreateDesignDraft(store, url, context);
      reply(res, 200, { ok: true, session });
      return true;
    }

    if (url.pathname === '/design/session' && req.method === 'PUT') {
      readJsonBody(req, res, (body) => {
        try {
          const session = validateDesignSession(body);
          const expectedUpdatedAt =
            typeof req.headers['if-unmodified-since'] === 'string'
              ? req.headers['if-unmodified-since']
              : undefined;
          store.writeDraft(session, expectedUpdatedAt);
          reply(res, 200, { ok: true, session });
        } catch (caught) {
          if (caught instanceof DesignStoreCorruptError) {
            error(res, 500, 'design_storage_invalid', 'Local Design storage needs recovery.');
            return;
          }
          if (caught instanceof DesignStoreConflictError) {
            error(res, 409, 'design_conflict', 'The design draft changed in another tab.');
            return;
          }
          error(res, 400, 'design_invalid_session', 'Design Session is invalid.');
        }
      });
      return true;
    }

    if (url.pathname === '/design/finalize' && req.method === 'POST') {
      readJsonBody(req, res, (body) => {
        try {
          const current = store.readDraft();
          if (!current) {
            error(res, 409, 'design_draft_missing', 'No design draft is ready to finalize.');
            return;
          }
          const expectedUpdatedAt =
            typeof body.expectedUpdatedAt === 'string' ? body.expectedUpdatedAt : undefined;
          if (!expectedUpdatedAt || current.updatedAt !== expectedUpdatedAt) {
            error(res, 409, 'design_conflict', 'The design draft changed in another tab.');
            return;
          }
          store.finalize(current);
          reply(res, 200, {
            ok: true,
            delivery: { kind: 'clipboard', instruction: DESIGN_AGENT_INSTRUCTION },
          });
        } catch (caught) {
          if (caught instanceof DesignStoreCorruptError) {
            error(res, 500, 'design_storage_invalid', 'Local Design storage needs recovery.');
            return;
          }
          error(res, 409, 'design_not_ready', 'Add at least one design change before continuing.');
        }
      });
      return true;
    }

    error(res, 405, 'design_method_not_allowed', 'This Design request method is not supported.');
    return true;
  } catch (caught) {
    if (caught instanceof DesignStoreCorruptError) {
      error(res, 500, 'design_storage_invalid', 'Local Design storage needs recovery.');
    } else {
      error(res, 500, 'design_storage_failed', 'Could not access local Design storage.');
    }
    return true;
  }
}
