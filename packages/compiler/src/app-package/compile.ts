import {
  APP_PACKAGE_V1_MAX_SCHEMA_FIELDS,
  APP_PACKAGE_V1_MAX_SURFACE_ITEMS,
  type AppPackageArtifactV1,
  type AppPackageSchemaSummary,
  type AppPackageSurface,
  appPackageArtifactV1Schema,
  compareCodeUnits,
  sensitiveContentFinding,
  sha256Canonical,
} from '@noodle-borg/app-package';
import type { JsonSchema, RuntimeArtifact } from '../artifact/types.js';
import { isPackagedAssetReference } from '../assets.js';
import type { CompileError } from '../errors.js';
import type { Manifest } from '../manifest/schema.js';
import { resolveSchemaUses } from '../manifest/schema-refs.js';
import { suggestionFields } from '../suggest.js';

export const APP_PACKAGE_SENSITIVE_ERROR: CompileError = {
  code: 'app_package_sensitive_content',
  path: 'server.agentGuide',
  message: 'agent guide package contains credential-shaped content',
};

const GENERIC_BOUNDS_ERROR: CompileError = {
  code: 'agent_guide_invalid',
  path: 'server.agentGuide',
  message: 'agent guide package is outside App Package V1 bounds',
};

/** Scan only fields eligible for the App Package projection before value-bearing semantic diagnostics. */
export function preflightAppPackageSensitiveContent(manifest: Manifest): boolean {
  if (manifest.manifestVersion !== '2' || manifest.server.agentGuide === undefined) return false;
  const schemas = manifest.schemas ?? {};
  const safeSurfaceSource = {
    app: {
      name: manifest.server.name,
      title: manifest.server.title,
      version: manifest.server.version,
      branding: projectBranding(manifest.server.branding),
    },
    skill: manifest.server.agentGuide,
    surface: {
      auth:
        manifest.server.auth === undefined
          ? { required: false }
          : { required: true, kind: manifest.server.auth.kind },
      tools: manifest.tools.map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        input: summarize(resolveSchemaUses(tool.inputSchema, schemas, '').schema),
        output:
          tool.outputSchema === undefined
            ? undefined
            : summarize(resolveSchemaUses(tool.outputSchema, schemas, '').schema),
        authorization: tool.authorization,
        visibility: normalizeVisibility(tool.visibility),
      })),
      resources: (manifest.resources ?? []).map((resource) => ({
        name: resource.name,
        uri: resource.uri,
        title: resource.title,
        description: resource.description,
        mimeType: resource.mimeType,
      })),
      prompts: (manifest.prompts ?? []).map((prompt) => ({
        name: prompt.name,
        title: prompt.title,
        description: prompt.description,
        arguments: prompt.arguments,
      })),
      widgets: (manifest.widgets ?? []).map((widget) => ({
        name: widget.name,
        title: widget.title,
        description: widget.description,
        tool: widget.tool,
      })),
    },
  };
  return sensitiveContentFinding(safeSurfaceSource) !== undefined;
}

interface CompileAppPackageInput {
  readonly manifest: Manifest;
  readonly artifact: RuntimeArtifact;
  readonly sourceManifest: Manifest;
}

/** Self-contained App Package projection for callers that have not run compiler preflight. */
export function compileAppPackage(input: CompileAppPackageInput): {
  readonly appPackage?: AppPackageArtifactV1;
  readonly errors: readonly CompileError[];
} {
  return compileAppPackageInternal(input, false);
}

/** Compiler-internal projection after compileManifest has already completed credential preflight. */
export function compileAppPackagePreflighted(input: CompileAppPackageInput): {
  readonly appPackage?: AppPackageArtifactV1;
  readonly errors: readonly CompileError[];
} {
  return compileAppPackageInternal(input, true);
}

