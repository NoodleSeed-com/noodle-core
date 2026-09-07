/**
 * Knowledge control-plane wiring: binds `wireKnowledge` to the service's managed config store so
 * BYO provider references (names in the manifest) resolve to operator-set values at crawl time.
 */
import { wireKnowledge } from '@noodle-borg/knowledge-operations/portable';
import type { ConfigStore } from './store/config-values.js';
import { resolveConfigScope } from './store/config-values.js';

export function wireServiceKnowledge(
  registry: Parameters<typeof wireKnowledge>[0],
  knowledge: Parameters<typeof wireKnowledge>[1],
  configStore: Pick<ConfigStore, 'resolveConfigValues'>,
  maxBodyBytes: number,
): ReturnType<typeof wireKnowledge> {
  return wireKnowledge(
    registry,
    knowledge,
    (tenant) => configStore.resolveConfigValues('variable', resolveConfigScope(tenant)),
    maxBodyBytes,
    (tenant) => configStore.resolveConfigValues('secret', resolveConfigScope(tenant)),
  );
}
