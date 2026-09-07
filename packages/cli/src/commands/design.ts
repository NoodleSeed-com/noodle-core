import { buildDesignBrief } from '../devtools-design-brief.js';
import { createDesignStore, DesignStoreCorruptError } from '../devtools-design-store.js';
import { findDeployProjectRoot } from './deploy-target.js';
import { EXIT, printJsonFailure, printJsonOk } from './output.js';

export interface DesignInspectArgs {
  readonly latest: true;
  readonly json: boolean;
}

const USAGE = 'Use `noodle design inspect --latest [--json]`.';

export function parseDesignArgs(rest: readonly string[]): DesignInspectArgs {
  if (rest[0] !== 'inspect') throw new Error(USAGE);
  let latest = false;
  let json = false;
  for (const token of rest.slice(1)) {
    if (token === '--latest' && !latest) {
      latest = true;
    } else if (token === '--json' && !json) {
      json = true;
    } else {
      throw new Error(USAGE);
    }
  }
  if (!latest) throw new Error(USAGE);
  return { latest: true, json };
}

function usageFailure(json: boolean): number {
  const error = {
    code: 'design_usage',
    message: USAGE,
    fix: 'Pass the required `--latest` selector and no other flags.',
    next: 'noodle design inspect --latest --json',
  };
  if (json) return printJsonFailure(error, EXIT.USAGE);
  console.error(`design: ${error.message}`);
  console.error(`Fix: ${error.fix}`);
  return EXIT.USAGE;
}

function failure(
  json: boolean,
  error: {
    readonly code: string;
    readonly message: string;
    readonly fix: string;
    readonly next: string;
  },
  exitCode: number,
): number {
  if (json) return printJsonFailure(error, exitCode);
  console.error(`design: ${error.message}`);
  console.error(`Fix: ${error.fix}`);
  console.error(`Next: ${error.next}`);
  return exitCode;
}

export function runDesign(rest: readonly string[], cwd: string = process.cwd()): number {
  const wantsJson = rest.includes('--json');
  let args: DesignInspectArgs;
  try {
    args = parseDesignArgs(rest);
  } catch {
    return usageFailure(wantsJson);
  }

  const projectRoot = findDeployProjectRoot(cwd);
  if (projectRoot === undefined) {
    return failure(
      args.json,
      {
        code: 'design_project_missing',
        message: 'Run this command from a Noodle project.',
        fix: 'Change into a project containing noodle.json and retry.',
        next: 'noodle design inspect --latest --json',
      },
      EXIT.USAGE,
    );
  }

  try {
    const session = createDesignStore(projectRoot).readLatest();
    if (session === undefined) {
      return failure(
        args.json,
        {
          code: 'design_brief_missing',
          message: 'No ready Noodle Design brief exists in this project.',
          fix: 'Open `noodle devtools`, annotate the widget in Design, then choose Send to agent.',
          next: 'noodle devtools',
        },
        EXIT.FAILURE,
      );
    }
    const brief = buildDesignBrief(session);
    if (args.json) {
      printJsonOk({ version: 1 as const, ...brief });
    } else {
      console.log(brief.markdown);
    }
    return EXIT.OK;
  } catch (error) {
    if (!(error instanceof DesignStoreCorruptError)) throw error;
    return failure(
      args.json,
      {
        code: 'design_brief_invalid',
        message: 'The latest Noodle Design brief is unreadable.',
        fix: 'Return to Design in `noodle devtools` and choose Send to agent again.',
        next: 'noodle devtools',
      },
      EXIT.FAILURE,
    );
  }
}