function compileAppPackageInternal(
  input: CompileAppPackageInput,
  preflightComplete: boolean,
): { readonly appPackage?: AppPackageArtifactV1; readonly errors: readonly CompileError[] } {
  if (input.manifest.manifestVersion !== '2' || input.manifest.server.agentGuide === undefined)
    return { errors: [] };
  if (!preflightComplete && preflightAppPackageSensitiveContent(input.sourceManifest)) {
    return { errors: [APP_PACKAGE_SENSITIVE_ERROR] };
  }
  const guide = input.manifest.server.agentGuide;
  const errors: CompileError[] = [];
  const workflowIds = new Set<string>();
  for (const [workflowIndex, workflow] of guide.workflows.entries()) {
    if (workflowIds.has(workflow.id))
      errors.push({
        code: 'agent_guide_duplicate_workflow',
        path: `server.agentGuide.workflows.${workflowIndex}.id`,
        message: `duplicate agent guide workflow "${workflow.id}"`,
      });
    workflowIds.add(workflow.id);
  }
  const surface = projectSurface(input.artifact);
  if (
    surface.tools.length > APP_PACKAGE_V1_MAX_SURFACE_ITEMS ||
    surface.resources.length > APP_PACKAGE_V1_MAX_SURFACE_ITEMS ||
    surface.prompts.length > APP_PACKAGE_V1_MAX_SURFACE_ITEMS ||
    surface.widgets.length > APP_PACKAGE_V1_MAX_SURFACE_ITEMS
  ) {
    return { errors: [GENERIC_BOUNDS_ERROR] };
  }
  const byKind = new Map([
    ['tool', new Set(surface.tools.map((item) => item.name))],
    ['resource', new Set(surface.resources.map((item) => item.name))],
    ['prompt', new Set(surface.prompts.map((item) => item.name))],
  ]);
  const allNames = [...byKind.values()].flatMap((names) => [...names]);
  for (const [workflowIndex, workflow] of guide.workflows.entries())
    for (const [stepIndex, step] of workflow.steps.entries()) {
      const expected = byKind.get(step.capability.kind) ?? new Set<string>();
      const path = `server.agentGuide.workflows.${workflowIndex}.steps.${stepIndex}.capability`;
      if (expected.has(step.capability.name)) continue;
      const actualKind = [...byKind.entries()].find(([, names]) =>
        names.has(step.capability.name),
      )?.[0];
      if (actualKind !== undefined)
        errors.push({
          code: 'agent_guide_capability_kind',
          path: `${path}.kind`,
          message: `capability "${step.capability.name}" is a ${actualKind}, not a ${step.capability.kind}`,
          expected: actualKind,
          got: step.capability.kind,
        });
      else
        errors.push({
          code: 'agent_guide_capability_missing',
          path: `${path}.name`,
          message: `unknown capability "${step.capability.name}"`,
          got: step.capability.name,
          ...suggestionFields('agent_guide_capability_missing', step.capability.name, allNames),
        });
    }
  const examples = new Set<string>();
  for (const [index, example] of guide.examples?.entries() ?? []) {
    if (!workflowIds.has(example.workflow))
      errors.push({
        code: 'agent_guide_example_workflow_missing',
        path: `server.agentGuide.examples.${index}.workflow`,
        message: `unknown agent guide workflow "${example.workflow}"`,
        got: example.workflow,
        ...suggestionFields('agent_guide_example_workflow_missing', example.workflow, [
          ...workflowIds,
        ]),
      });
    const key = `${example.prompt}\u0000${example.workflow}`;
    if (examples.has(key))
      errors.push({
        code: 'agent_guide_duplicate_example',
        path: `server.agentGuide.examples.${index}`,
        message: 'duplicate agent guide example',
      });
    examples.add(key);
  }
  if (errors.length > 0) return { errors };
  const skill = {
    description: guide.description,
    useWhen: [...guide.useWhen],
    workflows: guide.workflows.map((workflow) => ({
      id: workflow.id,
      title: workflow.title,
      ...(workflow.intent === undefined ? {} : { intent: workflow.intent }),
      steps: workflow.steps.map((step) => {
        const resolvedTool =
          step.capability.kind === 'tool'
            ? surface.tools.find((tool) => tool.name === step.capability.name)
            : undefined;
        return {
          capability: { ...step.capability },
          ...(step.guidance === undefined ? {} : { guidance: step.guidance }),
          ...(resolvedTool === undefined ? {} : { behavior: resolvedTool.behavior }),
        };
      }),
    })),
    boundaries: [...(guide.boundaries ?? [])],
    examples: [...(guide.examples ?? [])],
  };
  const appBranding = projectBranding(input.sourceManifest.server.branding);
  const appPackage: AppPackageArtifactV1 = {
    schemaVersion: '1',
    app: {
      name: input.artifact.server.name,
      title: input.artifact.server.title,
      version: input.artifact.server.version,
      ...(appBranding === undefined ? {} : { branding: appBranding }),
    },
    skill,
    surface,
    provenance: {
      sourceManifestSha256: sha256Canonical({
        ...input.sourceManifest,
        tools: input.sourceManifest.tools.map((tool) => {
          if (tool.authorization?.discovery !== 'authorized') return tool;
          const { discovery: _discovery, ...authorization } = tool.authorization;
          return { ...tool, authorization };
        }),
      }),
      mcpSurfaceSha256: sha256Canonical(surface),
      compilerVersion: '1',
    },
  };
  const sensitive = sensitiveContentFinding(appPackage);
  if (sensitive !== undefined) return { errors: [APP_PACKAGE_SENSITIVE_ERROR] };
  const validated = appPackageArtifactV1Schema.safeParse(appPackage);
  if (!validated.success) return { errors: [GENERIC_BOUNDS_ERROR] };
  return { appPackage: validated.data as AppPackageArtifactV1, errors: [] };
}

