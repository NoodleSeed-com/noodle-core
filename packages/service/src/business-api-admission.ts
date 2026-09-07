import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  type AtomicDailyCounterStore,
  type CounterRequest,
  type DailyCounterStore,
  nextReset,
} from '@noodle-borg/admission-limits/portable';
import type { ControlPlaneIdentity, DeployAuthGate } from '@noodle-borg/control-plane/portable';
import { sendJson } from '@noodle-borg/transport-http';
import type { BusinessApiAdmissionError } from '@noodle-borg/wire-contracts';
import { parseSolutionInstallationPath } from './routes/business-information-paths.js';
import { authorizeControlPlane } from './routes/control-plane.js';

/** Technical HTTP work allowances; they do not spend tool calls or commercial entitlements. */
export const BUSINESS_API_LIMITS = {
  read: { subject: 6_000, installation: 30_000, org: 60_000 },
  mutation: { subject: 1_200, installation: 6_000, org: 12_000 },
  recovery: { subject: 6_000, installation: 30_000, org: 60_000 },
} as const;
type Lane = keyof typeof BUSINESS_API_LIMITS;
type Target = { readonly org: string; readonly installationId?: string };
type Deps = {
  readonly gate: DeployAuthGate;
  readonly publicCounters: DailyCounterStore;
  readonly now?: () => Date;
};
interface Context {
  readonly identity: ControlPlaneIdentity;
  readonly counters: DailyCounterStore;
  readonly lane: Lane;
  readonly now: Date;
  readonly admissions: Map<string, Promise<boolean>>;
}
const requests = new WeakMap<IncomingMessage, Promise<Context | false>>();
const responses = new WeakMap<ServerResponse, Promise<Context | false>>();

export function businessApiCounter(
  lane: Lane,
  bucket: keyof typeof BUSINESS_API_LIMITS.read,
  scope: string | readonly string[],
): CounterRequest {
  const digest = createHash('sha256').update(JSON.stringify(scope)).digest('hex');
  return {
    key: `business-api:${lane}:${bucket}:${digest}`,
    limit: BUSINESS_API_LIMITS[lane][bucket],
    window: 'minute',
  };
}

function laneFor(req: IncomingMessage): Lane {
  const ref = parseSolutionInstallationPath(
    new URL(req.url ?? '/', 'http://service.invalid').pathname,
  );
  if (
    req.method === 'DELETE' ||
    ref?.action === 'export' ||
    (req.method === 'GET' && ref?.action === 'activity')
  )
    return 'recovery';
  if (req.method === 'GET' || req.method === 'HEAD') return 'read';
  if (
    (req.method === 'PATCH' && ref?.installationId && (!ref.action || ref.action === 'channels')) ||
    ref?.sourceAction ||
    ref?.connectionAction === 'disconnect' ||
    (req.method === 'POST' && ref?.action === 'records' && !ref.recordId)
  )
    return 'recovery';
  return 'mutation';
}

/** One verified identity and one subject attempt per request; invalid targets never spend victim capacity. */
export async function authorizeBusinessApi(
  req: IncomingMessage,
  res: ServerResponse,
  deps: Deps,
): Promise<ControlPlaneIdentity | false> {
  let pending = requests.get(req);
  if (!pending) {
    pending = (async () => {
      const identity = await authorizeControlPlane(req, res, deps.gate, { requireIdentity: true });
      if (identity === false) return false;
      const context: Context = {
        identity,
        counters: deps.publicCounters,
        lane: laneFor(req),
        now: deps.now?.() ?? new Date(),
        admissions: new Map(),
      };
      return (await subject(context, res, context.lane)) ? context : false;
    })();
    requests.set(req, pending);
  }
  responses.set(res, pending);
  const context = await pending;
  return context === false ? false : context.identity;
}

/** Invoke only after the existing live grant/permission or organization-owner check succeeds. */
export async function admitBusinessTarget(res: ServerResponse, target: Target): Promise<boolean> {
  const context = await responses.get(res);
  return context ? targetAdmission(context, res, target, context.lane) : unavailable(res);
}

/** A validated missing native receipt needs an additional mutation admission; completed receipts do not. */
export async function admitBusinessMutation(res: ServerResponse, target: Target): Promise<boolean> {
  const context = await responses.get(res);
  return context
    ? (await subject(context, res, 'mutation')) &&
        (await targetAdmission(context, res, target, 'mutation'))
    : unavailable(res);
}

function subject(context: Context, res: ServerResponse, lane: Lane): Promise<boolean> {
  return consume(context, res, lane, `${lane}:subject`, [
    businessApiCounter(lane, 'subject', context.identity.subject),
  ]);
}
function targetAdmission(
  context: Context,
  res: ServerResponse,
  target: Target,
  lane: Lane,
): Promise<boolean> {
  const counters = [businessApiCounter(lane, 'org', target.org)];
  if (target.installationId)
    counters.push(businessApiCounter(lane, 'installation', [target.org, target.installationId]));
  return consume(
    context,
    res,
    lane,
    `${lane}:${counters.map((counter) => counter.key).join(':')}`,
    counters,
  );
}
function consume(
  context: Context,
  res: ServerResponse,
  lane: Lane,
  key: string,
  batch: readonly CounterRequest[],
): Promise<boolean> {
  const existing = context.admissions.get(key);
  if (existing) return existing;
  const pending = (async () => {
    const store = context.counters as Partial<AtomicDailyCounterStore>;
    if (typeof store.consumeAll !== 'function') return unavailable(res);
    try {
      if (await store.consumeAll(batch, context.now)) return true;
    } catch {
      return unavailable(res);
    }
    const resetAt = nextReset(context.now, 'minute');
    res.setHeader(
      'Retry-After',
      String(Math.max(1, Math.ceil((resetAt.getTime() - context.now.getTime()) / 1000))),
    );
    sendJson(res, 429, {
      error:
        'This business API allowance is temporarily exhausted. Retry after the indicated time.',
      code: 'business_api_rate_limited',
      resetAt: resetAt.toISOString(),
      category: lane,
      limits: BUSINESS_API_LIMITS[lane],
    } satisfies BusinessApiAdmissionError);
    return false;
  })();
  context.admissions.set(key, pending);
  return pending;
}
function unavailable(res: ServerResponse): false {
  if (!res.writableEnded)
    sendJson(res, 503, {
      error: 'Business API admission is temporarily unavailable. Retry later.',
      code: 'business_api_admission_unavailable',
    } satisfies BusinessApiAdmissionError);
  return false;
}
