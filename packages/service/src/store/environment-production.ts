/** Outcome of atomically designating one existing environment as an app's production environment. */
export interface ProductionEnvironmentChange {
  readonly orgSlug: string;
  readonly appSlug: string;
  readonly productionEnvironment: string;
  readonly previousProductionEnvironment: string | null;
  readonly changed: boolean;
}
