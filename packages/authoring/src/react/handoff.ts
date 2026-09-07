import { useCallback, useMemo, useState } from 'react';
import { useOpenExternal } from './hooks.js';

export type HandoffState = 'idle' | 'opening' | 'opened' | 'error';

export type HandoffController = {
  readonly status: HandoffState;
  readonly error?: Error;
  readonly open: (
    target: string | { readonly url?: string; readonly checkoutUrl?: string },
  ) => Promise<void>;
  readonly reset: () => void;
};

export function useHandoff(): HandoffController {
  const openExternal = useOpenExternal();
  const [status, setStatus] = useState<HandoffState>('idle');
  const [error, setError] = useState<Error | undefined>();
  const open = useCallback(
    async (target: string | { readonly url?: string; readonly checkoutUrl?: string }) => {
      const url = typeof target === 'string' ? target : (target.url ?? target.checkoutUrl);
      if (url === undefined || url.length === 0) {
        const err = new Error('Missing handoff URL');
        setError(err);
        setStatus('error');
        throw err;
      }
      if (!isHttpUrl(url)) {
        const err = new Error('Handoff URL must use http or https');
        setError(err);
        setStatus('error');
        throw err;
      }
      setStatus('opening');
      setError(undefined);
      try {
        await openExternal(url);
        setStatus('opened');
      } catch (cause) {
        const err = cause instanceof Error ? cause : new Error(String(cause));
        setError(err);
        setStatus('error');
        throw err;
      }
    },
    [openExternal],
  );
  const reset = useCallback(() => {
    setStatus('idle');
    setError(undefined);
  }, []);
  return useMemo(
    () => ({
      status,
      ...(error === undefined ? {} : { error }),
      open,
      reset,
    }),
    [error, open, reset, status],
  );
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
