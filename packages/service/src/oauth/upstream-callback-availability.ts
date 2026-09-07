import type { Response } from 'express';

/** Keeps a skewed instance from burning a shared pending callback it cannot complete. */
export function rejectUnavailableUpstreamCallback(res: Response, available: boolean): boolean {
  if (available) return false;
  res.status(503).set('Retry-After', '5').type('text/plain').send('upstream authentication failed');
  return true;
}
