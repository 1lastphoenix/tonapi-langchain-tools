import assert from "node:assert/strict";
import test from "node:test";

import {
  createSafeTonApiTools,
  createTonApiSdkAdapter,
  createTonApiTools,
  TonApiToolFactory
} from "../src/index.js";
import type { OpenApiDocument } from "../src/openapi/types.js";

const OPEN_API_FIXTURE: OpenApiDocument = {
  openapi: "3.0.0",
  info: {
    title: "Fixture",
    version: "1.0.0"
  },
  paths: {
    "/v2/accounts/{account_id}": {
      get: {
        operationId: "getAccount",
        tags: ["Accounts"],
        summary: "Get account",
        parameters: [
          {
            name: "account_id",
            in: "path",
            required: true,
            schema: { type: "string" }
          },
          {
            name: "currency",
            in: "query",
            schema: { type: "string" }
          },
          {
            name: "tags",
            in: "query",
            explode: true,
            schema: {
              type: "array",
              items: { type: "string" }
            }
          },
          {
            name: "ids",
            in: "query",
            explode: false,
            schema: {
              type: "array",
              items: { type: "string" }
            }
          }
        ],
        responses: {
          "200": {
            description: "ok"
          }
        }
      }
    },
    "/v2/blockchain/message": {
      post: {
        operationId: "sendBlockchainMessage",
        tags: ["Blockchain"],
        summary: "Send BOC message",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["boc"],
                properties: {
                  boc: { type: "string" }
                }
              }
            }
          }
        },
        responses: {
          "200": {
            description: "sent"
          }
        }
      }
    }
  }
};

test("TonApiToolFactory creates filtered tool sets", async () => {
  const { fetchFn } = createMockFetch();
  const factory = await TonApiToolFactory.create({
    openApi: OPEN_API_FIXTURE,
    clientConfig: {
      fetch: fetchFn
    }
  });

  const operationIds = factory.listOperationIds({ includeMethods: ["post"] });
  assert.deepEqual(operationIds, ["sendBlockchainMessage"]);

  const tools = factory.createTools({ includeTags: ["Accounts"] });
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["tonapi_get_account"]
  );
});

test("safe-readonly preset excludes mutating endpoints", async () => {
  const { fetchFn } = createMockFetch();

  const tools = await createSafeTonApiTools({
    openApi: OPEN_API_FIXTURE,
    clientConfig: {
      fetch: fetchFn
    }
  });

  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["tonapi_get_account"]
  );
});

test("TonApiToolFactory serializes path and query parameters correctly", async () => {
  const { fetchFn, calls } = createMockFetch();

  const tools = await createTonApiTools({
    openApi: OPEN_API_FIXTURE,
    clientConfig: {
      baseUrl: "https://tonapi.io",
      apiKey: "secret",
      fetch: fetchFn
    }
  });

  const getAccountTool = tools.find((tool) => tool.name === "tonapi_get_account");
  assert.ok(getAccountTool);

  const result = await getAccountTool.invoke({
    account_id: "0:abc",
    currency: "usd",
    tags: ["hot", "cold"],
    ids: ["1", "2"]
  });

  assert.equal(typeof result, "string");
  assert.equal(calls.length, 1);

  const firstCall = calls[0];
  assert.ok(firstCall);
  const url = new URL(firstCall.url);
  assert.equal(url.pathname, "/v2/accounts/0%3Aabc");
  assert.equal(url.searchParams.get("currency"), "usd");
  assert.deepEqual(url.searchParams.getAll("tags"), ["hot", "cold"]);
  assert.equal(url.searchParams.get("ids"), "1,2");

  const headers = new Headers(firstCall.init?.headers);
  assert.equal(headers.get("Authorization"), "Bearer secret");
  assert.equal(firstCall.init?.method, "GET");
});

test("TonApiToolFactory serializes request body payloads", async () => {
  const { fetchFn, calls } = createMockFetch();

  const factory = await TonApiToolFactory.create({
    openApi: OPEN_API_FIXTURE,
    clientConfig: {
      fetch: fetchFn
    }
  });

  const postTool = factory.createToolForOperation("sendBlockchainMessage");
  await postTool.invoke({
    body: {
      boc: "te6ccgEBAQEAAgAAAA=="
    }
  });

  assert.equal(calls.length, 1);
  const firstCall = calls[0];
  assert.ok(firstCall);
  assert.equal(firstCall.init?.method, "POST");
  assert.equal(firstCall.init?.body, '{"boc":"te6ccgEBAQEAAgAAAA=="}');
  const headers = new Headers(firstCall.init?.headers);
  assert.equal(headers.get("Content-Type"), "application/json");
});

test("TonApi SDK adapter integrates with the tool factory", async () => {
  const calls: TonApiSdkHttpRequestCall[] = [];
  const sdkClient = createMockSdkClient(calls);

  const factory = await TonApiToolFactory.create({
    openApi: OPEN_API_FIXTURE,
    client: createTonApiSdkAdapter(sdkClient)
  });

  const getAccountTool = factory.createToolForOperation("getAccount");
  const result = await getAccountTool.invoke({
    account_id: "0:abc"
  });

  assert.equal(typeof result, "string");
  const parsed = JSON.parse(result);
  assert.deepEqual(parsed, { ok: true, mode: "sdk-adapter" });

  assert.equal(calls.length, 1);
  const firstCall = calls[0];
  assert.ok(firstCall);
  assert.equal(firstCall.request.method, "GET");
  assert.equal(firstCall.request.path, "/v2/accounts/0%3Aabc");
  assert.equal(firstCall.request.format, "arrayBuffer");
});

function createMockFetch(): {
  fetchFn: typeof globalThis.fetch;
  calls: Array<{ url: string; init: RequestInit | undefined }>;
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];

  const fetchFn: typeof globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  return { fetchFn, calls };
}

interface TonApiSdkHttpRequestCall {
  request: {
    path: string;
    method: string;
    query?: Record<string, unknown>;
    body?: unknown;
    type?: string;
    format?: "arrayBuffer" | "json" | "text" | "blob" | "formData";
    headers?: HeadersInit;
    signal?: AbortSignal | null;
  };
}

function createMockSdkClient(calls: TonApiSdkHttpRequestCall[]): {
  http: {
    baseUrl?: string;
    request: <TResponse = unknown>(
      request: TonApiSdkHttpRequestCall["request"]
    ) => Promise<TResponse>;
  };
} {
  return {
    http: {
      baseUrl: "https://tonapi.io",
      request: async <TResponse = unknown>(request: TonApiSdkHttpRequestCall["request"]) => {
        calls.push({ request });
        const encoder = new TextEncoder();
        const payload = JSON.stringify({ ok: true, mode: "sdk-adapter" });
        return encoder.encode(payload).buffer as TResponse;
      }
    }
  };
}