function projectBranding(
  branding: Manifest['server']['branding'],
): AppPackageArtifactV1['app']['branding'] | undefined {
  if (branding === undefined) return undefined;
  const logo = projectBrandAsset(branding.logo);
  const mark = projectBrandAsset(branding.mark);
  const avatar = projectBrandAsset(branding.avatar);
  const projected = {
    ...(branding.name === undefined ? {} : { name: branding.name }),
    ...(branding.accent === undefined ? {} : { accent: branding.accent }),
    ...(branding.surface === undefined ? {} : { surface: branding.surface }),
    ...(branding.surfaceDark === undefined ? {} : { surfaceDark: branding.surfaceDark }),
    ...(logo === undefined ? {} : { logo }),
    ...(mark === undefined ? {} : { mark }),
    ...(avatar === undefined ? {} : { avatar }),
    ...(branding.radius === undefined ? {} : { radius: branding.radius }),
    ...(branding.density === undefined ? {} : { density: branding.density }),
    ...(branding.typography === undefined ? {} : { typography: branding.typography }),
    ...(branding.colorScheme === undefined ? {} : { colorScheme: branding.colorScheme }),
  };
  return Object.keys(projected).length === 0 ? undefined : projected;
}

function projectBrandAsset(asset: NonNullable<Manifest['server']['branding']>['logo'] | undefined) {
  if (asset === undefined || !isPackagedAssetReference(asset.uri)) return undefined;
  return {
    logicalId: asset.uri.logicalId,
    alt: asset.alt,
    ...(isPackagedAssetReference(asset.darkUri) ? { darkLogicalId: asset.darkUri.logicalId } : {}),
  };
}

