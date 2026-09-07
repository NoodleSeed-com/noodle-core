import type { McpImportedTool, McpImportSnapshot } from './types.js';

export function renderMcpServerSource(snapshot: McpImportSnapshot): string {
  const needsSecret = snapshot.auth !== undefined;
  const imports = ['annotations', 'connector', 'server', 'tool', 'variable'];
  if (needsSecret) imports.push('secret');
  const operations = snapshot.tools.map(renderOperation).join(',\n      ');
  const tools = snapshot.tools.map(renderTool).join(',\n  ');
  const auth = snapshot.auth === undefined ? '' : `\n    auth: ${renderAuth(snapshot.auth)},`;
  return `import { ${imports.sort().join(', ')} } from '@noodleseed/one';

const upstream = connector(${quote(snapshot.connectorId)})
  .version('1.0.0')
  .mcp({
    endpoint: variable(${quote(snapshot.endpointVariable)}),
    allowedOrigins: [variable(${quote(snapshot.originVariable)})],${auth}
    operations: {
      ${operations}
    },
  });

export default server(${quote(snapshot.connectorId)}, {
  title: ${quote(title(snapshot.connectorId))},
  version: '1.0.0',
  use: { upstream },
}, [
  ${tools}
]);
`;
}

function renderOperation(tool: McpImportedTool): string {
  return `${tool.operationName}: {
        type: ${quote(tool.operationType)},
        tool: ${quote(tool.upstreamName)},
        result: ${quote(tool.result)},
        input: ${json(tool.inputSchema, 8)},
        output: ${json(tool.outputSchema, 8)},
      }`;
}

function renderTool(item: McpImportedTool): string {
  const annotations =
    item.operationType === 'read'
      ? 'annotations.readOnly({ openWorld: true })'
      : `annotations.openAction({ destructive: ${String(item.destructive)}, confirm: true })`;
  const properties = schemaProperties(item.outputSchema);
  const input = schemaProperties(item.inputSchema)
    .map((property) => `${quote(property)}: input[${quote(property)}]`)
    .join(', ');
  const operationCall = `connectors.upstream.${item.operationName}({ ${input} })`;
  const outputSchema =
    properties.length === 0
      ? {
          type: 'object',
          properties: { result: item.outputSchema },
          required: ['result'],
          additionalProperties: false,
        }
      : item.outputSchema;
  const fulfil =
    properties.length === 0
      ? `({ input, connectors }) => ({ result: ${operationCall}.raw })`
      : `({ input, connectors }) => {
      const result = ${operationCall};
      return {
${properties.map((property) => `        ${quote(property)}: result[${quote(property)}],`).join('\n')}
      };
    }`;
  return `tool(${quote(item.operationName)}, {
    title: ${quote(title(item.operationName))},
    description: ${quote(item.description)},
    annotations: ${annotations},
    input: ${json(item.inputSchema, 4)},
    output: ${json(outputSchema, 4)},
    fulfil: ${fulfil},
  })`;
}

function schemaProperties(schema: Readonly<Record<string, unknown>>): readonly string[] {
  const properties = schema.properties;
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) return [];
  return Object.keys(properties).sort();
}

function renderAuth(auth: NonNullable<McpImportSnapshot['auth']>): string {
  if (auth.kind === 'bearer') {
    return `{ kind: 'bearer', secret: secret(${quote(auth.secretRef)}) }`;
  }
  return `{ kind: 'apiKey', header: ${quote(auth.header ?? 'x-api-key')}, secret: secret(${quote(auth.secretRef)}) }`;
}

function json(value: unknown, indentation: number): string {
  const pad = ' '.repeat(indentation);
  return JSON.stringify(value, null, 2).replace(/\n/g, `\n${pad}`);
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function title(value: string): string {
  return value
    .split('_')
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join(' ');
}
