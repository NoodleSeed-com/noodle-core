const MINIMUM_NODE_MAJOR = 24;

function nodeMajor(version: string): number | null {
  const match = /^v?(\d+)(?:\.|$)/.exec(version.trim());
  return match ? Number(match[1]) : null;
}

export function isSupportedNodeVersion(version: string = process.versions.node): boolean {
  const major = nodeMajor(version);
  return major !== null && major >= MINIMUM_NODE_MAJOR;
}

export function unsupportedNodeMessage(version: string = process.versions.node): string {
  return [
    `noodle requires Node.js ${MINIMUM_NODE_MAJOR} or newer; current runtime is Node.js ${version}.`,
    `Fix: run noodle under a Node ${MINIMUM_NODE_MAJOR}+ runtime. Two paths:`,
    `  Zero-install (uses a project-local Node ${MINIMUM_NODE_MAJOR} if present): npx @noodleseed/one@latest <command>`,
    '  Switch your Node, then reinstall the global CLI so the noodle bin uses it:',
    '    nvm:   nvm install 24 && nvm use 24 && hash -r && npm install -g @noodleseed/one@latest',
    '    fnm:   fnm install 24 && fnm use 24 && hash -r && npm install -g @noodleseed/one@latest',
    '    mise:  mise use -g node@24 && hash -r && npm install -g @noodleseed/one@latest',
    '    volta: volta install node@24 && npm install -g @noodleseed/one@latest',
  ].join('\n');
}
