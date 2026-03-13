import { z } from "zod";

import { OpenApiReferenceResolver } from "./ref-resolver.js";
import { OpenApiSchemaToZodConverter } from "./schema-to-zod.js";
import type {
  HttpMethod,
  OpenApiDocument,
  OpenApiOperation,
  OpenApiParameter,
  OpenApiRequestBody,
  ParameterLocation,
  ReferenceObject
} from "./types.js";
import { isReferenceObject } from "./types.js";

const SUPPORTED_HTTP_METHODS: HttpMethod[] = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "options",
  "head"
];

export interface ResolvedParameter extends OpenApiParameter {
  required: boolean;
}

export interface ResolvedOperation {
  operationId: string;
  method: HttpMethod;
  path: string;
  summary?: string;
  description?: string;
  tags: string[];
  deprecated: boolean;
  parameters: ResolvedParameter[];
  requestBody?: OpenApiRequestBody;
}

export interface OperationInputField {
  inputKey: string;
  location: ParameterLocation | "body";
  parameterName: string;
  required: boolean;
  explode?: boolean;
  style?: string;
}

export interface OperationInputDefinition {
  schema: z.ZodObject<Record<string, z.ZodTypeAny>>;
  fields: OperationInputField[];
  requestBodyContentType?: string;
}

export function extractOperations(
  document: OpenApiDocument,
  resolver: OpenApiReferenceResolver
): ResolvedOperation[] {
  const operations: ResolvedOperation[] = [];

  for (const [path, pathItem] of Object.entries(document.paths)) {
    const sharedParameters = resolveParameters(pathItem.parameters ?? [], resolver);

    for (const method of SUPPORTED_HTTP_METHODS) {
      const maybeOperation = pathItem[method];
      if (!maybeOperation) {
        continue;
      }

      const operation = resolver.resolve<OpenApiOperation>(maybeOperation);
      if (!operation) {
        continue;
      }

      const operationId = operation.operationId ?? createGeneratedOperationId(method, path);
      const operationParameters = resolveParameters(operation.parameters ?? [], resolver);
      const mergedParameters = mergeParameters(sharedParameters, operationParameters);

      const requestBody = resolver.resolve<OpenApiRequestBody>(operation.requestBody);
      const resolvedOperation: ResolvedOperation = {
        operationId,
        method,
        path,
        tags: operation.tags ?? [],
        deprecated: Boolean(operation.deprecated),
        parameters: mergedParameters
      };
      if (operation.summary !== undefined) {
        resolvedOperation.summary = operation.summary;
      }
      if (operation.description !== undefined) {
        resolvedOperation.description = operation.description;
      }
      if (requestBody !== undefined) {
        resolvedOperation.requestBody = requestBody;
      }
      operations.push(resolvedOperation);
    }
  }

  return operations.sort((left, right) => left.operationId.localeCompare(right.operationId));
}

export function buildOperationInputDefinition(
  operation: ResolvedOperation,
  converter: OpenApiSchemaToZodConverter
): OperationInputDefinition {
  const usedKeys = new Set<string>();
  const fields: OperationInputField[] = [];
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const parameter of operation.parameters) {
    const inputKey = createUniqueInputKey(parameter.name, parameter.in, usedKeys);
    let parameterSchema = converter.toZod(parameter.schema);
    if (!parameter.required) {
      parameterSchema = parameterSchema.optional();
    }
    shape[inputKey] = parameterSchema;
    const field: OperationInputField = {
      inputKey,
      location: parameter.in,
      parameterName: parameter.name,
      required: parameter.required
    };
    if (parameter.explode !== undefined) {
      field.explode = parameter.explode;
    }
    if (parameter.style !== undefined) {
      field.style = parameter.style;
    }
    fields.push(field);
  }

  let requestBodyContentType: string | undefined;
  const requestBodyContent = selectRequestBodyContent(operation.requestBody);
  if (requestBodyContent) {
    requestBodyContentType = requestBodyContent.contentType;
    let bodySchema = converter.toZod(requestBodyContent.schema);
    if (!operation.requestBody?.required) {
      bodySchema = bodySchema.optional();
    }
    shape.body = bodySchema;
    fields.push({
      inputKey: "body",
      location: "body",
      parameterName: "body",
      required: Boolean(operation.requestBody?.required)
    });
  }

  const definition: OperationInputDefinition = {
    schema: z.object(shape).strict(),
    fields
  };
  if (requestBodyContentType !== undefined) {
    definition.requestBodyContentType = requestBodyContentType;
  }
  return definition;
}

function resolveParameters(
  parameters: Array<OpenApiParameter | ReferenceObject>,
  resolver: OpenApiReferenceResolver
): ResolvedParameter[] {
  return parameters.map((parameter) => {
    const resolved = resolver.resolve<OpenApiParameter>(parameter);
    if (!resolved) {
      throw new Error("Failed to resolve OpenAPI parameter.");
    }
    return {
      ...resolved,
      required: Boolean(resolved.required || resolved.in === "path")
    };
  });
}

function mergeParameters(
  sharedParameters: ResolvedParameter[],
  operationParameters: ResolvedParameter[]
): ResolvedParameter[] {
  const merged = new Map<string, ResolvedParameter>();

  for (const parameter of sharedParameters) {
    merged.set(`${parameter.in}:${parameter.name}`, parameter);
  }
  for (const parameter of operationParameters) {
    merged.set(`${parameter.in}:${parameter.name}`, parameter);
  }

  return Array.from(merged.values());
}

function selectRequestBodyContent(
  requestBody: OpenApiRequestBody | undefined
): { contentType: string; schema: OpenApiRequestBody["content"][string]["schema"] } | undefined {
  if (!requestBody) {
    return undefined;
  }

  const entries = Object.entries(requestBody.content);
  if (entries.length === 0) {
    return undefined;
  }

  const exactJson = entries.find(([contentType]) => contentType === "application/json");
  if (exactJson) {
    return { contentType: exactJson[0], schema: exactJson[1].schema };
  }

  const suffixJson = entries.find(([contentType]) => contentType.endsWith("+json"));
  if (suffixJson) {
    return { contentType: suffixJson[0], schema: suffixJson[1].schema };
  }

  const firstEntry = entries[0];
  if (!firstEntry) {
    return undefined;
  }
  const [firstContentType, firstContent] = firstEntry;
  return {
    contentType: firstContentType,
    schema: firstContent.schema
  };
}

function createGeneratedOperationId(method: HttpMethod, path: string): string {
  const cleanPath = path
    .replace(/\{([^}]+)\}/g, "_$1_")
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  return `${method}_${cleanPath}`;
}

function createUniqueInputKey(
  parameterName: string,
  location: ParameterLocation,
  usedKeys: Set<string>
): string {
  const normalized = normalizeIdentifier(parameterName);
  let key = normalized;
  if (usedKeys.has(key)) {
    key = `${normalized}_${location}`;
  }
  let suffix = 1;
  while (usedKeys.has(key)) {
    suffix += 1;
    key = `${normalized}_${location}_${suffix}`;
  }
  usedKeys.add(key);
  return key;
}

function normalizeIdentifier(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_]+/g, "_").replace(/_+/g, "_");
  if (normalized.length === 0) {
    return "param";
  }
  return normalized.match(/^[0-9]/) ? `p_${normalized}` : normalized;
}

export function isOperationReference(
  operation: OpenApiOperation | ReferenceObject
): operation is ReferenceObject {
  return isReferenceObject(operation);
}
