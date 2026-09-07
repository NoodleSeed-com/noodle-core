import type { RuntimeArtifact } from '@noodle-borg/compiler';
import { type EndpointUrlOptions, tenantMcpUrl } from '@noodle-borg/module';
import type { ServerRegistry } from '../registry.js';
import type { DeploymentSummary, TenantRef } from '../store.js';
export async function inspectServiceDeployment(
  registry: Pick<ServerRegistry, 'getStatus' | 'getActiveByTenant'>,
  tenant: TenantRef,
  baseUrl: string,
  endpointOptions: EndpointUrlOptions = {},
): Promise<InspectResponse | undefined> {
  const status = await registry.getStatus(tenant, baseUrl, undefined, endpointOptions);
  if (status === undefined) return undefined;
  const target = await registry.getActiveByTenant(tenant).catch(() => undefined);
  const surface = target !== undefined ? surfaceSummary(target.served.artifact) : emptySurface();
  return {
    ok: true,
    target: status.target,
    deployment: status.deployment,
    health: {
      state: status.health.state,
      missingSecrets: status.config.missingSecrets,
    },
    surface,
    findings: findingsFor(status.health.state, surface),
  };
}
function surfaceSummary(artifact: RuntimeArtifact): SurfaceSummary {
  const resources = artifact.resources ?? [];
  const widgets = resources.filter((resource) => resource.mimeType === 'text/html;profile=mcp-app');
  const widgetUris = new Set(widgets.map((widget) => widget.uri));
  const widgetLinkedTools = artifact.tools
    .filter((tool) => tool._meta?.ui?.resourceUri !== undefined)
    .map((tool) => ({ name: tool.name, resourceUri: tool._meta?.ui?.resourceUri as string }));
  const appOnlyTools = artifact.tools
    .filter((tool) => {
      const visibility = tool._meta?.ui?.visibility;
      return visibility?.length === 1 && visibility[0] === 'app';
    })
    .map((tool) => ({ name: tool.name }));
  return {
    tools: artifact.tools.map((tool) => ({ name: tool.name, description: tool.description })),
    resources: resources.map((resource) => ({
      uri: resource.uri,
      name: resource.name,
      ...(resource.mimeType !== undefined ? { mimeType: resource.mimeType } : {}),
    })),
    prompts: (artifact.prompts ?? []).map((prompt) => ({
      name: prompt.name,
      ...(prompt.description !== undefined ? { description: prompt.description } : {}),
    })),
    widgets: widgets.map((widget) => ({
      uri: widget.uri,
      name: widget.name,
      ...(widget._meta?.ui?.csp !== undefined ? { csp: widget._meta.ui.csp } : {}),
      ...(widget._meta?.ui?.permissions !== undefined
        ? { permissions: widget._meta.ui.permissions }
        : {}),
    })),
    widgetLinkedTools,
    appOnlyTools,
    compatibility: {
      mcpApps: widgetLinkedTools.every((tool) => widgetUris.has(tool.resourceUri))
        ? 'pass'
        : 'warn',
      chatgpt: 'unverified',
      claude: 'unverified',
    },
  };
}

function emptySurface(): SurfaceSummary {
  return {
    tools: [],
    resources: [],
    prompts: [],
    widgets: [],
    widgetLinkedTools: [],
    appOnlyTools: [],
    compatibility: { mcpApps: 'pass', chatgpt: 'unverified', claude: 'unverified' },
  };
}

function findingsFor(health: string, surface: SurfaceSummary): readonly ServiceDiagnosticFinding[] {
  const findings: ServiceDiagnosticFinding[] = [];
  if (health !== 'ready') {
    findings.push({
      level: health === 'missing-config' ? 'fail' : 'warn',
      code: health,
      message: `deployment health is ${health}`,
    });
  }
  if (surface.compatibility.mcpApps !== 'pass') {
    findings.push({
      level: 'warn',
      code: 'widget_link_missing',
      message: 'one or more widget-linked tools reference missing UI resources',
    });
  }
  return findings;
}

type Compatibility = 'pass' | 'warn' | 'unverified';

export function inspectCompiledServiceDeployment(
  deployment: DeploymentSummary,
  artifact: RuntimeArtifact,
  baseUrl: string,
  endpointOptions: EndpointUrlOptions = {},
): InspectResponse {
  const target = {
    org: deployment.orgSlug,
    app: deployment.appSlug,
    env: deployment.environment,
  };
  const surface = surfaceSummary(artifact);
  return {
    ok: true,
    target,
    deployment: {
      deploymentId: deployment.deploymentId,
      endpointUrl: tenantMcpUrl(baseUrl, target, deployment.serverVersion, endpointOptions),
      active: deployment.active,
      serverName: deployment.serverName,
      createdAt: deployment.createdAt,
      ...(deployment.createdByEmail === undefined
        ? {}
        : { createdByEmail: deployment.createdByEmail }),
      accessMode: deployment.accessMode,
      ...(deployment.ownerSubject !== undefined ? { ownerSubject: deployment.ownerSubject } : {}),
    },
    health: { state: 'ready', missingSecrets: [] },
    surface,
    findings: findingsFor('ready', surface),
  };
}

interface SurfaceSummary {
  readonly tools: readonly { readonly name: string; readonly description: string }[];
  readonly resources: readonly {
    readonly uri: string;
    readonly name: string;
    readonly mimeType?: string;
  }[];
  readonly prompts: readonly { readonly name: string; readonly description?: string }[];
  readonly widgets: readonly {
    readonly uri: string;
    readonly name: string;
    readonly csp?: unknown;
    readonly permissions?: unknown;
  }[];
  readonly widgetLinkedTools: readonly { readonly name: string; readonly resourceUri: string }[];
  readonly appOnlyTools: readonly { readonly name: string }[];
  readonly compatibility: {
    readonly mcpApps: Compatibility;
    readonly chatgpt: Compatibility;
    readonly claude: Compatibility;
  };
}

interface ServiceDiagnosticFinding {
  readonly level: 'warn' | 'fail';
  readonly code: string;
  readonly message: string;
}

export interface InspectResponse {
  readonly ok: true;
  readonly target: TenantRef;
  readonly deployment: {
    readonly deploymentId: string;
    readonly endpointUrl: string;
    readonly active: boolean;
    readonly serverName: string;
    readonly createdAt: string;
    readonly createdByEmail?: string;
    readonly accessMode: string;
    readonly ownerSubject?: string;
  };
  readonly health: { readonly state: string; readonly missingSecrets: readonly string[] };
  readonly surface: SurfaceSummary;
  readonly findings: readonly ServiceDiagnosticFinding[];
}
