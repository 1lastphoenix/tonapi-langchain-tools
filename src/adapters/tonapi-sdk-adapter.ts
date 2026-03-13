import { TonApiError } from "../errors.js";
import type { TonApiRequester, TonApiRequest, TonApiResponse } from "../http/ton-api-client.js";

type TonApiSdkResponseFormat = "arrayBuffer" | "json" | "text" | "blob" | "formData";

export interface TonApiSdkHttpRequest {
  path: string;
  method: string;
  query?: Record<string, unknown>;
  body?: unknown;
  type?: string;
  format?: TonApiSdkResponseFormat;
  headers?: HeadersInit;
  signal?: AbortSignal | null;
}

export interface TonApiSdkHttpClient {
  baseUrl?: string;
  request<TResponse = unknown>(request: TonApiSdkHttpRequest): Promise<TResponse>;
}

export interface TonApiSdkLikeClient {
  http: TonApiSdkHttpClient;
}

export interface TonApiSdkClientConfig {
  baseUrl?: string;
  apiKey?: string;
  baseApiParams?: Record<string, unknown>;
  fetch?: typeof globalThis.fetch;
}

export function createTonApiSdkAdapter(client: TonApiSdkLikeClient): TonApiRequester {
  return {
    request: async <TData = unknown>(request: TonApiRequest): Promise<TonApiResponse<TData>> => {
      const url = buildAbsoluteUrl(client.http.baseUrl, request.path, request.query);
      const sdkRequest = mapToSdkRequest(request);

      try {
        const raw = await client.http.request<ArrayBuffer | string | Uint8Array>(sdkRequest);
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          url,
          method: request.method,
          data: normalizeSdkPayload(raw) as TData,
          headers: new Headers()
        };
      } catch (error) {
        throw toTonApiError(error, request.method.toUpperCase(), url);
      }
    }
  };
}

export async function createTonApiSdkAdapterFromConfig(
  config: TonApiSdkClientConfig = {}
): Promise<TonApiRequester> {
  let tonApiModule: { TonApiClient: new (config?: unknown) => TonApiSdkLikeClient };
  try {
    tonApiModule = (await import("@ton-api/client")) as {
      TonApiClient: new (config?: unknown) => TonApiSdkLikeClient;
    };
  } catch {
    throw new Error(
      "The optional dependency \"@ton-api/client\" is not installed. Install it with `npm install @ton-api/client @ton/core`."
    );
  }

  const sdkClient = new tonApiModule.TonApiClient(config);
  return createTonApiSdkAdapter(sdkClient);
}

function mapToSdkRequest(request: TonApiRequest): TonApiSdkHttpRequest {
  const sdkRequest: TonApiSdkHttpRequest = {
    path: request.path,
    method: request.method.toUpperCase(),
    format: "arrayBuffer"
  };
  if (request.query) {
    sdkRequest.query = request.query;
  }
  if (request.headers) {
    sdkRequest.headers = request.headers;
  }
  if (request.signal) {
    sdkRequest.signal = request.signal;
  }
  if (request.body !== undefined) {
    sdkRequest.body = request.body;
  }

  const contentType = mapContentType(request.contentType);
  if (contentType !== undefined) {
    sdkRequest.type = contentType;
  }
  return sdkRequest;
}

function mapContentType(contentType: string | undefined): string | undefined {
  if (!contentType) {
    return undefined;
  }
  const normalized = contentType.toLowerCase();
  if (normalized.includes("application/json")) {
    return "application/json";
  }
  if (normalized.includes("multipart/form-data")) {
    return "multipart/form-data";
  }
  if (normalized.includes("application/x-www-form-urlencoded")) {
    return "application/x-www-form-urlencoded";
  }
  if (normalized.includes("text/plain")) {
    return "text/plain";
  }
  return contentType;
}

function normalizeSdkPayload(payload: unknown): unknown {
  if (payload instanceof ArrayBuffer) {
    return decodeBytes(new Uint8Array(payload));
  }
  if (ArrayBuffer.isView(payload)) {
    return decodeBytes(
      new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength)
    );
  }
  if (typeof payload === "string") {
    return parseJsonOrString(payload);
  }
  return payload;
}

function decodeBytes(bytes: Uint8Array): unknown {
  const text = new TextDecoder().decode(bytes);
  const parsed = tryParseJson(text);
  if (parsed.parsed) {
    return parsed.value;
  }
  if (isMostlyText(text)) {
    return text;
  }
  return toBase64(bytes);
}

function parseJsonOrString(value: string): unknown {
  const parsed = tryParseJson(value);
  if (parsed.parsed) {
    return parsed.value;
  }
  return value;
}

function tryParseJson(value: string): { parsed: true; value: unknown } | { parsed: false } {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[") && trimmed !== "null") {
    return { parsed: false };
  }
  try {
    return { parsed: true, value: JSON.parse(trimmed) };
  } catch {
    return { parsed: false };
  }
}

function isMostlyText(value: string): boolean {
  if (value.length === 0) {
    return true;
  }
  let controlCharacters = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      controlCharacters += 1;
    }
  }
  return controlCharacters / value.length < 0.02;
}

function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function buildAbsoluteUrl(
  baseUrl: string | undefined,
  path: string,
  query: Record<string, unknown> | undefined
): string {
  const url = new URL(path, normalizeBaseUrl(baseUrl ?? "https://tonapi.io"));
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) {
        continue;
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          url.searchParams.append(key, stringifyQueryValue(item));
        }
      } else {
        url.searchParams.append(key, stringifyQueryValue(value));
      }
    }
  }
  return url.toString();
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

function stringifyQueryValue(value: unknown): string {
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

function toTonApiError(error: unknown, method: string, url: string): TonApiError {
  if (isStatusLikeError(error)) {
    const responseBody = "error" in error ? error.error : undefined;
    return new TonApiError(`TON API SDK request failed (${error.status} ${error.statusText})`, {
      method,
      url,
      status: error.status,
      statusText: error.statusText,
      responseBody
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new TonApiError(`TON API SDK request failed: ${message}`, {
    method,
    url,
    status: 0,
    statusText: "SDK_ERROR"
  });
}

function isStatusLikeError(
  error: unknown
): error is { status: number; statusText: string; error?: unknown } {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  return (
    "status" in error &&
    typeof (error as { status: unknown }).status === "number" &&
    "statusText" in error &&
    typeof (error as { statusText: unknown }).statusText === "string"
  );
}

