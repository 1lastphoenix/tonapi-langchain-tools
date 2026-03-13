import { DynamicStructuredTool } from "@langchain/core/tools";

import { OpenApiReferenceResolver } from "../openapi/ref-resolver.js";
import { OpenApiSchemaToZodConverter } from "../openapi/schema-to-zod.js";
import {
  DEFAULT_TONAPI_OPENAPI_URL,
  loadOpenApiDocument,
  type OpenApiSource
} from "../openapi/spec-loader.js";
import {
  buildOperationInputDefinition,
  extractOperations,
  type OperationInputDefinition,
  type ResolvedOperation
} from "../openapi/operations.js";
import type { HttpMethod, OpenApiDocument } from "../openapi/types.js";
import {
  TonApiClient,
  type TonApiClientConfig,
  type TonApiRequester,
  type TonApiRequest,
  type TonApiResponse
} from "../http/ton-api-client.js";

export type TonApiToolOutputFormat = "json-string" | "raw";
export type TonApiToolkitPreset = "safe-readonly";

export interface TonApiOperationFilter {
  preset?: TonApiToolkitPreset;
  includeOperationIds?: string[];
  excludeOperationIds?: string[];
  includeTags?: string[];
  excludeTags?: string[];
  includeMethods?: HttpMethod[];
  includeDeprecated?: boolean;
}

export interface TonApiToolkitOptions extends TonApiOperationFilter {
  openApi?: OpenApiDocument;
  openApiSource?: OpenApiSource;
  openApiFetch?: typeof globalThis.fetch;
  client?: TonApiRequester;
  clientConfig?: TonApiClientConfig;
  toolNamePrefix?: string;
  outputFormat?: TonApiToolOutputFormat;
}

interface TonApiToolFactoryInit {
  openApi: OpenApiDocument;
  client: TonApiRequester;
  toolNamePrefix: string;
  outputFormat: TonApiToolOutputFormat;
}

const SAFE_READONLY_FILTER: Readonly<Omit<TonApiOperationFilter, "preset">> = {
  includeMethods: ["get", "head", "options"],
  includeDeprecated: false
};

export class TonApiToolFactory {
  private readonly client: TonApiRequester;
  private readonly toolNamePrefix: string;
  private readonly outputFormat: TonApiToolOutputFormat;
  private readonly operationsById: Map<string, ResolvedOperation>;
  private readonly inputDefinitionsByOperationId: Map<string, OperationInputDefinition>;
  private readonly toolNameByOperationId: Map<string, string>;

  private constructor(init: TonApiToolFactoryInit) {
    this.client = init.client;
    this.toolNamePrefix = init.toolNamePrefix;
    this.outputFormat = init.outputFormat;

    const resolver = new OpenApiReferenceResolver(init.openApi);
    const converter = new OpenApiSchemaToZodConverter(resolver);
    const operations = extractOperations(init.openApi, resolver);

    this.operationsById = new Map<string, ResolvedOperation>();
    this.inputDefinitionsByOperationId = new Map<string, OperationInputDefinition>();
    this.toolNameByOperationId = new Map<string, string>();

    const usedToolNames = new Set<string>();
    for (const operation of operations) {
      this.operationsById.set(operation.operationId, operation);
      this.inputDefinitionsByOperationId.set(
        operation.operationId,
        buildOperationInputDefinition(operation, converter)
      );

      const defaultToolName = `${this.toolNamePrefix}${toSnakeCase(operation.operationId)}`;
      const uniqueToolName = ensureUniqueName(defaultToolName, usedToolNames);
      this.toolNameByOperationId.set(operation.operationId, uniqueToolName);
    }
  }

  public static async create(options: TonApiToolkitOptions = {}): Promise<TonApiToolFactory> {
    const openApiLoadOptions = options.openApiFetch ? { fetch: options.openApiFetch } : {};
    const openApi =
      options.openApi ??
      (await loadOpenApiDocument(options.openApiSource ?? DEFAULT_TONAPI_OPENAPI_URL, openApiLoadOptions));

    const client = options.client ?? new TonApiClient(options.clientConfig);
    return new TonApiToolFactory({
      openApi,
      client,
      toolNamePrefix: options.toolNamePrefix ?? "tonapi_",
      outputFormat: options.outputFormat ?? "json-string"
    });
  }

  public listOperationIds(filter: TonApiOperationFilter = {}): string[] {
    return this.getFilteredOperations(filter).map((operation) => operation.operationId);
  }

  public listSafeOperationIds(
    filter: Omit<TonApiOperationFilter, "preset"> = {}
  ): string[] {
    return this.listOperationIds({ ...filter, preset: "safe-readonly" });
  }

  public createTools(filter: TonApiOperationFilter = {}): DynamicStructuredTool[] {
    return this.getFilteredOperations(filter).map((operation) =>
      this.createToolForOperation(operation.operationId)
    );
  }

  public createSafeTools(
    filter: Omit<TonApiOperationFilter, "preset"> = {}
  ): DynamicStructuredTool[] {
    return this.createTools({ ...filter, preset: "safe-readonly" });
  }

