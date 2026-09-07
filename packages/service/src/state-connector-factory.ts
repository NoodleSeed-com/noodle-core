import type { ArtifactState } from '@noodle-borg/compiler';
import {
  type Connector,
  createStateConnector,
  StateConnector,
  type StateHandleStore,
} from '@noodle-borg/runtime';

export type StateHandleStoreFactory = (input: {
  readonly deploymentId: string;
  readonly state: ArtifactState;
}) => StateHandleStore;

export function createDeploymentStateConnector(
  state: ArtifactState | undefined,
  deploymentId: string | undefined,
  storeFactory: StateHandleStoreFactory | undefined,
): Connector | undefined {
  if (state === undefined) return undefined;
  if (deploymentId !== undefined && storeFactory !== undefined) {
    return new StateConnector(storeFactory({ deploymentId, state }));
  }
  return createStateConnector(state);
}
