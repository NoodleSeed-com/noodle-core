import { InMemoryDailyCounterStore } from '@noodle-borg/admission-limits/portable';
import { PublicPageReader } from '@noodle-borg/knowledge-crawl';
import {
  CapabilityService,
  InMemoryCapabilityPolicyStore,
} from '@noodle-borg/managed-capabilities';

/** Loopback-only composition. Keep PostgreSQL imports out of the published CLI graph. */
export function localWebCapabilities(): CapabilityService {
  return new CapabilityService({
    profile: 'development',
    policies: new InMemoryCapabilityPolicyStore(),
    counters: new InMemoryDailyCounterStore(),
    reader: new PublicPageReader(),
  });
}
