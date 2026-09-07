export interface OAuthLegacyRedirectRollout {
  readonly unsafeLegacyMode: 'observe' | 'deny';
  readonly loopbackPortMode: 'observe' | 'exact';
}

/** Stage A is observation-only for client records created before redirect-policy normalization. */
export const stageALegacyRedirectRollout: OAuthLegacyRedirectRollout = {
  unsafeLegacyMode: 'observe',
  loopbackPortMode: 'observe',
};
