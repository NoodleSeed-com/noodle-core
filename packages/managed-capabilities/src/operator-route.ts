import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ModuleRoute } from '@noodle-borg/module';
import { z } from 'zod';
import { CapabilityBudget } from './budget.js';
import { webCapabilityBaseSchema } from './contracts.js';
import { CapabilityError } from './errors.js';
import {
  capabilityInspectionSchema,
  capabilityListResponseSchema,
  capabilityPolicyUpdateSchema,
  capabilityScopeSchema,
  capabilityTestRequestSchema,
  capabilityTestResponseSchema,
} from './operator-contracts.js';
import { CapabilityPolicyConflict } from './policy-store.js';
import type { CapabilityService } from './service.js';

const path =
  /^\/v1\/orgs\/([^/]+)\/apps\/([^/]+)\/envs\/([^/]+)\/capabilities(?:\/([^/]+)(?:\/(policy|test))?)?$/;

/** Operator diagnostic commands share policy/admission; they never expose source bodies. */
export function capabilityOperatorRoute(service: CapabilityService): ModuleRoute {
  return {
    id: 'managed-capabilities',
    match: (_method, url) => path.test(url.pathname),
    handle: async (req, res, ctx) => {
      try {
        const match = path.exec(new URL(req.url ?? '/', 'http://service.invalid').pathname);
        if (!match) return send(res, 404, { error: 'not_found' });
        const scope = capabilityScopeSchema.parse({
          org: match[1],
          app: match[2],
          env: match[3],
          name: match[4] ?? 'list',
        });
        const { name, ...tenant } = scope;
        const action = match[5];
        const reading = req.method === 'GET' && action === undefined;
        if (
          !reading &&
          !(req.method === 'PUT' && action === 'policy') &&
          !(req.method === 'POST' && action === 'test')
        ) {
          return send(res, 405, { error: 'method_not_allowed' });
        }
        const auth = await ctx.tenantControl?.authorize(req, {
          org: scope.org,
          permission: reading ? 'org:member' : 'org:manage',
        });
        if (auth?.ok !== true || auth.identity === undefined)
          return send(res, auth?.ok === false ? auth.status : 401, {
            error: 'capability_forbidden',
          });
        const target = await ctx.capabilityDeployments?.get(req, tenant);
        if (target === undefined) return send(res, 404, { error: 'deployment_not_found' });
        // The service has already compiled and authorized these declarations. Diagnostics need only intent.
        const declarations = target.declarations.map((raw) =>
          webCapabilityBaseSchema.strip().parse(raw),
        );
        if (match[4] === undefined) {
          return send(
            res,
            200,
            capabilityListResponseSchema.parse({
              deploymentId: target.deploymentId,
              capabilities: await Promise.all(declarations.map((d) => service.inspect(tenant, d))),
            }),
          );
        }
        const declaration = declarations.find((d) => d.name === name);
        if (declaration === undefined) return send(res, 404, { error: 'capability_not_found' });
        if (reading)
          return send(
            res,
            200,
            capabilityInspectionSchema.parse(await service.inspect(tenant, declaration)),
          );
        const body = await jsonBody(req);
        if (action === 'policy') {
          const update = capabilityPolicyUpdateSchema.parse(body);
          const record = await service.configure(tenant, declaration, {
            ...update,
            actor: auth.identity.subject,
          });
          await ctx.audit?.emit({
            eventType: 'capability.policy.updated',
            ...tenant,
            actorSubject: auth.identity.subject,
            deploymentId: target.deploymentId,
            details: { name, revision: record.revision, enabled: record.policy.enabled },
          });
          return send(
            res,
            200,
            capabilityInspectionSchema.parse(await service.inspect(tenant, declaration)),
          );
        }
        const test = capabilityTestRequestSchema.parse(body);
        const cancelled = new AbortController();
        const abort = () => cancelled.abort();
        req.once('aborted', abort);
        res.once('close', abort);
        try {
          const result = await service.execute(
            declaration,
            test.request,
            {
              tenant,
              deploymentId: target.deploymentId,
              executionId: randomUUID(),
              subject: auth.identity.subject,
              anonymous: false,
              authorized: true,
              budget: new CapabilityBudget(),
              signal: cancelled.signal,
            },
            test.mode === 'fixture'
              ? {
                  read: async ({ url }) => ({
                    url,
                    title: 'Diagnostic fixture',
                    text: 'Synthetic diagnostic evidence. No website was fetched.',
                    links: [],
                    retrievedAt: new Date().toISOString(),
                  }),
                }
              : undefined,
          );
          return send(
            res,
            200,
            capabilityTestResponseSchema.parse({
              mode: test.mode,
              status: result.status,
              pages: result.items.length,
              sources: result.sources.map(({ ref, url, retrievedAt }) => ({
                ref,
                url,
                retrievedAt,
              })),
              warnings: result.warnings,
            }),
          );
        } finally {
          req.off('aborted', abort);
          res.off('close', abort);
        }
      } catch (error) {
        const status =
          error instanceof CapabilityPolicyConflict
            ? 409
            : error instanceof z.ZodError
              ? 400
              : error instanceof CapabilityError
                ? 422
                : 503;
        send(res, status, {
          error:
            error instanceof CapabilityPolicyConflict
              ? 'capability_policy_conflict'
              : error instanceof z.ZodError
                ? 'invalid_request'
                : error instanceof CapabilityError
                  ? error.code
                  : 'capability_unavailable',
        });
      }
    },
  };
}
async function jsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    size += chunk.length;
    if (size > 16_384) throw new CapabilityError('capability_source_rejected');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new CapabilityError('capability_source_rejected');
  }
}
function send(res: ServerResponse, status: number, value: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}
