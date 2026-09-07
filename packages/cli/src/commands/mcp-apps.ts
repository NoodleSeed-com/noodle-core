import { dirname, resolve } from 'node:path';
import {
  type AuditFinding,
  auditChatGptCompatibility,
  auditEmbeddedAssistant,
  auditToolDesignFindings,
  auditWidgetQualityFindings,
  isModelVisibleTool,
  toolNames,
} from '@noodle-borg/app-audit';
import { noodlePlatformCatalog } from '@noodle-borg/authoring';
import {
  compile,
  InMemoryCatalog,
  isHonorableCspOrigin,
  type RuntimeArtifact,
} from '@noodle-borg/compiler';
import { compileConnectors } from '@noodle-borg/connector-defs';
import { type ChecklistItem, renderChecklist } from '../checklist.js';
import { readDeployInput } from '../deploy.js';
import { detectColorMode, detectGlyphMode } from '../gradient.js';
import { resolveLinkedEntrypoint } from '../project.js';
import { validate } from '../validate.js';
import { agentFixPrompt, parseAuthorSmokeArgs } from './author-loop.js';
import { printJsonFailure, printJsonOk } from './output.js';
import { missingProjectEntrypoint } from './shared.js';

type CheckTarget = 'generic' | 'chatgpt' | 'claude' | 'embedded-assistant';
type ArtifactTool = RuntimeArtifact['tools'][number];
type ArtifactResource = NonNullable<RuntimeArtifact['resources']>[number];

export async function runCheck(rest: readonly string[]): Promise<number> {
  const args = parseAuthorSmokeArgs(rest);
  const target = parseCheckTarget(args.target);
  if (target === undefined) {
    const message = `Unknown check target "${args.target}". Expected generic, chatgpt, claude, or embedded-assistant.`;
    if (args.json) {
      return printJsonFailure(
        {
          code: 'invalid_target',
          message,
          fix: 'Pass --target chatgpt, --target claude, or --target embedded-assistant.',
          next: 'noodle check --target embedded-assistant',
        },
        2,
      );
    }
    console.error(`check: ${message}`);
    return 2;
  }
  const manifestPath = args.path ?? resolveLinkedEntrypoint();
  if (!manifestPath) return missingProjectEntrypoint('check', args.json);

  const validation = await validate({
    manifestPath,
    ...(args.connectorsPath ? { connectorsPath: args.connectorsPath } : {}),
  });
  if (!validation.ok) {
    if (args.json) {
      const findings = validation.errors.map(validationFinding);
      return printJsonFailure({
        code: 'check_failed',
        message: `${findings.length} app/widget issue(s)`,
        // The server did not compile, so fix the validation errors first.
        next: 'noodle validate --json',
        errors: findings,
      });
    }
    if (args.agentOutput) {
      console.log(agentFixPrompt('check', manifestPath, validation.errors));
    } else {
      console.log('App check: fail');
      for (const error of validation.errors) {
        console.log(`ERROR ${error.code}: ${error.message}`);
      }
    }
    return 1;
  }

  const loaded = await loadArtifact(manifestPath, args.connectorsPath);
  const findings = loaded.ok ? auditArtifact(loaded.artifact, target) : [loaded.finding];
  // The exit code is computed from the UNFILTERED findings — `--min-severity` is presentation-only and
  // must never hide an error-severity finding from the pass/fail verdict.
  const ok = findings.every((finding) => finding.severity !== 'error');
  // The rendered copy (what the JSON payload and the human checklist show) can be narrowed with
  // `--min-severity` so a noisy info/warn stream doesn't bury the findings the author cares about.
  const rendered = filterFindingsBySeverity(findings, args.minSeverity);

  if (args.agentOutput) {
    console.log(auditFixPrompt(manifestPath, findings));
  } else if (args.json) {
    if (ok) {
      printJsonOk({ target, findings: rendered });
    } else {
      const errorCount = findings.filter((finding) => finding.severity === 'error').length;
      printJsonFailure({
        code: 'check_failed',
        message: `${errorCount} app/widget issue(s)`,
        // Fix each cited finding in `src/server.ts`, then re-run the same check.
        fix: 'Resolve each error-severity finding at its location, then re-run the check.',
        next: `noodle check --target ${target} --json`,
        errors: rendered,
      });
    }
  } else {
    console.log(`App check: ${ok ? 'pass' : 'fail'}`);
    console.log(
      renderChecklist(rendered.map(findingChecklistItem), {
        color: detectColorMode(process.stdout),
        glyph: detectGlyphMode(),
      }),
    );
  }
  return ok ? 0 : 1;
}

