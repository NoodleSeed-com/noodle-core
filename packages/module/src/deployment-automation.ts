import type { IncomingMessage } from 'node:http';
import type { AccessMode, ControlPlaneIdentity } from './contract.js';

export interface DeploymentAutomationTarget {
  readonly org: string;
  readonly app: string;
  readonly env: string;
}

export type DeploymentAutomationInput =
  | {
      readonly action: 'asset-preflight';
      readonly request: IncomingMessage;
      readonly target: DeploymentAutomationTarget;
    }
  | {
      readonly action: 'deploy';
      readonly request: IncomingMessage;
      readonly target: DeploymentAutomationTarget;
      readonly previousAccessMode?: AccessMode;
      readonly declaredAccessMode?: string;
      readonly previousOwnerSubject?: string;
    };

export type DeploymentAutomationAuthorization =
  | { readonly kind: 'not-automation' }
  | {
      readonly kind: 'denied';
      readonly status: 400 | 401 | 403 | 409;
      readonly code: string;
      readonly message: string;
    }
  | {
      readonly kind: 'authorized';
      readonly automationId: string;
      readonly actor: ControlPlaneIdentity;
      readonly ownerSubject?: string;
      readonly accessMode?: AccessMode;
      readonly accessModeSource?: 'previous' | 'declared';
    };

export interface DeploymentAutomationAuthorizer {
  authorize(input: DeploymentAutomationInput): Promise<DeploymentAutomationAuthorization>;
  /** Best-effort provider lifecycle update after transactional freshness rejects an activation. */
  recordSuperseded?(input: {
    readonly automationId: string;
    readonly target: DeploymentAutomationTarget;
  }): Promise<void>;
}
