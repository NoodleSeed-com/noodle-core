import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import {
  MAX_OPENAPI_SOURCE_BYTES,
  type OpenApiImportIr,
  type OpenApiImportParameterSchema,
  type OpenApiImportSchema,
  parseOpenApiToIr,
  title,
} from '@noodle-borg/openapi-import';
import { slug } from './deploy.js';
import { importedProjectFiles, writeImportedProject } from './import-scaffold.js';

export interface ImportOpenApiOptions {
  readonly specPath: string;
  readonly output: string;
  readonly name: string;
  readonly baseUrl?: string;
  readonly force?: boolean;
}

export function importOpenApiProject(options: ImportOpenApiOptions): {
  readonly output: string;
  readonly warnings: readonly string[];
} {
  const ir = parseOpenApiToIr(readOpenApiSource(options.specPath), {
    name: options.name,
    ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
  });
  const files = importedProjectFiles(slug(options.name), renderTypeScriptProject(ir));
  files['.env.example'] += ir.secretRefs.map((name) => `${name}=\n`).join('');
  files['README.md'] = `# ${title(options.name)}

Generated from OpenAPI in \`src/server.ts\`. Each operation shares one input/output schema
between its connector and tool. Review the imported operations and warnings before deployment.
This command writes files only; it does not install dependencies or contact the backend.

\`\`\`sh
npm install --ignore-scripts
npm run agent:check
npm exec -- noodle agents setup --apply
\`\`\`

The generated test proves the offline contract compiles, not live backend behavior. Review each
action before calling it; writes require explicit confirmation. Add a sandbox fixture for one
representative operation before deployment. Supported JSON request bodies are typed under \`input.body\`
and sent unchanged; required fields, optional bodies, arrays, integers and object extras survive import.
Unsupported encodings or constraints stop import before writing; use the connector guide to author them:
https://docs.noodleseed.dev/docs/guides/connectors
${
  ir.secretRefs.length
    ? `\nSet ${ir.secretRefs.map((name) => `\`${name}\``).join(', ')} locally in ignored \`.env\` or \`.env.noodle\`.
For hosted deployment, use \`noodle secrets set <NAME>\` interactively; never paste values into
commands, source, logs or agent context.\n`
    : ''
}
`;
  writeImportedProject({ dir: options.output, force: options.force ?? false }, files);
  return { output: options.output, warnings: ir.warnings };
}

function renderTypeScriptProject(ir: OpenApiImportIr): string {
  const base = new URL(ir.baseUrl);
  const contracts = ir.operations.map(
    (operation) => `${key(operation.safeName)}: {
    input: ${zodInputObject(operation)},
    output: z.object({ value: ${operation.output === undefined ? 'z.unknown()' : zodSource(operation.output)} }),
  }`,
  );
  const operations = ir.operations.map((operation) => {
    const query =
      operation.query.length > 0 ? `query: [${operation.query.map(quote).join(', ')}],` : '';
    return `${key(operation.safeName)}: {
        type: '${operation.operationType}',
        method: '${operation.method.toUpperCase()}',
        path: ${quote(operation.connectorPath)},
        input: contracts[${quote(operation.safeName)}].input,
        ${query}
        ${operation.requestBody === undefined ? '' : "request: '${args.body}',"}
        output: contracts[${quote(operation.safeName)}].output,
        response: { value: '\${response}' },
      }`;
  });
  const tools = ir.operations.map((operation) => {
    const callArgs = [
      ...operation.parameters.map((param) => param.name),
      ...(operation.requestBody === undefined ? [] : ['body']),
    ]
      .map((name) => `${key(name)}: input[${quote(name)}]`)
      .join(', ');
    return `tool(${quote(operation.safeName)}, {
    description: ${quote(operation.description)},
    annotations: ${operation.operationType === 'read' ? 'annotations.readOnly({ openWorld: true })' : 'annotations.openAction({ destructive: true, confirm: true })'},
    input: contracts[${quote(operation.safeName)}].input,
    output: contracts[${quote(operation.safeName)}].output,
    fulfil: ({ input, connectors }) => ({
      value: connectors.api[${quote(operation.safeName)}]({ ${callArgs} }).value,
    }),
  })`;
  });
  const server = `import { annotations, connector, ${ir.auth === undefined ? '' : 'secret, '}server, tool, z } from '@noodleseed/one';

// CONTRACT SEAM: one schema lineage from backend operation to public tool.
const contracts = {
  ${contracts.join(',\n  ')}
};