/** Severity ordering for `--min-severity` (info < warn < error). */
const SEVERITY_RANK: Record<AuditFinding['severity'], number> = { info: 0, warn: 1, error: 2 };

/**
 * Narrow findings to those at or above `minSeverity` (presentation-only). No flag, or an unrecognized
 * value, means "show all" — the exit code is computed separately from the unfiltered findings, so this
 * never changes pass/fail. Errors always rank highest, so an error is never hidden by any threshold.
 */
function filterFindingsBySeverity(
  findings: readonly AuditFinding[],
  minSeverity: string | undefined,
): readonly AuditFinding[] {
  if (minSeverity === undefined) return findings;
  const threshold = SEVERITY_RANK[minSeverity as AuditFinding['severity']];
  if (threshold === undefined) return findings;
  return findings.filter((finding) => SEVERITY_RANK[finding.severity] >= threshold);
}

/** Map an audit finding onto the shared checklist convention (`checklist.ts`). */
function findingChecklistItem(finding: AuditFinding): ChecklistItem {
  const tone = finding.severity === 'info' ? 'ok' : finding.severity === 'warn' ? 'warn' : 'fail';
  return {
    label: finding.code.replaceAll('_', ' '),
    tone,
    detail: finding.message,
    cause: finding.cause,
    fix: finding.fix,
    command: finding.next,
  };
}

