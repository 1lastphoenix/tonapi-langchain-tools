import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

import type { OpenApiDocument } from "./types.js";

export const DEFAULT_TONAPI_OPENAPI_URL = "https://tonapi.io/v2/openapi.yml";

export type OpenApiSource =
  | OpenApiDocument
  | string
  | URL
  | { url: string | URL }
  | { filePath: string }
  | { raw: string };

export interface OpenApiLoadOptions {
  fetch?: typeof globalThis.fetch;
}

export async function loadOpenApiDocument(
  source: OpenApiSource = DEFAULT_TONAPI_OPENAPI_URL,
  options: OpenApiLoadOptions = {}
): Promise<OpenApiDocument> {
  if (isOpenApiDocument(source)) {
    return source;
  }

  if (source instanceof URL) {
    return loadOpenApiFromUrl(source.toString(), options.fetch);
  }

  if (typeof source === "string") {
    if (isHttpUrl(source)) {
      return loadOpenApiFromUrl(source, options.fetch);
    }
    if (looksLikeRawSpec(source)) {
      return parseOpenApiDocument(source);
    }
    return loadOpenApiFromFile(source);
  }

  if ("url" in source) {
    return loadOpenApiFromUrl(source.url.toString(), options.fetch);
  }
  if ("filePath" in source) {
    return loadOpenApiFromFile(source.filePath);
  }
  if ("raw" in source) {
    return parseOpenApiDocument(source.raw);
  }

  throw new Error("Unsupported OpenAPI source.");
}

export async function loadOpenApiFromUrl(
  url: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch
): Promise<OpenApiDocument> {
  if (typeof fetchFn !== "function") {
    throw new Error("No fetch implementation found. Provide one in OpenApiLoadOptions.fetch.");
  }
  const response = await fetchFn(url);
  if (!response.ok) {
    throw new Error(
      `Failed to load OpenAPI document from ${url}: ${response.status} ${response.statusText}`
    );
  }
  const raw = await response.text();
  return parseOpenApiDocument(raw);
}

export async function loadOpenApiFromFile(filePath: string): Promise<OpenApiDocument> {
  const raw = await readFile(filePath, "utf8");
  return parseOpenApiDocument(raw);
}

export function parseOpenApiDocument(raw: string): OpenApiDocument {
  const trimmed = raw.trim();
  const document = trimmed.startsWith("{")
    ? (JSON.parse(trimmed) as unknown)
    : (parseYaml(trimmed) as unknown);
  if (!isOpenApiDocument(document)) {
    throw new Error("Invalid OpenAPI document. Missing required fields (openapi/info/paths).");
  }
  return document;
}

function isHttpUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

function looksLikeRawSpec(value: string): boolean {
  const trimmed = value.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("openapi:");
}

export function isOpenApiDocument(value: unknown): value is OpenApiDocument {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const maybeDoc = value as Partial<OpenApiDocument>;
  return (
    typeof maybeDoc.openapi === "string" &&
    typeof maybeDoc.info === "object" &&
    maybeDoc.info !== null &&
    typeof maybeDoc.paths === "object" &&
    maybeDoc.paths !== null
  );
}

