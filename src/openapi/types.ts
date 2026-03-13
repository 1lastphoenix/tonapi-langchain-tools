export type HttpMethod =
  | "get"
  | "post"
  | "put"
  | "patch"
  | "delete"
  | "options"
  | "head";

export type ParameterLocation = "path" | "query" | "header" | "cookie";

export interface ReferenceObject {
  $ref: string;
}

export interface OpenApiInfo {
  title: string;
  version: string;
  description?: string;
}

export interface OpenApiServer {
  url: string;
  description?: string;
}

export interface OpenApiSchema {
  type?: "string" | "number" | "integer" | "boolean" | "array" | "object" | "null";
  format?: string;
  description?: string;
  enum?: Array<string | number | boolean | null>;
  nullable?: boolean;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minItems?: number;
  maxItems?: number;
  required?: string[];
  properties?: Record<string, OpenApiSchema | ReferenceObject>;
  items?: OpenApiSchema | ReferenceObject;
  additionalProperties?: boolean | OpenApiSchema | ReferenceObject;
  allOf?: Array<OpenApiSchema | ReferenceObject>;
  anyOf?: Array<OpenApiSchema | ReferenceObject>;
  oneOf?: Array<OpenApiSchema | ReferenceObject>;
  [extension: `x-${string}`]: unknown;
}

export interface OpenApiMediaType {
  schema?: OpenApiSchema | ReferenceObject;
}

export interface OpenApiRequestBody {
  description?: string;
  required?: boolean;
  content: Record<string, OpenApiMediaType>;
}

export interface OpenApiResponse {
  description?: string;
  content?: Record<string, OpenApiMediaType>;
}

export interface OpenApiParameter {
  name: string;
  in: ParameterLocation;
  required?: boolean;
  description?: string;
  schema?: OpenApiSchema | ReferenceObject;
  explode?: boolean;
  style?: string;
}

export interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
  parameters?: Array<OpenApiParameter | ReferenceObject>;
  requestBody?: OpenApiRequestBody | ReferenceObject;
  responses?: Record<string, OpenApiResponse | ReferenceObject>;
}

export interface OpenApiPathItem {
  parameters?: Array<OpenApiParameter | ReferenceObject>;
  get?: OpenApiOperation | ReferenceObject;
  post?: OpenApiOperation | ReferenceObject;
  put?: OpenApiOperation | ReferenceObject;
  patch?: OpenApiOperation | ReferenceObject;
  delete?: OpenApiOperation | ReferenceObject;
  options?: OpenApiOperation | ReferenceObject;
  head?: OpenApiOperation | ReferenceObject;
}

export interface OpenApiComponents {
  schemas?: Record<string, OpenApiSchema | ReferenceObject>;
  parameters?: Record<string, OpenApiParameter | ReferenceObject>;
  requestBodies?: Record<string, OpenApiRequestBody | ReferenceObject>;
  responses?: Record<string, OpenApiResponse | ReferenceObject>;
}

export interface OpenApiDocument {
  openapi: string;
  info: OpenApiInfo;
  servers?: OpenApiServer[];
  paths: Record<string, OpenApiPathItem>;
  components?: OpenApiComponents;
}

export function isReferenceObject(value: unknown): value is ReferenceObject {
  return (
    typeof value === "object" &&
    value !== null &&
    "$ref" in value &&
    typeof (value as { $ref: unknown }).$ref === "string"
  );
}