function auditArtifact(
  artifact: RuntimeArtifact,
  target: CheckTarget = 'generic',
): readonly AuditFinding[] {
  const findings: AuditFinding[] = [];
  const widgetResources = (artifact.resources ?? []).filter(
    (resource) => resource.mimeType === 'text/html;profile=mcp-app',
  );
  findings.push({
    code: 'metadata',
    severity: widgetResources.length > 0 ? 'info' : 'warn',
    message:
      widgetResources.length > 0
        ? `${widgetResources.length} MCP Apps widget resource(s) found with standard metadata.`
        : 'No MCP Apps widget resources were found.',
    cause:
      widgetResources.length > 0
        ? 'Widgets compile to ui:// resources.'
        : 'The app has no widget resources.',
    fix: 'Add a `view` to the tool declaration when UI is expected.',
    next: 'noodle init --template widget',
  });

  const linkedTools = artifact.tools.filter((tool) => tool._meta?.ui?.resourceUri !== undefined);
  const appOnlyTools = artifact.tools.filter((tool) => {
    const visibility = tool._meta?.ui?.visibility;
    return Array.isArray(visibility) && visibility.includes('app') && !visibility.includes('model');
  });
  const modelVisibleTools = artifact.tools.filter(isModelVisibleTool);
  const toolsWithWeakDescriptions = modelVisibleTools.filter(
    (tool) => tool.description.length < 24,
  );
  const toolsMissingAnnotations = modelVisibleTools.filter(
    (tool) => tool.annotations === undefined || Object.keys(tool.annotations).length === 0,
  );
  const widgetToolsMissingInvocation = linkedTools.filter(
    (tool) =>
      isModelVisibleTool(tool) &&
      (typeof tool._meta?.['openai/toolInvocation/invoking'] !== 'string' ||
        typeof tool._meta?.['openai/toolInvocation/invoked'] !== 'string'),
  );
  const toolMetadataGaps = [
    ...(toolsWithWeakDescriptions.length > 0
      ? [`short descriptions: ${toolNames(toolsWithWeakDescriptions)}`]
      : []),
    ...(toolsMissingAnnotations.length > 0
      ? [`missing annotations: ${toolNames(toolsMissingAnnotations)}`]
      : []),
    ...(widgetToolsMissingInvocation.length > 0
      ? [`missing invocation metadata: ${toolNames(widgetToolsMissingInvocation)}`]
      : []),
  ];
  findings.push({
    code: 'tool_metadata',
    severity: toolMetadataGaps.length === 0 ? 'info' : 'warn',
    message:
      toolMetadataGaps.length === 0
        ? 'Model-visible tools include review-oriented descriptions, annotations, and widget invocation metadata.'
        : `Tool metadata review gaps: ${toolMetadataGaps.join('; ')}.`,
    cause:
      'Consumer app submission review needs model-facing tool descriptions, planner annotations, and clear invocation copy for widget-opening tools.',
    fix: 'Add precise tool descriptions, MCP tool annotations such as readOnlyHint/destructiveHint/openWorldHint, and recompile widget-linked tools so invocation metadata is emitted.',
    next: 'noodle validate && noodle check',
  });
  const weakTools = linkedTools.filter(
    (tool) => tool.outputSchema === undefined || tool.description.length < 12,
  );
  findings.push({
    code: 'progressive_enhancement',
    severity: weakTools.length === 0 ? 'info' : 'error',
    message:
      weakTools.length === 0
        ? 'Widget-linked tools include descriptions and output schemas for non-Apps hosts.'
        : `Widget-linked tools need better non-UI fallbacks: ${weakTools.map((tool) => tool.name).join(', ')}`,
    cause: 'MCP Apps must remain useful when a host cannot render widgets.',
    fix: 'Add useful text/structured output and explicit output schemas to widget-linked tools.',
    next: 'noodle validate && noodle check',
  });
  findings.push({
    code: 'app_only_tools',
    severity: 'info',
    message:
      appOnlyTools.length > 0
        ? `${appOnlyTools.length} app-only helper tool(s) are discoverable with visibility metadata and callable through the normal policy-gated tools/call path; visibility is presentation metadata, not authorization.`
        : 'No app-only helper tools declared; visibility is presentation metadata, not authorization.',
    cause:
      'Widget helper tools should be explicitly scoped to the app surface so hosts can hide them from the model while runtime auth, policy, validation, and audit still apply.',
    fix: 'Use tool(..., { visibility: ["app"], ... }) for app-only helpers, and enforce authorization in normal runtime policy or tool logic.',
    next: 'noodle check',
  });
  const branding = artifact.server.branding;
  findings.push({
    code: 'branding',
    severity: branding === undefined ? 'info' : 'info',
    message:
      branding === undefined
        ? 'No server branding metadata declared.'
        : `Server branding declared${branding.name ? ` for ${branding.name}` : ''}${branding.accent ? ' with accent seed' : ''}${branding.logo ? ' and logo metadata' : ''}.`,
    cause:
      'Server branding is compiled into semantic runtime config for React widgets; it is not raw tenant CSS.',
    fix: 'Set server.branding name, accent/surface seeds, logo metadata, radius, density, or typography when the app needs branded React UI.',
    next: 'noodle validate && noodle check',
  });
  const unscopedAppOnlyTools = appOnlyTools.filter(
    (tool) => tool._meta?.ui?.resourceUri === undefined,
  );
  if (unscopedAppOnlyTools.length > 0) {
    findings.push({
      code: 'app_only_tool_widget_scope',
      // Info, not warn: an app-only `tool(...)` helper never sets a widget resourceUri, so flagging
      // its absence as a problem contradicts `app_only_tools`, which presents visibility as the
      // correct way to declare these helpers. The association is an optional host-brokering hint.
      severity: 'info',
      message: `App-only helper tool(s) have no widget resourceUri association (optional host hint): ${unscopedAppOnlyTools.map((tool) => tool.name).join(', ')}`,
      cause:
        'Associating an app-only helper with a widget resourceUri is an optional hint some hosts use to broker app-only callServerTool requests from a specific widget. It is not required: visibility already scopes the tool to the app surface.',
      fix: 'Optionally associate the helper with a widget-backed tool when a host needs the widget-scoped brokering hint; otherwise no change is needed.',
      next: 'noodle check',
    });
  }
  const shell = artifact.server.shell;
  const navigationItems = shell?.navigation?.items ?? [];
  findings.push({
    code: 'shell_navigation',
    severity: shell === undefined ? 'info' : navigationItems.length > 0 ? 'info' : 'warn',
    message:
      shell === undefined
        ? 'No server shell metadata declared.'
        : navigationItems.length > 0
          ? `Server shell declares ${shell.navigation?.variant ?? 'default'} navigation with ${navigationItems.length} navigation item(s).`
          : 'Server shell is declared without navigation items.',
    cause:
      'Shell metadata gives generated consumer apps stable header, navigation, display-mode, and persistent-action hints without creating a URL router.',
    fix: 'Add server.shell.navigation items when the app has multiple named views; keep authorization in tools and policy.',
    next: 'noodle validate && noodle check',
  });
  findings.push({
    code: 'custom_component_use',
    severity: 'info',
    message:
      'React view widgets are the public custom presentation path; raw HTML widgets remain a low-level compatibility path.',
    cause:
      'React components require bundle, CSP, fallback, and bridge-only review because the compiler treats user widget code as opaque.',
    fix: 'Declare React widgets with view: { component, entry }, explicit metadata, CSP, and useful tool fallbacks.',
    next: 'noodle check',
  });
  const stateHandles = Object.entries(artifact.server.state?.handles ?? {});
  findings.push({
    code: 'state_store_use',
    severity: 'info',
    message:
      stateHandles.length > 0
        ? `App declares ${stateHandles.length} typed state handle(s): ${stateHandles.map(([name]) => name).join(', ')}.`
        : 'No typed app state handles declared; current widget state is local presentation state, not an authoritative store.',
    cause:
      stateHandles.length > 0
        ? 'State handles are opt-in runtime coordination records with schema, revision, expiry/status metadata, completion semantics, and no-secret checks.'
        : 'State handles are opt-in runtime resources with schema, revision, expiry, status, and no-secret serialization checks.',
    fix:
      stateHandles.length > 0
        ? 'Expose reads/writes only through app-specific helper tools that call noodlePlatform.state.v1; keep partner-system truth in tenant APIs.'
        : 'Keep business state in tools or tenant backends, or declare typed state handles and helper tools when app workflow state must survive widget remounts.',
    next: 'noodle check',
  });

  for (const resource of widgetResources) {
    const ui = resource._meta?.ui;
    findings.push({
      code: `csp_${resource.name}`,
      severity: ui?.csp !== undefined ? 'info' : 'warn',
      message:
        ui?.csp !== undefined
          ? `${resource.name} declares CSP metadata.`
          : `${resource.name} has no explicit CSP metadata.`,
      cause: 'Hosts enforce widget resource CSP from _meta.ui.csp.',
      fix: 'Declare connectDomains/resourceDomains/frameDomains when the widget needs external access.',
      next: 'noodle check',
    });
    // Error on any CSP origin the host renderer will silently drop — this is the same fault the deploy
    // route gates on, surfaced here so `noodle check` fails before the author ships a broken widget.
    const csp = ui?.csp;
    for (const list of ['connectDomains', 'resourceDomains', 'frameDomains'] as const) {
      for (const origin of csp?.[list] ?? []) {
        if (isHonorableCspOrigin(origin)) continue;
        findings.push({
          code: `csp_origin_${resource.name}`,
          severity: 'error',
          message: `${resource.name} CSP ${list} origin "${origin}" is not an absolute https:// origin.`,
          cause:
            'The host iframe renderer keeps only absolute https:// origins (http for localhost) and silently drops the rest, so the widget loses this access.',
          fix: `Use an absolute https:// origin${/^[a-z][a-z0-9+.-]*:/i.test(origin) ? '' : ` (e.g. "https://${origin}")`}.`,
          next: 'noodle check',
        });
      }
    }
  }
  const resourcesMissingTitle = widgetResources.filter((resource) => !resource.title);
  findings.push({
    code: 'host_compatibility',
    severity: 'info',
    message:
      widgetResources.length > 0
        ? 'Widget resources use the standard MCP Apps MIME type; host-specific support must still be verified per client.'
        : 'No widget resources available for host compatibility review.',
    cause: 'MCP Apps hosts differ in render support and capability enforcement.',
    fix: 'Run local Playwright tests, mcpjam Apps metadata smoke, and host-specific manual checks before claiming support.',
    next: 'pnpm smoke:widgets',
  });
  findings.push({
    code: 'submission_readiness',
    severity: resourcesMissingTitle.length === 0 && weakTools.length === 0 ? 'info' : 'warn',
    message:
      resourcesMissingTitle.length === 0 && weakTools.length === 0
        ? 'Widget metadata and progressive-enhancement basics are ready for demo/submission review.'
        : `Widget submission readiness gaps: ${[
            ...(resourcesMissingTitle.length > 0 ? ['widget resources need titles'] : []),
            ...(weakTools.length > 0 ? ['widget-linked tools need stronger fallbacks'] : []),
          ].join(', ')}`,
    cause:
      'Marketplace/client review needs clear metadata, useful fallback text, and explicit permissions.',
    fix: 'Add widget titles, precise tool descriptions, output schemas, and minimal permissions metadata.',
    next: 'noodle check && pnpm widgets:previews',
  });

  const handoffAllowlist = artifact.server.handoff?.allowedDomains ?? [];
  findings.push({
    code: 'handoff_allowlist',
    severity: 'info',
    message:
      handoffAllowlist.length > 0
        ? `Widget handoff/open-link calls are backed by an allowlist of ${handoffAllowlist.length} domain(s).`
        : 'No handoff.allowedDomains allowlist declared; React widgets should avoid external open-link calls or add one.',
    cause:
      'React widgets are opaque to the compiler, so external-link intent is reviewed from declared handoff policy and widget code.',
    fix: 'Declare handoff.allowedDomains with the HTTPS origins your widget hands off to (e.g. server({ handoff: { allowedDomains: [...] } })).',
    next: 'noodle validate && noodle check',
  });
  findings.push(...auditToolDesignFindings(artifact));
  findings.push(...auditWidgetQualityFindings(artifact, widgetResources, linkedTools));
  findings.push(...auditTargetCompatibility(target, artifact, widgetResources, linkedTools));
  return findings;
}