function projectSurface(artifact: RuntimeArtifact): AppPackageSurface {
  const widgets = (artifact.resources ?? [])
    .filter((resource) => resource.mimeType === 'text/html;profile=mcp-app')
    .flatMap((resource) => {
      const linkedTool = artifact.tools.find(
        (tool) => tool._meta?.ui?.resourceUri === resource.uri,
      );
      return linkedTool === undefined
        ? []
        : [
            {
              kind: 'widget' as const,
              name: resource.name,
              ...(resource.title === undefined ? {} : { title: resource.title }),
              ...(resource.description === undefined ? {} : { description: resource.description }),
              tool: linkedTool.name,
            },
          ];
    });
  const widgetNames = new Set(widgets.map((widget) => widget.name));
  const tools = artifact.tools
    .map((tool) => {
      const linkedWidget = widgets.find((widget) => widget.tool === tool.name);
      return {
        kind: 'tool' as const,
        name: tool.name,
        ...(tool.title === undefined ? {} : { title: tool.title }),
        description: tool.description,
        input: summarize(tool.inputSchema),
        ...(tool.outputSchema === undefined ? {} : { output: summarize(tool.outputSchema) }),
        behavior: {
          readOnly: tool.annotations?.readOnlyHint === true,
          destructive: tool.annotations?.destructiveHint === true,
          idempotent: tool.annotations?.idempotentHint === true,
          openWorld: tool.annotations?.openWorldHint === true,
          confirmationRequired: tool.annotations?.confirm === true,
        },
        visibility: normalizeVisibility(tool._meta?.ui?.visibility),
        ...(tool.authorization === undefined ? {} : { authorization: tool.authorization }),
        ...(linkedWidget === undefined ? {} : { widget: linkedWidget.name }),
      };
    })
    .sort((a, b) => compareCodeUnits(a.name, b.name));
  return {
    auth: {
      required: artifact.server.auth !== undefined,
      ...(artifact.server.auth === undefined
        ? {}
        : {
            kind:
              artifact.server.auth.kind === 'federatedOidc'
                ? ('federatedOidc' as const)
                : ('oidc' as const),
          }),
    },
    tools,
    resources: (artifact.resources ?? [])
      .filter((resource) => !widgetNames.has(resource.name))
      .map((resource) => ({
        kind: 'resource' as const,
        name: resource.name,
        uri: resource.uri,
        ...(resource.title === undefined ? {} : { title: resource.title }),
        ...(resource.description === undefined ? {} : { description: resource.description }),
        ...(resource.mimeType === undefined ? {} : { mimeType: resource.mimeType }),
      }))
      .sort((a, b) => compareCodeUnits(a.name, b.name)),
    prompts: (artifact.prompts ?? [])
      .map((prompt) => ({
        kind: 'prompt' as const,
        name: prompt.name,
        ...(prompt.title === undefined ? {} : { title: prompt.title }),
        ...(prompt.description === undefined ? {} : { description: prompt.description }),
        arguments: (prompt.arguments ?? []).map((arg) => ({
          name: arg.name,
          ...(arg.description === undefined ? {} : { description: arg.description }),
          required: arg.required === true,
        })),
      }))
      .sort((a, b) => compareCodeUnits(a.name, b.name)),
    widgets: widgets.sort((a, b) => compareCodeUnits(a.name, b.name)),
  };
}

function summarize(schema: JsonSchema): AppPackageSchemaSummary {
  const properties = schema.properties;
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === 'string')
      : [],
  );
  return {
    type: typeof schema.type === 'string' ? schema.type : 'object',
    ...(properties === undefined ||
    properties === null ||
    typeof properties !== 'object' ||
    Array.isArray(properties)
      ? {}
      : {
          fields: Object.entries(properties as Record<string, unknown>)
            .sort(([left], [right]) => compareCodeUnits(left, right))
            .slice(0, APP_PACKAGE_V1_MAX_SCHEMA_FIELDS)
            .map(([name, value]) => ({
              name,
              type:
                typeof (value as { type?: unknown }).type === 'string'
                  ? (value as { type: string }).type
                  : 'unknown',
              required: required.has(name),
              ...(typeof (value as { description?: unknown }).description === 'string'
                ? { description: (value as { description: string }).description }
                : {}),
            })),
        }),
  };
}

function normalizeVisibility(
  visibility: readonly ('model' | 'app')[] | undefined,
): readonly ('model' | 'app')[] {
  const declared = visibility ?? ['model', 'app'];
  return (['model', 'app'] as const).filter((entry) => declared.includes(entry));
}
