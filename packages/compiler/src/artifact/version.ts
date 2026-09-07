/**
 * Version of the runtime-artifact format itself (independent of any tenant manifest version).
 *
 * `0.2.0` (Slice 4): `ArtifactTool.operationRef` moved into a fulfilment-centric `fulfilment` field
 * (operation steps carry their own `operationRef`), and `args`/`output`/`map` values are emitted as
 * parsed expression ASTs. This is a breaking shape change from `0.1.0`.
 *
 * `0.3.0` (Slice 21): additive — optional `resources` and `prompts` arrays (each a fulfilment-backed
 * entity) and the matching `capabilities.resources`/`capabilities.prompts` name lists.
 *
 * `0.4.0` (Slice W1, Apps/widgets): additive — optional `_meta` on `ArtifactTool` and
 * `ArtifactResource` (the MCP `_meta` extension bag), and widgets emitted as fixed `ui://` UI
 * resources (mimeType `text/html;profile=mcp-app`) with the linking tool's `_meta.ui.resourceUri`
 * stamped (MCP Apps; docs/decisions/0022-adopt-mcp-ui-for-apps-widgets.md). A manifest with no widgets
 * and no `_meta` compiles to a byte-identical artifact (apart from this version string).
 *
 * `0.5.0` (Consumer app surface foundation): additive — optional server-level branding tokens and
 * handoff allowlist policy, both normalized as data and consumed by generated widgets.
 *
 * `0.6.0` (Local packaged assets): additive — optional local packaged asset metadata for asset references
 * rewritten during local development.
 *
 * `0.7.0` (Typed state handles): additive — optional server-level state handle declarations consumed by
 * the first-party state connector.
 *
 * `0.8.0` (Unified server brand kit): assistant UI configuration inherits server branding; themed
 * brand assets and portable light/dark semantic overrides are available to every presentation surface.
 *
 * `0.9.0` (Invocation context foundation): additive — optional server defaults plus a resolved,
 * schema-backed ambient-context fulfilment.
 *
 * `0.10.0` (Portable elicitation): additive — executable `elicit` flow steps with a bounded message
 * and the stable MCP form-elicitation schema subset.
 *
 * `0.11.0` (Portable action titles): additive — optional human-readable `title` on tools.
 *
 * `0.12.0` (Host confirmation fallback): additive — an explicit server policy may trust the MCP
 * host's write-approval UX when standard form confirmation is unavailable.
 *
 * `0.13.0` (Connector account bindings): additive — Core v2 connector aliases may carry a logical
 * connection binding, emitted in an alias-keyed table. Sources contain managed reference names only.
 *
 * `0.14.0` (Per-tool authorization): additive — tools may carry normalized required OAuth scopes and
 * allowed application roles for claim-aware discovery and invocation enforcement.
 *
 * `0.15.0` (Auth-derived customer connector endpoints): additive — Core v2 OIDC auth may declare
 * endpoint claim mappings, resolved operation references may carry ordinary/action endpoint dependency
 * keys, and artifacts carry only endpoint policies. Resolved customer URLs remain request-private runtime
 * state.
 *
 * `0.16.0` (Anonymous-to-authenticated onboarding): additive — finite caller-scoped state handles may
 * opt into atomic ownership adoption when a single-use assistant sign-in ticket is spent.
 *
 * `0.17.0` (Managed collection declaration): additive — Core v2 reusable managed-record schema intent
 * may be projected under `server.managedCollections`; lifecycle and operator state remain separate.
 *
 * `0.18.0` (Collection authority): additive — every newly compiled managed collection identifies native
 * authority or exact resolved read-only connector operations for an external replica.
 *
 * `0.19.0` (Business settings): optional typed managed-variable declarations and definition digests.
 */
export const ARTIFACT_SCHEMA_VERSION = '0.19.0';

/** mimeType for an MCP Apps UI resource (SEP-1865). Widgets are served under this profile. */
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';
