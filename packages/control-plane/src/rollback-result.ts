import type { AccessMode } from '@noodle-borg/module';

export type RollbackResult =
  | {
      readonly ok: true;
      readonly deploymentId: string;
      readonly serverVersion?: string;
      readonly previousDeploymentId?: string;
      readonly alreadyActive: boolean;
      readonly accessMode: AccessMode;
      readonly ownerSubject?: string;
      readonly previousAccessMode?: AccessMode;
      readonly serverName: string;
      readonly createdAt: string;
    }
  | {
      readonly ok: false;
      readonly status: 404 | 409;
      readonly code?: 'deployment_locked';
      readonly error: string;
    };
