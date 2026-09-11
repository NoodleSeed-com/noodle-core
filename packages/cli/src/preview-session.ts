import { type FSWatcher, watch } from 'node:fs';
import type { DevHandle } from './dev.js';
import { DEFAULT_CHAT_MODELS } from './devtools-chat.js';
import { type LoadedDevtoolsEnv, loadDevtoolsEnv } from './devtools-env.js';
import {
  type PreviewDevice,
  type PreviewHandle,
  type PreviewTheme,
  startPreview,
} from './devtools-preview.js';
import { AMBER, detectColorMode, detectGlyphMode, ORANGE, paint, type RGB } from './gradient.js';
import {
  type EffectiveLocalTargetResolution,
  localTargetDisplay,
  UNLINKED_LOCAL_TARGET_HINT,
} from './local-target.js';

type PreviewWatchListener = (event: 'rename' | 'change', filename: string | Buffer | null) => void;
type PreviewWatchFactory = (watchDir: string, listener: PreviewWatchListener) => FSWatcher;

/**
 * The devtools preview attached to an already-booted in-process `dev` runtime. Both `noodle dev` (preview
 * on by default in a TTY) and `noodle devtools` (preview always on) drive this — there is never a second
 * process, port, or reload channel to coordinate: the caller owns the `DevHandle`, and this session owns the
 * preview server + a recursive source watcher that reloads the runtime and refreshes connected browsers.
 */

export interface PreviewSessionOptions {
  readonly accessMode?: 'mixed' | 'customers';
  /** The already-booted dev runtime (boot it with `watch: false` — this session owns the watcher). */
  readonly handle: DevHandle;
  /** Project source root to watch recursively (so imported view files like `views/*.tsx` trigger reloads). */
  readonly watchDir: string;
  readonly theme: PreviewTheme;
  readonly device: PreviewDevice;
  readonly port?: number;
  readonly model?: string;
  /** Trusted project context used only by local Design Session routes. */
  readonly design?: {
    readonly projectRoot: string;
    readonly entrypoint: string;
  };
  readonly log?: (message: string) => void;
  /** Internal deterministic test seam; production always uses recursive `node:fs` watching. */
  readonly watchFactory?: PreviewWatchFactory;
}

export interface PreviewSession {
  readonly preview: PreviewHandle;
  /** OPENAI_* keys pulled from a git-ignored `.env.local`, for the banner (values are never surfaced). */
  readonly loadedEnv: LoadedDevtoolsEnv;
  readonly watching: boolean;
  /** Stop the watcher and close the preview server. Does NOT close the dev handle — the caller owns it. */
  close(): Promise<void>;
}

/**
 * Start the preview server for `handle` and a debounced recursive watcher that recompiles + live-reloads.
 * Throws if the preview server cannot bind (port in use / permission) — the caller should close the handle.
 */