function parseCheckTarget(value: string | undefined): CheckTarget | undefined {
  if (value === undefined) return 'generic';
  return value === 'generic' ||
    value === 'chatgpt' ||
    value === 'claude' ||
    value === 'embedded-assistant'
    ? value
    : undefined;
}

function auditTargetCompatibility(
  target: CheckTarget,
  artifact: RuntimeArtifact,
  widgetResources: readonly ArtifactResource[],
  linkedTools: readonly ArtifactTool[],
): readonly AuditFinding[] {
  if (target === 'chatgpt')
    return auditChatGptCompatibility(artifact, widgetResources, linkedTools);
  if (target === 'claude') return auditClaudeCompatibility(widgetResources, linkedTools);
  if (target === 'embedded-assistant') return auditEmbeddedAssistant(artifact);
  return [];
}

function auditClaudeCompatibility(
  widgetResources: readonly ArtifactResource[],
  linkedTools: readonly ArtifactTool[],
): readonly AuditFinding[] {
  const missingStandardLink = linkedTools.filter(
    (tool) => typeof tool._meta?.ui?.resourceUri !== 'string',
  );
  return [
    {
      code: 'claude_mcp_apps_metadata',
      severity: widgetResources.length > 0 && missingStandardLink.length === 0 ? 'info' : 'warn',
      message:
        widgetResources.length > 0 && missingStandardLink.length === 0
          ? 'Widget resources and linked tools use the standard MCP Apps metadata path.'
          : 'Claude/MCP Apps hosts need standard widget resources and _meta.ui.resourceUri links.',
      cause: 'Claude-style MCP Apps hosts consume the portable MCP Apps resource metadata first.',
      fix: 'Keep widget-linked tools on the standard _meta.ui.resourceUri path.',
      next: 'pnpm smoke:widgets',
    },
  ];
}

