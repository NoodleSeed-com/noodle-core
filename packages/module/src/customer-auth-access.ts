import type { AccessMode } from './contract.js';

export function usesCustomerAuthentication(input: {
  readonly schemaVersion: number;
  readonly accessMode: AccessMode | undefined;
  readonly hasServerAuth: boolean;
}): boolean {
  if (input.accessMode === 'customers') return true;

  return input.accessMode === 'mixed' && input.schemaVersion === 2 && input.hasServerAuth;
}
