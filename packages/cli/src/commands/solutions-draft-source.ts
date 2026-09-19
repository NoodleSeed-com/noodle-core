import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  APPLICATION_DRAFT_LIMITS,
  ApplicationDraftSourceSchema,
} from '@noodle-borg/wire-contracts';

/** Explicit source-directory upload; never dotenv, dependency trees, generated output or symlinks. */
export async function readDraftSource(directory: string, entrypoint = 'server.ts') {
  const root = resolve(directory);
  const files: { path: string; content: string }[] = [];
  let visited = 0,
    bytes = 0;
  async function walk(relative: string): Promise<void> {
    const folder = join(root, relative);
    const info = await lstat(folder);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('Source directories must not be symbolic links.');
    const entries = await readdir(folder, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || ['node_modules', 'dist', 'coverage'].includes(entry.name))
        continue;
      if (++visited > 512) throw new Error('Select a smaller source directory.');
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error('Source must not contain symbolic links.');
      if (path.length > APPLICATION_DRAFT_LIMITS.pathChars)
        throw new Error('Source path exceeds the supported length.');
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile() || !/\.(ts|tsx|css)$/.test(path)) continue;
      if (files.length >= APPLICATION_DRAFT_LIMITS.files) throw new Error('Too many source files.');
      const file = await open(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await file.stat();
        if (!before.isFile() || before.size > APPLICATION_DRAFT_LIMITS.fileBytes)
          throw new Error('Source file exceeds the supported size.');
        const buffer = Buffer.alloc(APPLICATION_DRAFT_LIMITS.fileBytes + 1);
        const read = await file.read(buffer, 0, buffer.length, 0);
        const after = await file.stat();
        bytes += read.bytesRead;
        if (
          read.bytesRead > APPLICATION_DRAFT_LIMITS.fileBytes ||
          bytes > APPLICATION_DRAFT_LIMITS.totalBytes
        )
          throw new Error('Source exceeds the supported size.');
        if (
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          read.bytesRead !== after.size
        )
          throw new Error('Source changed while reading; retry after saving your files.');
        files.push({
          path,
          content: new TextDecoder('utf8', { fatal: true }).decode(
            buffer.subarray(0, read.bytesRead),
          ),
        });
      } finally {
        await file.close();
      }
    }
  }
  await walk('');
  const parsed = ApplicationDraftSourceSchema.safeParse({ entrypoint, files });
  if (!parsed.success)
    throw new Error(
      'Source must contain the TypeScript entrypoint and bounded relative .ts, .tsx or .css files.',
    );
  return parsed.data;
}
