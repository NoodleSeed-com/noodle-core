export type InvocationContextPreferenceSource =
  | 'user-preference'
  | 'client-hint'
  | 'server-default'
  | 'platform-default';

export interface InvocationTemporalContext {
  /** Server-authoritative RFC 3339 instant. */
  readonly instant: string;
  readonly localDate: string;
  readonly localTime: string;
  readonly utcOffset: string;
  readonly weekday: string;
  readonly timeZone: string;
  readonly locale: string;
  readonly source: {
    readonly locale: InvocationContextPreferenceSource;
    readonly timeZone: InvocationContextPreferenceSource;
  };
}

/** Optional coarse coordinates supplied by the invoking client for this call only. */
export interface InvocationLocationContext {
  readonly latitude: number;
  readonly longitude: number;
  readonly city?: string;
  readonly region?: string;
  readonly country?: string;
  readonly timeZone?: string;
  readonly source: 'client-hint';
}

/** Immutable facts resolved once and reused for every fulfilment in one invocation. */
export interface InvocationContext {
  readonly temporal: InvocationTemporalContext;
  /** Untrusted convenience context. Absence means the client supplied no usable coordinate pair. */
  readonly location?: InvocationLocationContext;
  readonly ambientStatus: 'not_configured' | 'available' | 'unavailable';
  readonly ambient?: unknown;
}
