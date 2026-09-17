import type { WebCapability, WebExtractResult } from '@noodle-borg/managed-capabilities';
import {
  CapabilityError,
  WEB_CONNECTOR_ID,
  WEB_CONNECTOR_VERSION,
  WEB_OPERATION_SIGNATURE,
  webOperationInputSchema,
} from '@noodle-borg/managed-capabilities';
import { type Connector, type ConnectorCall, ConnectorInvocationError } from './connector/types.js';

export type WebCapabilityExecutionPort = (
  declaration: WebCapability,
  request: unknown,
  call: ConnectorCall,
) => Promise<WebExtractResult>;

/** Thin ordinary connector; deployment binding and policy authority are injected by the service. */
export class WebCapabilityConnector implements Connector {
  readonly id = WEB_CONNECTOR_ID;
  readonly version = WEB_CONNECTOR_VERSION;
  constructor(
    private readonly declarations: readonly WebCapability[],
    private readonly execute: WebCapabilityExecutionPort,
  ) {}
  signature(operation: string) {
    return operation === 'extract' ? WEB_OPERATION_SIGNATURE : undefined;
  }
  executionBoundMs() {
    return 30_000;
  }
  async invoke(
    call: ConnectorCall,
  ): Promise<
    WebExtractResult & { readonly __noodleResultMeta: Readonly<Record<string, unknown>> }
  > {
    const input = webOperationInputSchema.safeParse(call.args);
    const declaration = input.success
      ? this.declarations.find((value) => value.name === input.data.name)
      : undefined;
    if (
      call.operation !== 'extract' ||
      declaration === undefined ||
      !input.success ||
      call.capabilityBudget === undefined
    ) {
      throw new ConnectorInvocationError('capability_policy_denied', { retryable: false });
    }
    try {
      return {
        ...(await this.execute(declaration, input.data.request, call)),
        __noodleResultMeta: { 'noodle/ephemeralEvidence': true },
      };
    } catch (error) {
      throw new ConnectorInvocationError(
        error instanceof CapabilityError ? error.code : 'capability_unavailable',
        { retryable: false },
      );
    }
  }
}
