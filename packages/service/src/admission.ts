import type { AdmissionGate } from '@noodle-borg/transport-http';
import type { AuditSink } from './store/audit.js';

const ANONYMOUS_CONSUMER_LIMIT = 60;
const ANONYMOUS_CONSUMER_WINDOW_MS = 60 * 60 * 1000;

export function createAdmissionGate(
  anonymousLimiter: AnonymousConsumerLimiter,
  audit: AuditSink,
  extraGate?: AdmissionGate,
): AdmissionGate {
  return async (context) => {
    if (extraGate !== undefined) {
      const extra = await extraGate(context);
      if (!extra.allow) {
        await emitAdmissionDeny(audit, context, extra.reason, extra.status);
        return extra;
      }
    }
    if (
      (context.accessMode === 'public' || context.accessMode === 'mixed') &&
      context.subject === undefined &&
      context.method === 'tools/call'
    ) {
      const limited = anonymousLimiter.consume(
        `${context.routeId}:${context.remoteAddress ?? 'unknown'}`,
      );
      if (!limited.ok) {
        await emitAdmissionDeny(audit, context, limited.code, 429);
        return { allow: false, reason: limited.code, status: 429 };
      }
    }
    return { allow: true };
  };
}

async function emitAdmissionDeny(
  audit: AuditSink,
  context: Parameters<AdmissionGate>[0],
  reasonCode: string,
  status = 403,
): Promise<void> {
  if (context.org === undefined) return;
  await audit.emit({
    eventType: context.method === 'tools/call' ? 'tool.call.denied' : 'mcp.request.denied',
    org: context.org,
    ...(context.app !== undefined ? { app: context.app } : {}),
    ...(context.env !== undefined ? { env: context.env } : {}),
    ...(context.deploymentId !== undefined ? { deploymentId: context.deploymentId } : {}),
    ...(context.subject !== undefined ? { actorSubject: context.subject } : {}),
    decision: 'deny',
    status,
    reasonCode,
    details: {
      method: context.method,
      category: context.category,
      ...(context.name !== undefined ? { name: context.name } : {}),
      routeId: context.routeId,
    },
  });
}

export class AnonymousConsumerLimiter {
  readonly #now: () => Date;
  readonly #buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  consume(
    key: string,
  ): { readonly ok: true } | { readonly ok: false; readonly code: 'quota_exceeded' } {
    const now = this.#now().getTime();
    const existing = this.#buckets.get(key);
    const bucket =
      existing === undefined || existing.resetAt <= now
        ? { count: 0, resetAt: now + ANONYMOUS_CONSUMER_WINDOW_MS }
        : existing;
    if (bucket.count >= ANONYMOUS_CONSUMER_LIMIT) {
      this.#buckets.set(key, bucket);
      return { ok: false, code: 'quota_exceeded' };
    }
    bucket.count++;
    this.#buckets.set(key, bucket);
    return { ok: true };
  }
}