const api = connector(${quote(ir.connectorId)})
  .version('1.0.0')
  .http({
    baseUrl: ${quote(ir.baseUrl)},
    allowedOrigins: [${quote(base.origin)}],
    ${ir.auth === undefined ? '' : `auth: { kind: ${quote(ir.auth.kind)}, ${ir.auth.kind === 'apiKey' ? `header: ${quote(ir.auth.header)}, ` : ''}secret: secret(${quote(ir.auth.secret)}) },`}
    operations: {
      ${operations.join(',\n      ')}
    },
  });

export default server(${quote(ir.connectorId)}, {
  title: ${quote(ir.serverTitle)},
  version: '1.0.0',
  use: { api },
}, [
  ${tools.join(',\n  ')}
]);
`;
  return server;
}

const IDENTIFIER_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Renders a parameter list as `z.object({ ... })` source with per-parameter lossless Zod. */
function zodInputObject(operation: OpenApiImportIr['operations'][number]): string {
  if (operation.parameters.length === 0 && operation.requestBody === undefined)
    return 'z.object({})';
  const properties = operation.parameters.map(
    (param) =>
      `${key(param.name)}: ${zodParameterSource(param.schema)}${param.schema.format === undefined ? '' : `.meta({ format: ${quote(param.schema.format)} })`}${param.required ? '' : '.optional()'}`,
  );
  if (operation.requestBody !== undefined) {
    properties.push(
      `body: ${zodSource(operation.requestBody.schema)}${operation.requestBody.required ? '' : '.optional()'}`,
    );
  }
  return `z.object({ ${properties.join(', ')} }).strict()`;
}

/**
 * Renders one imported parameter schema as Zod source: string/number/boolean map directly,
 * `integer` becomes `z.number().int()`, a string `enum` becomes `z.enum([...])`, and a
 * `[<type>, 'null']` union renders as `.nullable()`.
 */
function zodParameterSource(schema: OpenApiImportParameterSchema): string {
  const types = typeof schema.type === 'string' ? [schema.type] : schema.type;
  const nullable = types.includes('null') ? '.nullable()' : '';
  const base = types.find((entry) => entry !== 'null') ?? 'string';
  if (schema.enum !== undefined && schema.enum.length > 0) {
    return `z.enum([${schema.enum.map((entry) => quote(entry)).join(', ')}])${nullable}`;
  }
  switch (base) {
    case 'number':
      return `z.number()${nullable}`;
    case 'integer':
      return `z.number().int()${nullable}`;
    case 'boolean':
      return `z.boolean()${nullable}`;
    default:
      return `z.string()${nullable}`;
  }
}

/** Renders an imported response schema tree as deterministic Zod source text. */
function zodSource(schema: OpenApiImportSchema): string {
  const nullable = 'nullable' in schema && schema.nullable === true ? '.nullable()' : '';
  switch (schema.kind) {
    case 'string':
      if (schema.enum !== undefined) {
        return `z.enum([${schema.enum.map((entry) => quote(entry)).join(', ')}])${nullable}`;
      }
      return `z.string()${nullable}`;
    case 'number':
      return `z.number()${schema.integer === true ? '.int()' : ''}${nullable}`;
    case 'boolean':
      return `z.boolean()${nullable}`;
    case 'array':
      return `z.array(${zodSource(schema.items)})${nullable}`;
    case 'object': {
      if (schema.properties.length === 0 && schema.additionalProperties === undefined) {
        return `z.record(z.string(), z.unknown())${nullable}`;
      }
      const properties = schema.properties.map((property) => {
        const optional = property.required ? '' : '.optional()';
        return `${key(property.name)}: ${zodSource(property.schema)}${optional}`;
      });
      const extras =
        schema.additionalProperties === undefined
          ? ''
          : schema.additionalProperties
            ? '.passthrough()'
            : '.strict()';
      return `z.object({ ${properties.join(', ')} })${extras}${nullable}`;
    }
    case 'unknown':
      return 'z.unknown()';
  }
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function key(value: string): string {
  if (value === '__proto__') return `[${quote(value)}]`;
  return IDENTIFIER_KEY.test(value) ? value : quote(value);
}

/** Read a regular local input with a fixed allocation, even if its size changes during the read. */
function readOpenApiSource(path: string): string {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!fstatSync(descriptor).isFile())
      throw new Error('import openapi: spec must be a regular file');
    const bytes = Buffer.alloc(MAX_OPENAPI_SOURCE_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, length);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_OPENAPI_SOURCE_BYTES)
      throw new Error(
        'import openapi: document exceeds the 6 MiB size limit; import a scoped API document',
      );
    return bytes.subarray(0, length).toString('utf8');
  } finally {
    closeSync(descriptor);
  }
}
