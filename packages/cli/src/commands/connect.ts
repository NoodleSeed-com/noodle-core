import { setupAgents } from '../agents.js';
import { errorMessage, printRecovery } from '../diagnostics.js';
import { readProjectDeployment } from '../project.js';
import { type ConnectConfig, connectConfig } from './connect-config.js';
import { connectGeminiEnterprise, type GeminiEnterpriseSetup } from './connect-oauth.js';
import { EXIT, printJsonFailure, printJsonOk, printRawJsonForHumanDebug } from './output.js';

export async function runConnect(rest: readonly string[]): Promise<number> {
  const [client, ...tail] = rest;
  const json = rest.includes('--json');
  const write = tail.includes('--write');
  const supported = [
    'claude-code',
    'codex',
    'gemini',
    'gemini-enterprise',
    'cursor',
    'vscode',
    'claude',
    'chatgpt',
    'inspector',
  ];
  if (client === undefined || !supported.includes(client)) {
    if (json) {
      return printJsonFailure(
        {
          code: 'usage_error',
          message: 'connect requires a supported client.',
          fix: `Choose one of: ${supported.join(', ')}.`,
          next: 'noodle connect --help',
        },
        EXIT.USAGE,
      );
    }
    console.error(
      'connect: expected claude-code, codex, gemini, gemini-enterprise, cursor, vscode, claude, chatgpt, or inspector',
    );
    return 2;
  }
  const endpoint = flagValue(tail, '--endpoint');
  if (client === 'gemini-enterprise') {
    const resolvedEndpoint = endpoint ?? readProjectDeployment()?.url;
    if (resolvedEndpoint === undefined) {
      if (json) {
        return printJsonFailure(
          {
            code: 'endpoint_required',
            message: 'No MCP endpoint was provided or saved.',
            fix: 'Deploy this project first or pass --endpoint with the hosted MCP URL.',
            next: 'noodle deploy',
          },
          EXIT.USAGE,
        );
      }
      printRecovery({
        command: 'connect gemini-enterprise',
        cause: 'No MCP endpoint was provided and no saved deployment metadata was found.',
        fix: 'Deploy this project first or pass --endpoint with the hosted MCP URL.',
        next: 'noodle deploy',
      });
      return 2;
    }
    try {
      const name = flagValue(tail, '--name');
      const config = await connectGeminiEnterprise({
        endpoint: resolvedEndpoint,
        ...(name !== undefined ? { name } : {}),
      });
      if (json) {
        printJsonOk(config);
        return 0;
      }
      printGeminiEnterpriseSetup(config);
      return 0;
    } catch (error) {
      if (json) {
        return printJsonFailure(
          {
            code: 'connect_failed',
            message: errorMessage(error),
            fix: 'Confirm the hosted MCP endpoint is reachable and advertises OAuth protected-resource metadata.',
            next: `noodle connect gemini-enterprise --endpoint ${resolvedEndpoint}`,
          },
          EXIT.FAILURE,
        );
      }
      printRecovery({
        command: 'connect gemini-enterprise',
        cause: errorMessage(error),
        fix: 'Confirm the hosted MCP endpoint is reachable and advertises OAuth protected-resource metadata.',
        next: `noodle connect gemini-enterprise --endpoint ${resolvedEndpoint}`,
      });
      return 1;
    }
  }
  // Plugin-packaging path (M5): with a deployed endpoint, emit the real MCP client registration config so a
  // developer can ship the hosted server as a Codex/Claude Code plugin (or connector) from one server.ts.
  if (endpoint !== undefined) {
    const config = connectConfig(client, flagValue(tail, '--name') ?? 'noodle-server', endpoint);
    if (json) {
      printJsonOk(config);
      return 0;
    }
    printConnectConfig(config);
    return 0;
  }
  if (write) {
    if (client === 'codex' || client === 'claude-code') {
      const report = setupAgents({
        agents: [client],
        project: process.cwd(),
        write: true,
        force: false,
        json,
      });
      if (json) {
        printJsonOk({ client, agents: report });
        return 0;
      }
      console.log(`Connected ${client} with project-local Noodle agent files.`);
      for (const file of report.files) console.log(`  ${file.action} ${file.path}`);
      return 0;
    }
    if (json) {
      return printJsonFailure(
        {
          code: 'unsupported_write_target',
          message: 'connect --write does not support this client.',
          fix: 'Use the printed setup flow for this client.',
          next: `noodle connect ${client}`,
        },
        EXIT.USAGE,
      );
    }
    printRecovery({
      command: 'connect',
      cause: 'connect --write currently supports project-local Codex and Claude Code setup.',
      fix: 'Use the printed setup flow for this client.',
      next: `noodle connect ${client}`,
    });
    return 2;
  }
  const steps = connectSteps(client);
  if (json) {
    printJsonOk({ client, steps });
    return 0;
  }
  console.log(`Client: ${client}`);
  for (const step of steps) console.log(`- ${step}`);
  return 0;
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function printConnectConfig(config: ConnectConfig): void {
  console.log(`Client: ${config.title}`);
  if (!config.verified) {
    console.log(
      "Note: this client's config format is not officially documented; the block below is a starting point.",
    );
  }
  if (config.config !== undefined) {
    console.log('Add to your MCP client config:');
    printRawJsonForHumanDebug(config.config, 2);
  }
  if (config.command !== undefined) console.log(`Or run: ${config.command}`);
  for (const step of config.steps ?? []) console.log(`- ${step}`);
}

function printGeminiEnterpriseSetup(config: GeminiEnterpriseSetup): void {
  console.log('Gemini Enterprise MCP setup');
  console.log('');
  console.log('MCP Server URL:');
  console.log(`  ${config.mcpServerUrl}`);
  console.log('');
  console.log('Authorization URL:');
  console.log(`  ${config.authorizationUrl}`);
  console.log('');
  console.log('Authorization URL Parameters:');
  console.log(`  ${config.authorizationUrlParameters || '(leave blank)'}`);
  console.log('');
  console.log('Token URL:');
  console.log(`  ${config.tokenUrl}`);
  console.log('');
  console.log('Client ID:');
  console.log(`  ${config.clientId}`);
  console.log('');
  console.log('Client Secret (sensitive, shown once):');
  console.log(`  ${config.clientSecret}`);
  console.log('');
  console.log('Scopes:');
  console.log('  (leave blank)');
  console.log('');
  console.log('Enable PKCE Support:');
  console.log('  checked');
  console.log('');
  console.log('MCP Server Description:');
  console.log(`  ${config.description}`);
  console.log('');
  console.log('MCP Agent Instructions:');
  console.log(`  ${config.instructions}`);
}

function connectSteps(client: string): string[] {
  if (client === 'codex' || client === 'claude-code') {
    return [
      `noodle agents setup --write --agents ${client}`,
      'noodle agents doctor',
      'noodle docs export --format llms',
    ];
  }
  if (['gemini', 'cursor', 'vscode'].includes(client)) {
    return [
      'V1 project-local agent setup supports Codex and Claude Code.',
      'Use `noodle docs export --format llms` as portable context for this client.',
    ];
  }
  if (client === 'inspector')
    return ['noodle dev', 'npx @modelcontextprotocol/inspector <printed MCP endpoint>'];
  return [
    'noodle deploy',
    'noodle open --print',
    'Add the printed MCP endpoint to the client and sign in when prompted.',
  ];
}
