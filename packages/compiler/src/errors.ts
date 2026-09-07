import type { AppPackageArtifactV1 } from '@noodle-borg/app-package';
import type { RuntimeArtifact } from './artifact/types.js';
import type { PackagedAsset } from './assets.js';

export type CompileErrorCode =
  | 'invalid_context_provider'
  | 'yaml_parse_error'
  | 'invalid_shape'
  | 'invalid_name'
  | 'duplicate_name'
  | 'reserved_name'
  | 'unsupported_manifest_version'
  // Core v1 reserved surface (ADR 0150): named by the spec, rejected until a future version lands it.
  | 'reserved_for_future_version'
  | 'invalid_operation_ref'
  | 'external_ref'
  // Schema `$use` resolution errors:
  | 'invalid_schema_ref'
  | 'unknown_schema_ref'
  | 'schema_ref_conflict'
  // Expression + flow-fulfilment errors:
  | 'invalid_expression'
  | 'expr_unknown_root'
  | 'expr_root_unavailable'
  | 'expr_operator_not_allowed'
  | 'expr_if_not_boolean'
  | 'unknown_step_ref'
  | 'forward_step_ref'
  | 'self_step_ref'
  | 'duplicate_step_id'
  | 'invalid_fulfilment'
  | 'invalid_elicitation_schema'
  | 'invalid_elicitation_flow'
  | 'invalid_confirmation_flow'
  | 'arg_type_mismatch'
  | 'ambient_context_action'
  // Resource + prompt errors:
  | 'duplicate_resource'
  | 'duplicate_prompt'
  | 'duplicate_resource_uri'
  | 'unsupported_uri_template'
  // Widget (MCP Apps) errors:
  | 'duplicate_widget'
  | 'unknown_widget_tool'
  | 'unknown_widget_action_tool'
  | 'duplicate_widget_tool'
  | 'invalid_widget_binding'
  | 'invalid_widget_state_handle'
  | 'widget_html_too_large'
  | 'widget_html_total_too_large'
  | 'invalid_asset'
  | 'invalid_capability_requirement'
  | 'state_secret_field'
  // Knowledge (ADR 0202):
  | 'invalid_knowledge'
  | 'knowledge_unhashed'
  | 'invalid_managed_collection'
  // Resolution errors (only produced when a connector catalog is supplied):
  | 'unknown_connector_alias'
  | 'connector_not_in_catalog'
  | 'unknown_operation'
  | 'connector_binding_required'
  | 'unsupported_credential_profile'
  | 'credential_scope_mismatch'
  | 'credential_audience_mismatch'
  // Auth-derived customer connector endpoint compilation:
  | 'customer_endpoint_auth_required'
  | 'customer_endpoint_mapping_required'
  | 'customer_endpoint_unknown_mapping'
  | 'customer_endpoint_bridge_unsupported'
  | 'assistant_capability_unknown'
  | 'assistant_public_user_reference'
  | 'assistant_public_effect_unconfirmed'
  | 'customer_endpoint_action_unsupported'
  | 'customer_endpoint_surface_unsupported'
  | 'customer_endpoint_credential_source_unsupported'
  | 'customer_endpoint_policy_conflict'
  | 'customer_endpoint_routing_inconsistent'
  | 'unused_connector_alias'
  | 'arg_mismatch'
  | 'agent_guide_invalid'
  | 'agent_guide_duplicate_workflow'
  | 'agent_guide_duplicate_example'
  | 'agent_guide_example_workflow_missing'
  | 'agent_guide_capability_missing'
  | 'agent_guide_capability_kind'
  | 'app_package_sensitive_content';

export interface CompileError {
  readonly code: CompileErrorCode;
  /** Dotted path to the offending location (e.g. `tools.1.name`); empty string for the document root. */
  readonly path: string;
  readonly message: string;
  // Optional, additive, generation-friendly fields (GT-1). Present only on errors that can offer them;
  // existing `{code, path, message}` consumers are unaffected. See `suggest.ts` and docs/STATUS.md.
  /** Closest known identifier when a reference misses by a likely typo (a single correction). */
  readonly didYouMean?: string;
  /** Up to a few ranked candidate identifiers the reference could have meant (the candidate set). */
  readonly suggestions?: readonly string[];
  /** What the compiler expected, for value/version-shaped misses (e.g. a missing catalog entry). */
  readonly expected?: string;
  /** What it actually saw (e.g. the unknown operation name, the missing connector ref). */
  readonly got?: string;
  /** Stable, machine-readable docs anchor for this error code (e.g. `compile-errors#unknown-operation`). */
  readonly docAnchor?: string;
}

/**
 * A non-fatal compile diagnostic — the artifact still compiles, but the author should know
 * (e.g. a brand accent that vanishes into its background). Shaped like {@link CompileError} minus
 * the typo/suggestion machinery; `code` is a stable string for machine consumers and docs anchors.
 */
export interface CompileWarning {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

/** Discriminated result of {@link compile}: either a runtime artifact or a list of errors. */
export type CompileResult =
  | {
      readonly ok: true;
      readonly artifact: RuntimeArtifact;
      readonly appPackage?: AppPackageArtifactV1;
      readonly localAssets?: readonly PackagedAsset[];
      readonly warnings?: readonly CompileWarning[];
    }
  | { readonly ok: false; readonly errors: readonly CompileError[] };
