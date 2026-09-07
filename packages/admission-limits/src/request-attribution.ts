import { createHash } from 'node:crypto';
import { clientAddressBucket } from './client-address.js';

/** Private in-process attribution from an authenticated adapter, never a serialized assertion. */
export function trustedPublicAdmission(input: {
  readonly scope: string | undefined;
  readonly sourceAddress: string | undefined;
  readonly subject?: string;
  readonly now?: Date;
}): { readonly network: string; readonly visitor?: string } | undefined {
  if (!input.scope || !input.sourceAddress || input.sourceAddress.includes(',')) return undefined;
  const address = clientAddressBucket(input.sourceAddress);
  if (address === undefined) return undefined;
  const epoch = (input.now ?? new Date()).toISOString().slice(0, 10);
  const digest = (kind: string, value: string) =>
    createHash('sha256')
      .update(JSON.stringify([input.scope, epoch, kind, value]))
      .digest('hex');
  return {
    network: digest('network', address),
    ...(input.subject ? { visitor: digest('visitor', input.subject) } : {}),
  };
}
