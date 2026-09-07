import type { ModuleSqlTransaction } from './sql-transaction.js';

export const DEPLOYMENT_ACTIVATION_PHASE = {
  COMMERCIAL_AUTHORITY: 'commercial-authority',
  AUTOMATION_FRESHNESS: 'automation-freshness',
} as const;

export type DeploymentActivationPhase =
  (typeof DEPLOYMENT_ACTIVATION_PHASE)[keyof typeof DEPLOYMENT_ACTIVATION_PHASE];

export type DeploymentActivationErrorCode =
  | 'automation_superseded'
  | 'production_app_limit_exceeded'
  | 'billing_enforcement_unavailable';

/** A typed module rejection that the public activation owner can map without provider knowledge. */
export class DeploymentActivationError extends Error {
  readonly code: DeploymentActivationErrorCode;

  constructor(code: DeploymentActivationErrorCode) {
    super(code);
    this.name = 'DeploymentActivationError';
    this.code = code;
  }
}

export interface DeploymentActivationTarget {
  readonly operation: 'append' | 'activate' | 'restore';
  readonly org: string;
  readonly app: string;
  readonly environment?: string;
  readonly deploymentId?: string;
  readonly serverVersion?: string;
  readonly automationId?: string;
}

export interface NamedDeploymentActivationHook {
  readonly id: string;
  readonly phase: DeploymentActivationPhase;
  prepare(
    transaction: ModuleSqlTransaction,
    target: DeploymentActivationTarget,
  ): unknown | Promise<unknown>;
  assert(
    transaction: ModuleSqlTransaction,
    target: DeploymentActivationTarget,
    prepared: unknown,
  ): void | Promise<void>;
}
