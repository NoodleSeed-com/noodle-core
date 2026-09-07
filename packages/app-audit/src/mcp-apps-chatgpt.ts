import { type RuntimeArtifact, requiresToolConfirmation } from '@noodle-borg/compiler';
import type { AuditFinding } from './mcp-apps-audit.js';

type ArtifactTool = RuntimeArtifact['tools'][number];
type ArtifactResource = NonNullable<RuntimeArtifact['resources']>[number];

export function auditChatGptCompatibility(
  artifact: RuntimeArtifact,
  widgetResources: readonly ArtifactResource[],
  linkedTools: readonly ArtifactTool[],
): readonly AuditFinding[] {
  const modelTools = artifact.tools.filter(isModelVisibleTool);
  const strictConfirmTools = modelTools.filter(
    (tool) =>
      requiresToolConfirmation(tool.annotations) &&
      artifact.server.interactions?.confirmationFallback !== 'host',
  );
  const hostFallbackTools = modelTools.filter(
    (tool) =>
      requiresToolConfirmation(tool.annotations) &&
      artifact.server.interactions?.confirmationFallback === 'host',
  );
  const elicitingTools = modelTools.filter(
    (tool) =>
      tool.fulfilment.kind === 'flow' &&
      tool.fulfilment.steps.some((step) => step.kind === 'elicit'),
  );
  const missingOutputTemplate = linkedTools.filter(
    (tool) => typeof tool._meta?.['openai/outputTemplate'] !== 'string',
  );
  const missingDescription = widgetResources.filter(
    (resource) => typeof resource._meta?.['openai/widgetDescription'] !== 'string',
  );
  const missingCsp = widgetResources.filter(
    (resource) =>
      resource._meta?.ui?.csp === undefined && resource._meta?.['openai/widgetCSP'] === undefined,
  );
  const missingDomain = widgetResources.filter(
    (resource) => typeof resource._meta?.ui?.domain !== 'string',
  );
  const camelCaseLegacyCsp = widgetResources.filter((resource) => {
    const legacy = resource._meta?.['openai/widgetCSP'];
    if (legacy === null || typeof legacy !== 'object') return false;
    return Object.keys(legacy).some((key) => /[A-Z]/.test(key));
  });
  const placeholderDomainResources = widgetResources.filter((resource) =>
    widgetDomainStrings(resource).some((domain) => PLACEHOLDER_WIDGET_DOMAIN.test(domain)),
  );
  return [
    {
      code: 'chatgpt_confirmation_compatibility',
      severity:
        strictConfirmTools.length > 0 ? 'error' : hostFallbackTools.length > 0 ? 'warn' : 'info',
      message:
        strictConfirmTools.length > 0
          ? `These tools require a confirmation interaction that ChatGPT's stateless MCP transport cannot present: ${toolNames(strictConfirmTools)}.`
          : hostFallbackTools.length > 0
            ? `These tools explicitly trust ChatGPT's native write approval when Noodle confirmation is unavailable: ${toolNames(hostFallbackTools)}.`
            : 'No model-visible tool depends on an unavailable Noodle confirmation interaction.',
      cause:
        'ChatGPT does not negotiate standard MCP form elicitation on the stateless hosted transport; client names are not trusted as a security capability.',
      fix:
        strictConfirmTools.length > 0
          ? 'Keep strict confirmation for capable hosts, or explicitly set server.interactions.confirmationFallback to "host" and declare accurate action/destructive hints.'
          : 'Treat host fallback as a trust decision, not authorization; keep backend policy and accurate action hints in place.',
      next: 'noodle check --target chatgpt',
    },
    {
      code: 'chatgpt_elicitation_compatibility',
      severity: elicitingTools.length > 0 ? 'warn' : 'info',
      message:
        elicitingTools.length > 0
          ? `These tools use guided input; ChatGPT will continue through a linked MCP App form when available, or through a structured conversational retry: ${toolNames(elicitingTools)}.`
          : 'No model-visible tool depends on unavailable guided input.',
      cause:
        'ChatGPT does not negotiate standard form elicitation on the stateless hosted transport, so Noodle replays the input-only prefix from schema-validated answers without exposing server continuation state.',
      fix: 'Link a React view for the in-app form experience; unlinked tools remain recoverable through the model-visible structured request.',
      next: 'noodle check --target chatgpt',
    },
    {
      code: 'chatgpt_output_template',
      severity: missingOutputTemplate.length === 0 ? 'info' : 'error',
      message:
        missingOutputTemplate.length === 0
          ? 'Widget-linked tools include the OpenAI outputTemplate compatibility alias.'
          : `Widget-linked tools are missing the OpenAI outputTemplate compatibility alias: ${missingOutputTemplate.map((tool) => tool.name).join(', ')}`,
      cause:
        'ChatGPT Apps clients read _meta["openai/outputTemplate"] as the legacy widget template hint while Noodle also emits the standard _meta.ui.resourceUri.',
      fix: 'Recompile with the current Noodle compiler so widget-linked tools include both metadata shapes.',
      next: 'noodle validate && noodle check --target chatgpt',
    },
    {
      code: 'chatgpt_widget_description',
      severity: missingDescription.length === 0 ? 'info' : 'warn',
      message:
        missingDescription.length === 0
          ? 'Widget resources include ChatGPT narration-suppression descriptions.'
          : `Widget resources should include openai/widgetDescription metadata: ${missingDescription.map((resource) => resource.name).join(', ')}`,
      cause:
        'ChatGPT can use a widget description to avoid repeating visible widget content in assistant narration.',
      fix: 'Add concise widget descriptions to React widget declarations.',
      next: 'noodle check --target chatgpt',
    },
    {
      code: 'chatgpt_widget_csp',
      severity: missingCsp.length === 0 ? 'info' : 'warn',
      message:
        missingCsp.length === 0
          ? 'Widget resources expose CSP metadata compatible with ChatGPT review.'
          : `Widget resources need explicit CSP metadata before ChatGPT review: ${missingCsp.map((resource) => resource.name).join(', ')}`,
      cause:
        'ChatGPT review depends on constrained resource and connection domains for iframe widgets.',
      fix: 'Declare the minimal widget CSP domains needed by packaged assets and external requests.',
      next: 'noodle check --target chatgpt',
    },
    {
      code: 'chatgpt_widget_domain',
      severity: missingDomain.length === 0 ? 'info' : 'error',
      message:
        missingDomain.length === 0
          ? 'Widget resources declare a dedicated widget domain (_meta.ui.domain).'
          : `Widget resources have no dedicated domain required for reliable ChatGPT app-version discovery: ${missingDomain.map((resource) => resource.name).join(', ')}`,
      cause:
        'ChatGPT app versions require a dedicated widget domain to expose app actions reliably and use it as the widget sandbox origin.',
      fix: 'Set `domain` on the widget declaration (e.g. domain: "https://myapp.example.com").',
      next: 'noodle check --target chatgpt',
    },
    {
      code: 'chatgpt_widget_placeholder_domain',
      severity: placeholderDomainResources.length === 0 ? 'info' : 'warn',
      message:
        placeholderDomainResources.length === 0
          ? 'Widget domain and CSP entries use real hosts, not the scaffold placeholder.'
          : `Widget domain/CSP still uses the scaffold placeholder host (replace before ChatGPT submission): ${placeholderDomainResources.map((resource) => resource.name).join(', ')}`,
      cause:
        'The `noodle init` widget scaffold ships `your-app.example.com` as a placeholder domain/CSP host. It satisfies the presence checks but is not a real, unique widget domain.',
      fix: 'Replace the placeholder host (`your-app.example.com`, or a bare `example.com`) in the widget `domain` and CSP with your app’s real HTTPS host.',
      next: 'noodle check --target chatgpt',
    },
    {
      code: 'chatgpt_widget_csp_shape',
      severity: camelCaseLegacyCsp.length === 0 ? 'info' : 'error',
      message:
        camelCaseLegacyCsp.length === 0
          ? 'The legacy openai/widgetCSP key uses the snake_case field names ChatGPT parses.'
          : `The legacy openai/widgetCSP key carries camelCase fields ChatGPT ignores (shows as "CSP not set"): ${camelCaseLegacyCsp.map((resource) => resource.name).join(', ')}`,
      cause:
        'ChatGPT parses openai/widgetCSP with snake_case fields only; camelCase fields are silently dropped and the sandbox blocks remote requests.',
      fix: 'Recompile with the current Noodle compiler so the legacy key is emitted in snake_case.',
      next: 'noodle validate && noodle check --target chatgpt',
    },
    {
      code: 'chatgpt_widget_state',
      severity: widgetResources.length > 0 ? 'info' : 'warn',
      message:
        widgetResources.length > 0
          ? 'The shared widget runtime preserves private UI state and model-visible context through ChatGPT widgetState.'
          : 'No widget resources are available to exercise ChatGPT widgetState compatibility.',
      cause:
        'ChatGPT uses window.openai.widgetState/setWidgetState for cross-turn widget state and model-visible context fallback.',
      fix: 'Use the React helper bridge when widget state should persist or inform the model.',
      next: 'noodle devtools --theme both --device both',
    },
  ];
}

function isModelVisibleTool(tool: ArtifactTool): boolean {
  const visibility = tool._meta?.ui?.visibility;
  return !Array.isArray(visibility) || visibility.includes('model');
}

function toolNames(tools: readonly ArtifactTool[]): string {
  return tools.map((tool) => tool.name).join(', ');
}

const PLACEHOLDER_WIDGET_DOMAIN = /^(https?:\/\/)?(www\.)?(your-app\.)?example\.com($|[/:?#])/i;

function widgetDomainStrings(resource: ArtifactResource): string[] {
  const ui = resource._meta?.ui;
  const domains: string[] = [];
  if (typeof ui?.domain === 'string') domains.push(ui.domain);
  const csp = ui?.csp;
  if (csp) {
    for (const list of [csp.connectDomains, csp.resourceDomains, csp.frameDomains]) {
      if (Array.isArray(list)) {
        for (const entry of list) if (typeof entry === 'string') domains.push(entry);
      }
    }
  }
  return domains;
}
