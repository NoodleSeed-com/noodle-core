// Curated one-line fixes for each compiler CompileErrorCode.
//
// This is the human-authored half of the compile-errors skill reference: the codes are
// generated from packages/compiler/src/errors.ts (see ../generated/surface.ts), and each
// gets a concrete repair instruction here. The drift gate
// (../../test/skill-drift-gate.test.ts) fails when a code has no fix, so a new error code
// cannot ship without author guidance. Keep each fix one line, third-person, and actionable.

export const ERROR_FIXES: Record<string, string> = {
  yaml_parse_error:
    'Author in TypeScript; this means the compiled manifest was malformed — re-run from server.ts, do not hand-edit manifest data.',
  invalid_shape:
    'A field has the wrong type or structure; match the shape the compiler reports under `path` against the SDK builder you used.',
  invalid_name:
    'Rename the identifier to match the allowed pattern (lowercase, no spaces/reserved characters) cited at `path`.',
  reserved_name:
    'Rename the reserved identifier; `__noodleIntent` and future managed-collection `submit_<name>` tools are platform-owned, while application context uses one explicit zero-input tool with `contextProvider: true`.',
  invalid_context_provider:
    'Designate at most one normal tool with `contextProvider: true`, and give it an empty object input schema.',
  duplicate_name: 'Two tools/components share a name; give each a unique name at the cited `path`.',
  unsupported_manifest_version:
    'Update the SDK/CLI so the emitted manifest version is supported; do not pin an old manifest shape.',
  reserved_for_future_version:
    'The verb at `path` (currently `compute` as a flow step) is reserved for a future core version; express the step with `use` (a connector operation), `map` (a pure mapping), or the shipped `ctx.elicit` input primitive instead.',
  invalid_operation_ref:
    'Fix the connector operation reference to `alias.operation` for an operation that exists on that connector.',
  external_ref:
    'Remove the external/remote `$ref`; schemas must be self-contained — inline the definition instead of dereferencing a URL.',
  invalid_schema_ref:
    'Correct the `$use` schema reference syntax at `path`; it does not name a resolvable local schema.',
  unknown_schema_ref:
    'The `$use` target does not exist; define the referenced schema or fix the name (see `didYouMean`/`suggestions`).',
  schema_ref_conflict:
    'Two schema references collide; rename one so a single `$use` target resolves unambiguously.',
  invalid_expression: 'Fix the `${...}` expression syntax at `path`; it does not parse.',
  expr_unknown_root:
    'The expression references an unknown root; use a declared input/step/connector root (see `suggestions`).',
  expr_root_unavailable:
    'The referenced root is not in scope at this step; reference only inputs and prior steps, never later ones.',
  expr_operator_not_allowed:
    'Remove the disallowed operator from the expression; only the supported safe operators (e.g. `??`) are permitted.',
  expr_if_not_boolean:
    'The `if` condition must evaluate to a boolean; adjust the expression so it yields true/false.',
  unknown_step_ref:
    'The flow references a step id that does not exist; fix the step name (see `didYouMean`).',
  forward_step_ref:
    'A step references a later step; reorder so each step only reads from steps recorded before it.',
  self_step_ref: 'A step references its own output; remove the self-reference.',
  duplicate_step_id:
    'Two recorded steps share an id; the recorder derives ids from calls — restructure so each connector call is distinct.',
  invalid_fulfilment:
    'The `fulfil` function records something the compiler cannot model (e.g. branching on a runtime value); record a linear sequence of connector calls and use declarative conditions.',
  invalid_elicitation_schema:
    'Make the requested input a flat object of supported string/number/boolean/enum fields with no credential-shaped keys, and keep `required` names aligned with declared properties.',
  invalid_elicitation_flow:
    'Move every `ctx.elicit` before the first connector operation in the flow, so suspension cannot strand an already-applied side effect.',
  invalid_confirmation_flow:
    'Limit a tool marked `confirm: true` to one connector operation, or split the workflow so its complete resolved action can be reviewed and bound.',
  arg_type_mismatch:
    'A connector call argument has the wrong type; match the operation input type shown under `expected`/`got`.',
  ambient_context_action:
    'Replace the ambient provider call at `path` with a read-only connector operation; per-invocation context resolution must not cause side effects.',
  duplicate_resource: 'Two resources share an identity; give each `resource(...)` a unique name.',
  duplicate_prompt: 'Two prompts share a name; rename one `prompt(...)`.',
  duplicate_resource_uri: 'Two resources resolve to the same URI; make each resource URI unique.',
  unsupported_uri_template:
    'Fix the resource URI template to a supported form at the cited `path`.',
  duplicate_widget:
    'Two tool views share an identity; give each `viewName` or `view.component` a unique name.',
  unknown_widget_tool:
    'The widget references a tool that does not exist; point `tool`/`view` at a declared tool (see `didYouMean`).',
  unknown_widget_action_tool:
    'A widget action calls a tool that is not declared; declare it or fix the action target name.',
  duplicate_widget_tool:
    'A tool is bound to more than one widget; bind each tool to a single widget.',
  invalid_widget_binding:
    'Fix the `data-bind`/binding expression in the widget; it does not resolve against the tool output.',
  invalid_widget_state_handle:
    'Correct the state handle reference; declare it under `server(..., { state: { handles } })` and reference it by its declared name.',
  widget_html_too_large:
    'Reduce the compiled widget below 10 MiB UTF-8 (or raw HTML below 256 KiB) by moving large media and dynamic data into hosted resources or bounded app-only tools.',
  widget_html_total_too_large:
    'Reduce aggregate widget HTML below 20 MiB UTF-8; share or externalize large payloads instead of duplicating them across initial widget resources.',
  invalid_asset:
    'Fix the `asset("./path")` reference; the file must exist and be a supported asset type.',
  invalid_capability_requirement:
    'Correct the declared capability/permission requirement to a supported value.',
  state_secret_field:
    'Remove the secret-shaped field from widget/handle state; secrets must never be stored in state or sent to widgets.',
  invalid_knowledge:
    'Fix the `knowledge()` declaration: documents must be existing UTF-8 `.md`/`.txt` files inside the project root (no symlinks), within the 100-file / 1 MiB / 25 MiB bounds, and sites need an exact HTTPS origin plus at least one include glob.',
  knowledge_unhashed:
    'Compile from the project root (`noodle validate`/`noodle dev`) so declared knowledge documents can be read and hashed.',
  invalid_managed_collection:
    'Fix the `managedCollection()` declaration: use a bounded, closed Zod object without credential, payment-card, government-identity, health, or biometric field names.',
  invalid_variable_declaration:
    'Fix the typed `variable()` declaration: use a bounded closed schema, a matching JSON default, plain Portal metadata, existing requiredFor tool names, and one consistent definition per key.',
  invalid_managed_collection_source:
    'Bind the declared source connector and select read-only scan operations whose closed normalized envelopes use the collection record schema exactly.',
  unknown_connector_alias:
    'The tool calls a connector alias not declared in `use`/`provides`; add it or fix the alias (see `suggestions`).',
  connector_not_in_catalog:
    'The referenced connector is not in the resolved catalog; add it to the project connectors or correct the reference.',
  unknown_operation:
    'The connector has no such operation; use an operation declared on that connector (see `didYouMean`/`suggestions`).',
  connector_binding_required:
    'Bind the connector alias with `bind(connector, { profile, connection })`; credential-requiring operations cannot use an unbound alias.',
  unsupported_credential_profile:
    'Select a credential profile declared by the connector and accepted by the operation; use the reported suggestions instead of inventing a profile name.',
  credential_scope_mismatch:
    'Declare a connection source whose scopes include every operation-required scope, or select an external exchange provider that can mint them.',
  credential_audience_mismatch:
    'Set the connection source audience to the operation-required audience exactly, or use an external exchange provider that can mint it.',
  customer_endpoint_auth_required:
    'Protect the app with direct or federated `customerAuth` OIDC and map every reachable `customerEndpoint` key under auth routing.',
  customer_endpoint_mapping_required:
    'Add the endpoint key at the cited auth routing path; every direct/federated issuer must map every customer endpoint used by the app.',
  customer_endpoint_unknown_mapping:
    'Remove the unknown or unused auth routing key, or use that exact declared `customerEndpoint` key from a reachable connector operation.',
  customer_endpoint_bridge_unsupported:
    'Replace the Firebase/Microsoft bridge with direct or federated OIDC before using auth-derived customer connector endpoints.',
  customer_endpoint_action_unsupported:
    'Set exact `annotations.confirm: true` on the enclosing tool, or keep the customer-routed operation read-only; action hints alone do not enable confirmation.',
  assistant_capability_unknown:
    'Name a tool, resource, or prompt this server declares in `embeddedAssistant({ capabilities })`, or remove the entry; capabilities reference declared components, not arbitrary names.',
  assistant_public_user_reference:
    'Remove the `${user...}` reference from this tool or drop it from the public assistant `capabilities`; a public website visitor is anonymous, so there is no signed-in user to read.',
  assistant_public_effect_unconfirmed:
    'Add `annotations.readOnly()` if this projected tool only reads, or `{ confirm: true }` if it causes an external effect; a public assistant never reaches an unconfirmed side effect.',
  customer_endpoint_surface_unsupported:
    'Move the customer-routed call into a tool fulfilment; routed resources, prompts, and ambient providers are unsupported.',
  customer_endpoint_credential_source_unsupported:
    'Remove the manifest connection binding; a customer-routed connector uses its declared delegated token exchange auth or no auth.',
  customer_endpoint_policy_conflict:
    'Give every reachable declaration of this endpoint key one identical policy, or rename keys whose allowed origins differ.',
  customer_endpoint_routing_inconsistent:
    'Regenerate the connector catalog so every action route includes all of its ordinary customer endpoint dependencies.',
  unused_connector_alias:
    'A declared connector alias is never called; remove the unused `use` entry or wire it into a tool.',
  arg_mismatch:
    'A connector call is missing or adds arguments; match the operation signature under `expected`/`got`.',
  agent_guide_invalid:
    'Correct the product guide shape in `server(..., { agentGuide })` using non-empty bounded prose and symbolic references.',
  agent_guide_duplicate_workflow:
    'Give every `agentGuide.workflows` entry a unique lowercase underscore id.',
  agent_guide_duplicate_example: 'Keep each agent-guide prompt and workflow pairing unique.',
  agent_guide_example_workflow_missing:
    'Point the example workflow at an existing `agentGuide.workflows` id.',
  agent_guide_capability_missing:
    'Correct the capability kind/name in `server(..., { agentGuide })` to a declared MCP capability.',
  agent_guide_capability_kind:
    'Correct the capability kind/name in `server(..., { agentGuide })` to match its declared MCP capability.',
  app_package_sensitive_content:
    'Remove the credential value; reference managed config by name only.',
};