  public createToolForOperation(operationId: string): DynamicStructuredTool {
    const operation = this.operationsById.get(operationId);
    if (!operation) {
      throw new Error(`Unknown TON API operationId "${operationId}".`);
    }

    const inputDefinition = this.inputDefinitionsByOperationId.get(operationId);
    if (!inputDefinition) {
      throw new Error(`Missing input schema for operationId "${operationId}".`);
    }

    const toolName = this.toolNameByOperationId.get(operationId) ?? operationId;
    const description = createToolDescription(operation);

    return new DynamicStructuredTool({
      name: toolName,
      description,
      schema: inputDefinition.schema,
      metadata: {
        operationId: operation.operationId,
        method: operation.method,
        path: operation.path,
        tags: operation.tags
      },
      func: async (input) => {
        const response = await this.invokeOperation(operation, inputDefinition, input);
        if (this.outputFormat === "raw") {
          return response.data;
        }
        return typeof response.data === "string"
          ? response.data
          : JSON.stringify(response.data, null, 2);
      }
    });
  }

  private getFilteredOperations(filter: TonApiOperationFilter): ResolvedOperation[] {
    const resolvedFilter = resolveTonApiOperationFilter(filter);
    const includeOperationIds = normalizeStringSet(resolvedFilter.includeOperationIds);
    const excludeOperationIds = normalizeStringSet(resolvedFilter.excludeOperationIds);
    const includeTags = normalizeStringSet(resolvedFilter.includeTags);
    const excludeTags = normalizeStringSet(resolvedFilter.excludeTags);
    const includeMethods = normalizeStringSet(resolvedFilter.includeMethods);
    const includeDeprecated = resolvedFilter.includeDeprecated ?? false;

    const operations = Array.from(this.operationsById.values());
    return operations.filter((operation) => {
      if (!includeDeprecated && operation.deprecated) {
        return false;
      }
      if (includeMethods.size > 0 && !includeMethods.has(operation.method)) {
        return false;
      }
      if (includeOperationIds.size > 0 && !includeOperationIds.has(operation.operationId)) {
        return false;
      }
      if (excludeOperationIds.has(operation.operationId)) {
        return false;
      }
      if (includeTags.size > 0) {
        const hasIncludedTag = operation.tags.some((tag) => includeTags.has(tag));
        if (!hasIncludedTag) {
          return false;
        }
      }
      if (excludeTags.size > 0) {
        const hasExcludedTag = operation.tags.some((tag) => excludeTags.has(tag));
        if (hasExcludedTag) {
          return false;
        }
      }
      return true;
    });
  }

  private async invokeOperation(
    operation: ResolvedOperation,
    inputDefinition: OperationInputDefinition,
    input: Record<string, unknown>
  ): Promise<TonApiResponse> {
    const query: Record<string, unknown> = {};
    const headers: Record<string, string> = {};
    let body: unknown;
    let path = operation.path;
    const cookieEntries: string[] = [];

    for (const field of inputDefinition.fields) {
      const value = input[field.inputKey];
      if (value === undefined) {
        continue;
      }

      switch (field.location) {
        case "path":
          path = injectPathParameter(path, field.parameterName, value, field.explode);
          break;
        case "query":
          query[field.parameterName] = serializeQueryValue(value, field.explode);
          break;
        case "header":
          headers[field.parameterName] = serializeScalar(value);
          break;
        case "cookie":
          cookieEntries.push(`${field.parameterName}=${encodeURIComponent(serializeScalar(value))}`);
          break;
        case "body":
          body = value;
          break;
      }
    }

    if (cookieEntries.length > 0) {
      headers.Cookie = cookieEntries.join("; ");
    }

    const request: TonApiRequest = {
      method: operation.method,
      path,
      query,
      headers
    };
    if (body !== undefined) {
      request.body = body;
    }
    if (inputDefinition.requestBodyContentType !== undefined) {
      request.contentType = inputDefinition.requestBodyContentType;
    }

    return this.client.request(request);
  }
}

export async function createTonApiTools(
  options: TonApiToolkitOptions = {}
): Promise<DynamicStructuredTool[]> {
  const factory = await TonApiToolFactory.create(options);
  return factory.createTools(options);
}

export async function createSafeTonApiTools(
  options: Omit<TonApiToolkitOptions, "preset"> = {}
): Promise<DynamicStructuredTool[]> {
  return createTonApiTools({ ...options, preset: "safe-readonly" });
}

export function getTonApiPresetFilter(
  preset: TonApiToolkitPreset
): Readonly<Omit<TonApiOperationFilter, "preset">> {
  switch (preset) {
    case "safe-readonly":
      return SAFE_READONLY_FILTER;
    default:
      throw new Error(`Unknown TON API preset "${String(preset)}".`);
  }
}

function createToolDescription(operation: ResolvedOperation): string {
  const summary = operation.summary ?? operation.description ?? "TON API operation";
  return `[${operation.method.toUpperCase()} ${operation.path}] ${summary}`;
}

function toSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase();
}

function ensureUniqueName(candidate: string, used: Set<string>): string {
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }

  let suffix = 2;
  let unique = `${candidate}_${suffix}`;
  while (used.has(unique)) {
    suffix += 1;
    unique = `${candidate}_${suffix}`;
  }
  used.add(unique);
  return unique;
}

function normalizeStringSet(values: readonly string[] | undefined): Set<string> {
  return new Set(values ?? []);
}

function injectPathParameter(
  pathTemplate: string,
  parameterName: string,
  value: unknown,
  explode: boolean | undefined
): string {
  const encoded = encodeURIComponent(serializePathValue(value, explode));
  return pathTemplate.replace(new RegExp(`\\{${escapeRegex(parameterName)}\\}`, "g"), encoded);
}

function serializePathValue(value: unknown, explode: boolean | undefined): string {
  if (Array.isArray(value)) {
    const separator = explode ? "," : ",";
    return value.map((item) => serializeScalar(item)).join(separator);
  }
  return serializeScalar(value);
}

function serializeQueryValue(value: unknown, explode: boolean | undefined): unknown {
  if (Array.isArray(value)) {
    if (explode === false) {
      return value.map((item) => serializeScalar(item)).join(",");
    }
    return value.map((item) => serializeScalar(item));
  }
  if (typeof value === "object" && value !== null) {
    return JSON.stringify(value);
  }
  return serializeScalar(value);
}

function serializeScalar(value: unknown): string {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "object" && value !== null) {
    return JSON.stringify(value);
  }
  return String(value);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveTonApiOperationFilter(
  filter: TonApiOperationFilter
): Omit<TonApiOperationFilter, "preset"> {
  const withoutPreset = omitPreset(filter);
  if (!filter.preset) {
    return withoutPreset;
  }

  const presetFilter = getTonApiPresetFilter(filter.preset);
  return mergeFilters(presetFilter, withoutPreset);
}

function omitPreset(filter: TonApiOperationFilter): Omit<TonApiOperationFilter, "preset"> {
  const result: Omit<TonApiOperationFilter, "preset"> = {};
  if (filter.includeOperationIds !== undefined) {
    result.includeOperationIds = filter.includeOperationIds;
  }
  if (filter.excludeOperationIds !== undefined) {
    result.excludeOperationIds = filter.excludeOperationIds;
  }
  if (filter.includeTags !== undefined) {
    result.includeTags = filter.includeTags;
  }
  if (filter.excludeTags !== undefined) {
    result.excludeTags = filter.excludeTags;
  }
  if (filter.includeMethods !== undefined) {
    result.includeMethods = filter.includeMethods;
  }
  if (filter.includeDeprecated !== undefined) {
    result.includeDeprecated = filter.includeDeprecated;
  }
  return result;
}

function mergeFilters(
  base: Omit<TonApiOperationFilter, "preset">,
  overlay: Omit<TonApiOperationFilter, "preset">
): Omit<TonApiOperationFilter, "preset"> {
  const merged: Omit<TonApiOperationFilter, "preset"> = {};

  const includeOperationIds = intersectOptionalArrays(
    base.includeOperationIds,
    overlay.includeOperationIds
  );
  if (includeOperationIds !== undefined) {
    merged.includeOperationIds = includeOperationIds;
  }

  const excludeOperationIds = unionOptionalArrays(
    base.excludeOperationIds,
    overlay.excludeOperationIds
  );
  if (excludeOperationIds !== undefined) {
    merged.excludeOperationIds = excludeOperationIds;
  }

  const includeTags = intersectOptionalArrays(base.includeTags, overlay.includeTags);
  if (includeTags !== undefined) {
    merged.includeTags = includeTags;
  }

  const excludeTags = unionOptionalArrays(base.excludeTags, overlay.excludeTags);
  if (excludeTags !== undefined) {
    merged.excludeTags = excludeTags;
  }

  const includeMethods = intersectOptionalArrays(base.includeMethods, overlay.includeMethods);
  if (includeMethods !== undefined) {
    merged.includeMethods = includeMethods;
  }

  const includeDeprecated = base.includeDeprecated ?? overlay.includeDeprecated;
  if (includeDeprecated !== undefined) {
    merged.includeDeprecated = includeDeprecated;
  }
  return merged;
}

function intersectOptionalArrays<T extends string>(
  left: readonly T[] | undefined,
  right: readonly T[] | undefined
): T[] | undefined {
  if (!left && !right) {
    return undefined;
  }
  if (!left) {
    return [...right!];
  }
  if (!right) {
    return [...left];
  }
  const rightSet = new Set(right);
  return left.filter((value) => rightSet.has(value));
}

function unionOptionalArrays<T extends string>(
  left: readonly T[] | undefined,
  right: readonly T[] | undefined
): T[] | undefined {
  if (!left && !right) {
    return undefined;
  }
  return Array.from(new Set([...(left ?? []), ...(right ?? [])]));
}
