import { timingSafeEqual } from 'node:crypto';
import { DevtoolsAuthError } from './devtools-auth-types.js';

export function safeFailure(
  error: unknown,
  fallback: string,
): { readonly message: string; readonly errorCode?: string } {
  return {
    message: safeMessage(error, fallback),
    ...(error instanceof DevtoolsAuthError ? { errorCode: error.code } : {}),
  };
}

export function constantTimeStringEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function safeMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || error.message.length === 0) return fallback;
  return error.message.slice(0, 240);
}
