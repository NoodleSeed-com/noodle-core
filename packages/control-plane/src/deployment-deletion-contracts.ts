export type DeploymentDeleteSelection =
  | { readonly kind: 'deployment'; readonly deploymentId: string }
  | {
      readonly kind: 'version';
      readonly serverVersion?: string;
      readonly expectedDeploymentIds: readonly string[];
    };

export type DeploymentDeleteResult<
  Record extends { readonly deploymentId: string } = { readonly deploymentId: string },
> =
  | { readonly ok: true; readonly deleted: readonly Record[] }
  | {
      readonly ok: false;
      readonly code:
        | 'deployment_not_found'
        | 'version_not_found'
        | 'active_deployment'
        | 'deployment_locked'
        | 'app_archived'
        | 'deployment_delete_conflict';
    };
