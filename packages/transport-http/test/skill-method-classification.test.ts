import { describe, expect, it } from 'vitest';
import { admissionContexts, requestsInvocationContext } from '../src/admission-context.js';
import { rpcTargetName } from '../src/request-capture.js';

const base = {
  org: 'acme',
  app: 'tasks',
  env: 'prod',
  accessMode: 'owner-only' as const,
  subject: 'owner-subject',
};

describe('MCP skill method classification', () => {
  it('classifies skill enumeration as discovery', () => {
    expect(
      admissionContexts({ jsonrpc: '2.0', id: 1, method: 'skills/list', params: {} }, base),
    ).toEqual([
      expect.objectContaining({ requestId: 1, method: 'skills/list', category: 'discovery' }),
    ]);
  });

  it('classifies one skill lookup as a named read without resolving invocation context', () => {
    const request = {
      jsonrpc: '2.0',
      id: 2,
      method: 'skills/get',
      params: { uri: 'skill://acme-tasks/SKILL.md' },
    };
    expect(admissionContexts(request, base)).toEqual([
      expect.objectContaining({
        requestId: 2,
        method: 'skills/get',
        category: 'read',
        name: 'skill://acme-tasks/SKILL.md',
      }),
    ]);
    expect(rpcTargetName(request, 'skills/get')).toBe('skill://acme-tasks/SKILL.md');
    expect(requestsInvocationContext(request)).toBe(false);
  });
});
