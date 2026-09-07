import {
  type HostPackageAdapter,
  type HostPackageRequest,
  type HostPackageResult,
  packageHostTarget,
} from '@noodle-borg/agent-packaging';
import { renderAnthropicConnector } from './anthropic-connector-render.js';
import type { AnthropicConnectorOptions } from './anthropic-connector-types.js';
import {
  validateAnthropicConnectorInput,
  validateAnthropicConnectorOptions,
} from './anthropic-connector-validation.js';

export const ANTHROPIC_CONNECTOR_ADAPTER_VERSION = '1.0.0';

/** Render an offline operator dossier for Anthropic's remote Connector Directory portal. */
export function packageAnthropicConnector(
  request: HostPackageRequest,
  options: AnthropicConnectorOptions,
): HostPackageResult {
  const validatedOptions = validateAnthropicConnectorOptions(options);
  const adapter: HostPackageAdapter = {
    target: 'anthropic-connector',
    version: ANTHROPIC_CONNECTOR_ADAPTER_VERSION,
    validate: (input) => [
      ...validatedOptions.issues,
      ...validateAnthropicConnectorInput(input, validatedOptions.options),
    ],
    render: (input) => {
      if (validatedOptions.options === undefined) {
        throw new Error('Anthropic connector options were not validated');
      }
      return renderAnthropicConnector(input, validatedOptions.options);
    },
  };
  return packageHostTarget(request, adapter);
}

export type * from './anthropic-connector-types.js';
