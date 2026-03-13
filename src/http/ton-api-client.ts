import { TonApiError } from "../errors.js";
import type { HttpMethod } from "../openapi/types.js";

export interface TonApiClientConfig {
  baseUrl?: string;
  apiKey?: string;
  apiKeyHeader?: string;
  apiKeyPrefix?: string;
  defaultHeaders?: Record<string, string>;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export interface TonApiRequest {
  method: HttpMethod;
  path: string;
  query?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: unknown;
  contentType?: string;
  signal?: AbortSignal;
}

export interface TonApiResponse<TData = unknown> {
  ok: boolean;
  status: number;
  statusText: string;
  url: string;
  method: HttpMethod;
  data: TData;
  headers: Headers;
}

export interface TonApiRequester {
  request<TData = unknown>(request: TonApiRequest): Promise<TonApiResponse<TData>>;
}

const DEFAULT_BASE_URL = "https://tonapi.io";
const DEFAULT_TIMEOUT_MS = 20_000;

export class TonApiClient implements TonApiRequester {
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly apiKeyHeader: string;
  private readonly apiKeyPrefix: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly timeoutMs: number;

  public constructor(config: TonApiClientConfig = {}) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl ?? DEFAULT_BASE_URL);
    this.apiKey = config.apiKey;
    this.apiKeyHeader = config.apiKeyHeader ?? "Authorization";
    this.apiKeyPrefix = config.apiKeyPrefix ?? "Bearer ";
    this.defaultHeaders = { ...(config.defaultHeaders ?? {}) };
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const fetchImpl = config.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      throw new Error("No fetch implementation found. Pass one via TonApiClientConfig.fetch.");
    }
    this.fetchFn = fetchImpl;
  }

  public async request<TData = unknown>(request: TonApiRequest): Promise<TonApiResponse<TData>> {
    const url = new URL(request.path, this.baseUrl);
    appendQuery(url.searchParams, request.query);

    const headers = new Headers(this.defaultHeaders);
    for (const [key, value] of Object.entries(request.headers ?? {})) {
      headers.set(key, value);
    }
    if (this.apiKey && !headers.has(this.apiKeyHeader)) {
      headers.set(this.apiKeyHeader, `${this.apiKeyPrefix}${this.apiKey}`);
    }

    const hasBody = request.body !== undefined;
    let body: BodyInit | undefined;
    if (hasBody) {
      const contentType = request.contentType ?? "application/json";
      if (!headers.has("Content-Type")) {
        headers.set("Content-Type", contentType);
      }
      if (typeof request.body === "string" || isBodyInitLike(request.body)) {
        body = request.body as BodyInit;
      } else if (contentType.includes("json")) {
        body = JSON.stringify(request.body);
      } else {
        body = String(request.body);
      }
    }

    const signal = composeSignal(request.signal, this.timeoutMs);
    const init: RequestInit = {
      method: request.method.toUpperCase(),
      headers
    };
    if (body !== undefined) {
      init.body = body;
    }
    if (signal) {
      init.signal = signal;
    }

    let response: Response;
    try {
      response = await this.fetchFn(url, init);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new TonApiError(`TON API request failed: ${reason}`, {
        method: request.method.toUpperCase(),
        url: url.toString(),
        status: 0,
        statusText: "NETWORK_ERROR"
      });
    }

    const parsedBody = await parseResponseBody(response);
    if (!response.ok) {
      throw new TonApiError(
        `TON API request failed (${response.status} ${response.statusText})`,
        {
          method: request.method.toUpperCase(),
          url: url.toString(),
          status: response.status,
          statusText: response.statusText,
          responseBody: parsedBody
        }
      );
    }

    return {
      ok: true,
      status: response.status,
      statusText: response.statusText,
      url: url.toString(),
      method: request.method,
      data: parsedBody as TData,
      headers: response.headers
    };
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

function appendQuery(
  searchParams: URLSearchParams,
  query: Record<string, unknown> | undefined
): void {
  if (!query) {
    return;
  }

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        searchParams.append(key, stringifyValue(item));
      }
      continue;
    }
    searchParams.append(key, stringifyValue(value));
  }
}

function stringifyValue(value: unknown): string {
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

function composeSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal | undefined {
  if (timeoutMs <= 0) {
    return signal;
  }

  const timeoutController = new AbortController();
  const timeoutHandle = setTimeout(() => timeoutController.abort(), timeoutMs);

  if (signal) {
    if (signal.aborted) {
      timeoutController.abort(signal.reason);
    } else {
      signal.addEventListener(
        "abort",
        () => {
          timeoutController.abort(signal.reason);
        },
        { once: true }
      );
    }
  }

  timeoutController.signal.addEventListener(
    "abort",
    () => {
      clearTimeout(timeoutHandle);
    },
    { once: true }
  );

  return timeoutController.signal;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return null;
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  if (contentType.includes("text/") || contentType.includes("application/yaml")) {
    return response.text();
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  return Buffer.from(bytes).toString("base64");
}

function isBodyInitLike(value: unknown): boolean {
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return true;
  }
  if (typeof FormData !== "undefined" && value instanceof FormData) {
    return true;
  }
  if (value instanceof URLSearchParams) {
    return true;
  }
  if (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer) {
    return true;
  }
  return value instanceof Uint8Array;
}
