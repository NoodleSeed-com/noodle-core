import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Load the OpenAI playground credentials for `noodle devtools` from a git-ignored `.env.local` (or `.env`)
 * in the project directory. This is developer-tooling config — NOT an app secret. It is intentionally kept
 * out of the managed `.env.noodle` / `noodle secrets` store (which is brokered to the deployed app runtime).
 *
 * Safety rules:
 *   - only `OPENAI_*` keys are read from the file, so a stray `.env` can never clobber `PATH` or other env;
 *   - a value already present in the environment always wins (shell/flag precedence over the file);
 *   - values are never logged — only key names and the file name are surfaced.
 */

const ENV_FILES = ['.env.local', '.env'] as const;
const KEY_PREFIX = 'OPENAI_';
const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/** Parse dotenv-style `KEY=VALUE` text, tolerating comments, blank lines, `export`, and simple quotes. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = LINE.exec(line);
    if (!match) continue;
    const key = match[1];
    if (key === undefined) continue;
    let value = (match[2] ?? '').trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export interface LoadedDevtoolsEnv {
  /** The env file the values came from (relative name), or undefined if none was found/applied. */
  readonly file?: string;
  /** The `OPENAI_*` key names applied to the environment (never the values). */
  readonly keys: string[];
}

/**
 * Read `.env.local` then `.env` from `dir` and apply any `OPENAI_*` keys to `env` (default `process.env`)
 * without overriding values that are already set. Returns which file and keys were applied for logging.
 */
export function loadDevtoolsEnv(
  dir: string,
  opts: { env?: Record<string, string | undefined> } = {},
): LoadedDevtoolsEnv {
  const env = opts.env ?? process.env;
  const keys: string[] = [];
  let file: string | undefined;
  for (const name of ENV_FILES) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    let parsed: Record<string, string>;
    try {
      parsed = parseDotenv(readFileSync(path, 'utf8'));
    } catch {
      continue;
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (!key.startsWith(KEY_PREFIX)) continue;
      if (env[key] !== undefined && env[key] !== '') continue;
      env[key] = value;
      keys.push(key);
      if (file === undefined) file = name;
    }
  }
  return { keys, ...(file !== undefined ? { file } : {}) };
}
