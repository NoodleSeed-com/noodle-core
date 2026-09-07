/**
 * Vitest runs with the repository root as cwd, and the checkout itself is a
 * Noodle project (`noodle.json` + a real `.noodle/` link on contributor
 * machines). Commands whose target resolution reads `<cwd>/.noodle` first
 * would otherwise pick up that real project state instead of the isolated
 * test config. Pair `chdirIsolated` in beforeEach with `restoreCwd` in
 * afterEach so every test runs from its own empty temp home.
 */
const cwdStack: string[] = [];

export function chdirIsolated(dir: string): void {
  cwdStack.push(process.cwd());
  process.chdir(dir);
}

export function restoreCwd(): void {
  const previous = cwdStack.pop();
  if (previous !== undefined) process.chdir(previous);
}
