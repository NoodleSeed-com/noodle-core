import type { RuntimeArtifact } from '@noodle-borg/compiler';
import { parseUriTemplate } from '@noodle-borg/uri-template';
import type { ProtocolObservation } from '../observation.js';

const KNOWN_PROTOCOL_ERROR_CODES = new Set([
  -32700, -32600, -32601, -32603, -32001, -32002, -32003,
]);

const REQUEST_STATE_REASONS = new Set([
  'invalid_request_state',
  'request_state_verification_failed',
  'request_state_expired',
  'request_state_binding_mismatch',
  'request_state_argument_mismatch',
  'missing_request_state',
  'unexpected_input_response_key',
  'invalid_input_response_shape',
  'dropped_input_response_envelope',
  'confirmation_replay',
  'confirmation_ledger_unavailable',
]);

/** Classify an SDK-owned error without retaining request arguments, headers, or response payloads. */
export function protocolErrorObservation(
  artifact: RuntimeArtifact,
  requestBody: unknown,
  responseBody: unknown,
  status: number,
): ProtocolObservation | undefined {
  const response = isRecord(responseBody) ? responseBody : undefined;
  const error = response !== undefined && isRecord(response.error) ? response.error : undefined;
  const code = typeof error?.code === 'number' ? error.code : undefined;
  if (status < 400 && code === undefined) return undefined;

  const method = requestMethod(requestBody) ?? 'unknown';
  return {
    method,
    ...requestTarget(artifact, method, requestBody),
    outcome: 'mcp_error',
    errorKind: errorKind(code, error?.data),
  };
}

function errorKind(code: number | undefined, data: unknown): string {
  if (code === -32020) return 'modern_header_mismatch';
  if (code === -32021) return 'missing_required_client_capability';
  if (code === -32022) return 'unsupported_protocol_version';
  if (code === -32602) {
    const reason = isRecord(data) && typeof data.reason === 'string' ? data.reason : undefined;
    return reason !== undefined && REQUEST_STATE_REASONS.has(reason) ? reason : 'invalid_params';
  }
  return code !== undefined && KNOWN_PROTOCOL_ERROR_CODES.has(code)
    ? `protocol_error_${code}`
    : 'protocol_error';
}

function requestTarget(
  artifact: RuntimeArtifact,
  method: string,
  body: unknown,
): Pick<ProtocolObservation, 'toolName' | 'resourceName' | 'promptName'> {
  const params = isRecord(body) && isRecord(body.params) ? body.params : undefined;
  if (method === 'tools/call' && typeof params?.name === 'string') {
    const tool = artifact.tools.find((candidate) => candidate.name === params.name);
    return tool === undefined ? {} : { toolName: tool.name };
  }
  if (method === 'resources/read' && typeof params?.uri === 'string') {
    const uri = params.uri;
    const resource = artifact.resources?.find((candidate) => resourceMatches(candidate, uri));
    return resource === undefined ? {} : { resourceName: resource.name };
  }
  if (method === 'prompts/get' && typeof params?.name === 'string') {
    const prompt = artifact.prompts?.find((candidate) => candidate.name === params.name);
    return prompt === undefined ? {} : { promptName: prompt.name };
  }
  return {};
}

function resourceMatches(
  resource: NonNullable<RuntimeArtifact['resources']>[number],
  uri: string,
): boolean {
  if (!resource.isTemplate) return resource.uri === uri;
  const parsed = parseUriTemplate(resource.uri);
  return parsed.ok && parsed.value.kind === 'template' && parsed.value.match(uri) !== null;
}

function requestMethod(body: unknown): string | undefined {
  return isRecord(body) && typeof body.method === 'string' ? body.method : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
