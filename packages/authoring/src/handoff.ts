export type HandoffPurpose =
  | 'external_link'
  | 'checkout'
  | 'booking'
  | 'payment'
  | 'contact'
  | 'account_management'
  | 'configuration';

export interface HandoffStateHandleLink {
  readonly handle: string;
  readonly key?: string;
  readonly completion?: 'external' | 'complete_on_open';
}

export interface HandoffSession {
  readonly url: string;
  readonly purpose: HandoffPurpose;
  readonly expiresAt: string;
  readonly provider?: string;
  readonly stateHandle?: HandoffStateHandleLink;
}

export function handoffSession(options: HandoffSession): HandoffSession {
  return {
    url: options.url,
    purpose: options.purpose,
    expiresAt: options.expiresAt,
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(options.stateHandle === undefined ? {} : { stateHandle: options.stateHandle }),
  };
}
