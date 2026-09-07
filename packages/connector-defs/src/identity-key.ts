/** Collision-free internal key for an authored connector identity. */
export function connectorIdentityKey(id: string, version: string): string {
  return JSON.stringify([id, version]);
}

/** Collision-free internal key for one operation on an authored connector identity. */
export function operationIdentityKey(id: string, version: string, operation: string): string {
  return JSON.stringify([id, version, operation]);
}