export async function startPreviewSession(opts: PreviewSessionOptions): Promise<PreviewSession> {
  const log = opts.log ?? ((message: string) => console.log(message));
  // OPENAI_* playground credentials come from a git-ignored .env.local (dev tooling, not an app secret).
  const loadedEnv = loadDevtoolsEnv(process.cwd());
  const customerAuth = opts.handle.customerAuth();
  const delegatedCredentialSink = opts.handle.delegatedCredentialSink();
  const preview = await startPreview({
    mcpUrl: opts.handle.url,
    ...(opts.accessMode === undefined ? {} : { accessMode: opts.accessMode }),
    theme: opts.theme,
    device: opts.device,
    ...(opts.port !== undefined ? { port: opts.port } : {}),
    ...(opts.model !== undefined ? { openaiModel: opts.model } : {}),
    ...(opts.design !== undefined ? { design: opts.design } : {}),
    ...(customerAuth !== undefined ? { customerAuth } : {}),
    ...(delegatedCredentialSink === undefined ? {} : { delegatedCredentialSink }),
    localDelegatedExchange: () => opts.handle.localDelegatedExchange(),
    assistantInstructions: () => opts.handle.assistantInstructions(),
  });

  // Watch the whole source tree, recompile/re-bundle via dev.reload(), then push a browser reload so the
  // iframe + tool list refresh. Debounced (fs.watch fires multiple events per save); best-effort.
  let reloadTimer: NodeJS.Timeout | undefined;
  let watcher: FSWatcher | undefined;
  // Single-flight: `ServerRegistry.deploy()` (behind handle.reload) mutates shared state and is not
  // re-entrant. The debounce only coalesces a burst; it does NOT stop a save during a slow in-flight reload
  // from starting a second, racing deploy. So run one reload at a time and coalesce mid-flight saves into
  // exactly one trailing reload — otherwise an older deploy could finish last and leave a stale build.
  let reloading = false;
  let pendingReload = false;
  function runReload(): void {
    if (reloading) {
      pendingReload = true;
      return;
    }
    reloading = true;
    void opts.handle
      .reload()
      .then((r) => {
        if (r.ok) {
          log('↻ reloaded');
          preview.updateCustomerAuth(opts.handle.customerAuth());
          preview.signalReload();
        } else {
          log('↻ reload failed — keeping the last good build');
          for (const e of r.errors ?? []) log(`  ${e.code}: ${e.message}`);
        }
      })
      .catch((error: unknown) => {
        log(`↻ reload error: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        reloading = false;
        if (pendingReload) {
          pendingReload = false;
          runReload();
        }
      });
  }
  try {
    const watchFactory =
      opts.watchFactory ??
      ((watchDir: string, listener: PreviewWatchListener) =>
        watch(watchDir, { recursive: true }, listener));
    watcher = watchFactory(opts.watchDir, (_event, filename) => {
      const name = typeof filename === 'string' ? filename : '';
      if (name.includes('node_modules') || name.includes('.git') || name.endsWith('~')) return;
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(runReload, 150);
    });
    // A later recursive-watch failure emits 'error'; without a listener Node would crash the process.
    // Degrade gracefully instead — stop watching, keep the preview server running.
    watcher.on('error', (error) => {
      log(
        `↻ hot reload stopped (watch error): ${error instanceof Error ? error.message : String(error)}`,
      );
      if (reloadTimer) clearTimeout(reloadTimer);
      watcher?.close();
      watcher = undefined;
    });
  } catch {
    // Recursive watch is unsupported on some platforms; hot-reload is best-effort.
  }

  return {
    preview,
    loadedEnv,
    watching: watcher !== undefined,
    close: async () => {
      if (reloadTimer) clearTimeout(reloadTimer);
      watcher?.close();
      await preview.close();
    },
  };
}

// Warm-on-stone palette shared with `noodle init` / first-run. Auto-degrades to plain text off a TTY.
const INK: RGB = [231, 229, 228];
const DIM: RGB = [168, 162, 158];
const FAINT: RGB = [120, 113, 108];
const GREEN: RGB = [74, 222, 128];

/**
 * The branded banner for a running preview — the same warm palette + glyphs as `noodle init`. Returns lines
 * (the caller prints them) so it stays testable; ANSI is emitted only on an interactive stdout.
 */
export function previewBannerLines(
  session: PreviewSession,
  opts: {
    title: string;
    mcpUrl: string;
    theme: string;
    device: string;
    model?: string;
    watchDir: string;
    localTarget: EffectiveLocalTargetResolution;
  },
): string[] {
  const mode = detectColorMode(process.stdout);
  const glyph = detectGlyphMode();
  const gg = (unicode: string, ascii: string): string => (glyph === 'ascii' ? ascii : unicode);
  const p = (rgb: RGB, s: string): string => paint(rgb, s, mode);
  const key = (s: string): string => p(DIM, s.padEnd(9));
  const connectedProvider = [
    {
      label: 'OpenAI',
      keyEnv: 'OPENAI_API_KEY',
      model: opts.model ?? process.env.OPENAI_MODEL ?? DEFAULT_CHAT_MODELS.openai,
    },
    {
      label: 'Claude',
      keyEnv: 'ANTHROPIC_API_KEY',
      model: process.env.ANTHROPIC_MODEL ?? DEFAULT_CHAT_MODELS.anthropic,
    },
    {
      label: 'Gemini',
      keyEnv: 'GEMINI_API_KEY',
      model: process.env.GEMINI_MODEL ?? DEFAULT_CHAT_MODELS.gemini,
    },
  ].find((provider) => process.env[provider.keyEnv]);

  const lines = [
    '',
    `${p(ORANGE, gg('◆', '*'))} ${p(INK, opts.title)}  ${p(FAINT, gg('· preview ready', '- preview ready'))}`,
    `  ${key('preview')}${p(ORANGE, session.preview.url)}`,
    `  ${key('mcp')}${p(DIM, opts.mcpUrl)}`,
    `  ${key('target')}${p(DIM, localTargetDisplay(opts.localTarget))}`,
    `  ${key('view')}${p(FAINT, `theme ${opts.theme}  ·  device ${opts.device}`)}`,
  ];
  if (opts.localTarget.ignoredSavedTarget) {
    lines.push(`  ${p(DIM, UNLINKED_LOCAL_TARGET_HINT)}`);
  }
  if (connectedProvider) {
    const src = session.loadedEnv.keys.includes(connectedProvider.keyEnv)
      ? ` · from ${session.loadedEnv.file}`
      : '';
    lines.push(
      `  ${key('chat')}${p(GREEN, gg('✔', '+'))} ${p(
        FAINT,
        `${connectedProvider.label} · model ${connectedProvider.model}${src}`,
      )}`,
    );
  } else {
    lines.push(
      `  ${key('chat')}${p(AMBER, gg('⚠', '!'))} ${p(
        FAINT,
        'add an API key in Chat · OpenAI, Claude, or Gemini',
      )}`,
    );
  }
  if (session.watching) {
    lines.push(`  ${key('watch')}${p(FAINT, `${opts.watchDir}  ·  edit + save to hot-reload`)}`);
  }
  lines.push('');
  return lines;
}
