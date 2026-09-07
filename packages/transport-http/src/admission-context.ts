import type { AdmissionCategory, AdmissionContext } from '@noodle-borg/module';
import { rpcMethod, rpcTargetName, safeRpcId } from './request-capture.js';

export function requestsInvocationContext(parsed: unknown): boolean {
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items.some((item) => {
    const method = rpcMethod(item);
    return method === 'tools/call' || method === 'resources/read' || method === 'prompts/get';
  });
}

export function admissionContexts(
  parsed: unknown,
  base: Omit<AdmissionContext, 'method' | 'category' | 'name'>,
): readonly AdmissionContext[] {
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items.map((item) => {
    const method = rpcMethod(item);
    const name = rpcTargetName(item, method);
    return {
      ...base,
      ...safeRpcId(item),
      method,
      category: admissionCategory(method),
      ...(name !== undefined ? { name } : {}),
    };
  });
}

function admissionCategory(method: string): AdmissionCategory {
  if (
    method === 'tools/list' ||
    method === 'skills/list' ||
    method === 'resources/list' ||
    method === 'resources/templates/list' ||
    method === 'prompts/list'
  ) {
    return 'discovery';
  }
  if (
    method === 'resources/read' ||
    method === 'skills/get' ||
    method === 'prompts/get' ||
    method.startsWith('completion/')
  ) {
    return 'read';
  }
  if (method === 'tools/call') return 'execute';
  return 'protocol';
}
