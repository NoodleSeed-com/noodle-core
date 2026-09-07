/** RFC 8628 state stored by the authorization server. All codes are stored as hashes. */
export interface DeviceAuthorizationRecord {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly clientId: string;
  readonly resource: string;
  readonly scope?: string;
  readonly status: 'pending' | 'approved' | 'denied';
  readonly ownerSubject?: string;
  readonly ownerEmail?: string;
  readonly ownerLocale?: string;
  readonly ownerTimeZone?: string;
  readonly identityKind?: 'platform' | 'customer';
  readonly identityProvider?: string;
  readonly customerIssuer?: string;
  readonly developerGrantId?: string;
  readonly expiresAt: number;
  readonly nextPollAt: number;
  readonly intervalSeconds: number;
}

export interface DeviceBrowserSessionRecord {
  readonly state: string;
  readonly deviceCode: string;
  readonly clientId: string;
  readonly resource: string;
  readonly codeChallenge: string;
  readonly expiresAt: number;
}

export interface DeviceAuthorizationIdentity {
  readonly ownerSubject: string;
  readonly ownerEmail?: string;
  readonly ownerLocale?: string;
  readonly ownerTimeZone?: string;
  readonly identityKind?: 'platform' | 'customer';
  readonly identityProvider?: string;
  readonly customerIssuer?: string;
  readonly developerGrantId?: string;
}

export type DeviceAuthorizationPoll =
  | { readonly status: 'authorization_pending' }
  | { readonly status: 'slow_down' }
  | { readonly status: 'access_denied' }
  | { readonly status: 'expired_token' }
  | { readonly status: 'invalid_grant' }
  | { readonly status: 'approved'; readonly record: DeviceAuthorizationRecord };

export interface DeviceAuthorizationStore {
  createDeviceAuthorization(record: DeviceAuthorizationRecord): Promise<void>;
  getDeviceAuthorizationByUserCode(
    userCode: string,
  ): Promise<DeviceAuthorizationRecord | undefined>;
  createDeviceBrowserSession(record: DeviceBrowserSessionRecord): Promise<void>;
  consumeDeviceBrowserSession(state: string): Promise<DeviceBrowserSessionRecord | undefined>;
  approveDeviceAuthorization(
    deviceCode: string,
    identity: DeviceAuthorizationIdentity,
  ): Promise<boolean>;
  denyDeviceAuthorization(deviceCode: string): Promise<boolean>;
  pollDeviceAuthorization(input: {
    readonly deviceCode: string;
    readonly clientId: string;
    readonly resource?: string;
    readonly nowSeconds: number;
  }): Promise<DeviceAuthorizationPoll>;
  completeDeviceTokenIssuance(deviceCode: string, clientId: string): Promise<boolean>;
}
