import type { AuditEventInput, AuditSink } from '@noodle-borg/module';
import { filterAuthorizedTools } from '@noodle-borg/protocol';
import type { ToolDispatchDecision } from '@noodle-borg/runtime';
import type {
  HostedToolAuthorizationObservation,
  HostedToolDispatchContext,
  HostedToolDispatchHook,
} from '@noodle-borg/transport-http';
import { noopLogger } from '@noodle-borg/transport-http';
import { describe, expect, it, vi } from 'vitest';
import {
  createServicePrincipalToolAuthorizationAudit,
  withServicePrincipalToolCallAudit,
} from '../src/service-principal-data-plane.js';

describe('hosted service-principal data-plane accounting', () => {
  it('preserves the existing dispatch result and emits one call decision only for allowed service calls', async () => {
    const audit = auditSink();
    const allowed = { allow: true } as const;
    const next = vi.fn<HostedToolDispatchHook>().mockResolvedValue(allowed);
    const wrapped = withServicePrincipalToolCallAudit(next, audit, noopLogger);

    await expect(wrapped(context('spn_a'))).resolves.toBe(allowed);
    expect(next).toHaveBeenCalledTimes(1);
    expect(audit.events).toEqual([
      expect.objectContaining({
        eventType: 'service_principal.tool.called',
        org: 'acme',
        app: 'todoist',
        env: 'prod',
        deploymentId: 'dep_1',
        actorSubject: 'spn_a',
        decision: 'allow',
        details: { toolName: 'read_todos' },
      }),
    ]);

    const denied = { allow: false, reason: 'quota_exceeded' } as ToolDispatchDecision;
    next.mockResolvedValueOnce(denied);
    await expect(wrapped(context('spn_a'))).resolves.toBe(denied);
    await expect(wrapped(context('human-1', 'platform'))).resolves.toBe(allowed);
    expect(audit.events).toHaveLength(1);
  });

  it('projects only flat tenant, subject, tool, decision, and rule facts into authorization audit', async () => {
    const audit = auditSink();
    const observe = createServicePrincipalToolAuthorizationAudit(audit, noopLogger);
    const observation: HostedToolAuthorizationObservation = {
      subject: 'spn_a',
      org: 'acme',
      app: 'todoist',
      environment: 'prod',
      deploymentId: 'dep_1',
      toolName: 'delete_todo',
      decision: 'deny',
      reason: 'human_confirmation_required',
      ruleClass: 'human_confirmation',
      ruleFingerprint: 'service-confirmation:v1',
    };

    await observe(observation);

    expect(audit.events).toEqual([
      {
        eventType: 'service_principal.tool.authorization',
        org: 'acme',
        app: 'todoist',
        env: 'prod',
        deploymentId: 'dep_1',
        actorSubject: 'spn_a',
        decision: 'deny',
        status: 403,
        reasonCode: 'human_confirmation_required',
        details: {
          toolName: 'delete_todo',
          ruleClass: 'human_confirmation',
          ruleFingerprint: 'service-confirmation:v1',
        },
      },
    ]);
  });

  it('keeps human-role-gated tools hidden from roleless service principals', () => {
    const tools = [
      { name: 'read_todos', authorization: { requiredScopes: ['todos.read'] } },
      { name: 'admin_todos', authorization: { allowedRoles: ['org:admin'] } },
    ] as never;

    expect(
      filterAuthorizedTools(tools, {
        scopes: ['todos.read'],
        roles: [],
      }).map((tool) => tool.name),
    ).toEqual(['read_todos']);
  });
});

function context(
  subject: string,
  identityKind: 'service' | 'platform' = 'service',
  invocationRound = 1,
): HostedToolDispatchContext {
  return {
    org: 'acme',
    app: 'todoist',
    environment: 'prod',
    deploymentId: 'dep_1',
    caller: { subject, scopes: ['todos.read'], roles: [], identityKind },
    client: { protocolVersion: '2026-07-28' },
    requestId: 1,
    requestMeta: {},
    toolName: 'read_todos',
    toolArguments: {},
    invocationId: 'inv_1',
    invocationRound,
  };
}

function auditSink(): AuditSink & { readonly events: AuditEventInput[] } {
  const events: AuditEventInput[] = [];
  return { events, emit: async (event) => void events.push(event) };
}
