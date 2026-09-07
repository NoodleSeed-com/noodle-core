import type { OpenApiImportRequestBody } from './request-body.js';
import type { OpenApiImportSchema } from './response-schema.js';

export type OpenApiMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';
export type OpenApiParameterLocation = 'path' | 'query';

/**
 * A small lossless JSON Schema fragment for one imported parameter: the OpenAPI scalar `type`
 * (`integer` stays `integer`), a string `enum`, `format`, and OpenAPI 3.0 `nullable: true`
 * rendered as a `[<type>, 'null']` type union. Absent schemas default to string;
 * unsupported declared input constraints fail with repair guidance.
 */
export interface OpenApiImportParameterSchema {
  readonly type: string | readonly string[];
  readonly enum?: readonly string[];
  readonly format?: string;
}

export interface OpenApiImportParameter {
  readonly name: string;
  readonly in: OpenApiParameterLocation;
  readonly required: boolean;
  readonly schema: OpenApiImportParameterSchema;
}

export interface OpenApiImportOperation {
  readonly name: string;
  readonly safeName: string;
  readonly method: OpenApiMethod;
  readonly operationType: 'read' | 'action';
  readonly path: string;
  readonly connectorPath: string;
  readonly description: string;
  readonly parameters: readonly OpenApiImportParameter[];
  readonly requestBody?: OpenApiImportRequestBody;
  readonly query: readonly string[];
  /** Typed output tree imported from the 2xx application/json response schema, when supported. */
  readonly output?: OpenApiImportSchema;
}

export type OpenApiImportAuth =
  | { readonly kind: 'apiKey'; readonly header: string; readonly secret: string }
  | { readonly kind: 'bearer'; readonly secret: string };

export interface OpenApiImportIr {
  readonly connectorId: string;
  readonly serverTitle: string;
  readonly baseUrl: string;
  readonly operations: readonly OpenApiImportOperation[];
  /** Connector-level auth mapped from the first auto-mappable referenced security scheme. */
  readonly auth?: OpenApiImportAuth;
  /** Secret references the imported connector declares; values must be set out-of-band. */
  readonly secretRefs: readonly string[];
  readonly warnings: readonly string[];
}

export interface ParseOpenApiOptions {
  readonly name: string;
  readonly baseUrl?: string;
}

export interface MergeOpenApiIntoDraftInput {
  readonly manifest: string;
  readonly connectors?: string;
  readonly ir: OpenApiImportIr;
}

export interface MergeOpenApiIntoDraftResult {
  readonly manifest: string;
  readonly connectors: string;
  readonly addedTools: readonly string[];
  readonly addedOperations: readonly string[];
  readonly secretRefs: readonly string[];
  readonly warnings: readonly string[];
}
