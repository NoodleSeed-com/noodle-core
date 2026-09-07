import type { InitTemplate } from './project.js';

/** Shared content contract: scripts, environment declarations and executable fixtures use these seams. */
export interface ScaffoldModel {
  readonly widget: boolean;
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly invalidInput: Readonly<Record<string, unknown>>;
  readonly expected: Readonly<Record<string, unknown>>;
  readonly variables: readonly string[];
  readonly httpFixture: boolean;
}

const workspace: ScaffoldModel = {
  widget: true,
  tool: 'show_preferences',
  input: {},
  invalidInput: { unexpected: 'not permitted' },
  expected: { channel: 'email', demo: true },
  variables: [],
  httpFixture: false,
};

export const SCAFFOLD_MODELS: Readonly<Record<InitTemplate, ScaffoldModel>> = {
  hello: {
    widget: false,
    tool: 'greet',
    input: { name: 'Ada' },
    invalidInput: { name: 7 },
    expected: { message: 'Hello, Ada!' },
    variables: [],
    httpFixture: false,
  },
  'http-api': {
    widget: false,
    tool: 'get_post',
    input: { post_id: '1' },
    invalidInput: { post_id: '../private' },
    expected: { title: 'Fixture post', body: 'Synthetic test content.' },
    variables: ['POSTS_API_ORIGIN'],
    httpFixture: true,
  },
  widget: workspace,
  saas: { ...workspace, variables: ['ASSISTANT_ORIGIN'] },
};

export function scaffoldEnvironment(model: ScaffoldModel): string {
  return (
    '# Names only. Bind the exact local or hosted target with noodle variables set.\n' +
    model.variables.map((name) => `${name}=\n`).join('')
  );
}
