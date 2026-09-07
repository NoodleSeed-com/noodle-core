import {
  type AssistantSessionRecord,
  resolveAssistantSessionTarget,
} from '@noodle-borg/assistant-gateway/portable';
import type { ServerRegistry } from '../registry.js';

/** Adapt the registry to the gateway-owned, surface-projected session target decision. */
export function sessionScopedTarget(registry: ServerRegistry, session: AssistantSessionRecord) {
  return resolveAssistantSessionTarget((deploymentId) => registry.get(deploymentId), session);
}