function validationFinding(error: { code: string; message: string }): AuditFinding {
  return {
    code: error.code,
    severity: 'error',
    message: error.message,
    cause: 'The app does not compile.',
    fix: 'Fix validation errors before checking widget readiness.',
    next: 'noodle validate',
  };
}

function auditFixPrompt(path: string, findings: readonly AuditFinding[]): string {
  return [
    'Fix this Noodle MCP Apps readiness check using test-driven development.',
    '',
    `Target: ${path}`,
    '',
    'Findings:',
    ...findings.map((finding) => `- ${finding.severity} ${finding.code}: ${finding.message}`),
    '',
    'Run `noodle validate`, `noodle test`, and `noodle check` after the fix.',
  ].join('\n');
}

async function loadArtifact(
  manifestPath: string,
  connectorsPath: string | undefined,
): Promise<{ ok: true; artifact: RuntimeArtifact } | { ok: false; finding: AuditFinding }> {
  try {
    const input = await readDeployInput(manifestPath);
    const connectors = connectorsPath
      ? await import('node:fs').then((fs) => fs.readFileSync(connectorsPath, 'utf8'))
      : input.connectors;
    const catalog = connectors ? compileConnectors(connectors) : undefined;
    if (catalog && !catalog.ok)
      return {
        ok: false,
        finding: validationFinding(
          catalog.errors[0] ?? { code: 'connector_error', message: 'connector catalog failed' },
        ),
      };
    const compiled = compile(input.manifest, {
      catalog: new InMemoryCatalog([...noodlePlatformCatalog, ...(catalog?.catalog ?? [])]),
      localAssets: {
        rootDir: input.rootDir || dirname(resolve(manifestPath)),
        publicOrigin: 'http://127.0.0.1',
      },
      knowledgeFiles: { rootDir: input.rootDir || dirname(resolve(manifestPath)) },
    });
    if (!compiled.ok)
      return {
        ok: false,
        finding: validationFinding(
          compiled.errors[0] ?? { code: 'compile_error', message: 'compile failed' },
        ),
      };
    return { ok: true, artifact: compiled.artifact };
  } catch (error) {
    return {
      ok: false,
      finding: validationFinding({ code: 'read_error', message: (error as Error).message }),
    };
  }
}
