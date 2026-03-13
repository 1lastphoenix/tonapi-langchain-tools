# tonapi-langchain-tools

OpenAPI-driven LangChain tools for TON API (`tonapi.io`) in TypeScript.

This package converts TON API operations from the official OpenAPI spec into strongly typed LangChain `DynamicStructuredTool` instances using Zod input schemas.

## Install

```bash
npm install tonapi-langchain-tools @langchain/core zod
```

Optional SDK adapter:

```bash
npm install @ton-api/client @ton/core
```

## Quick Start

```ts
import { createTonApiTools } from "tonapi-langchain-tools";

const tools = await createTonApiTools({
  clientConfig: {
    apiKey: process.env.TONAPI_API_KEY
  },
  includeTags: ["Accounts", "Blockchain"],
  includeMethods: ["get"]
});

// tools can now be passed directly to your LangChain agent
```

## Safe Preset (Read-Only)

Use the curated safe preset to expose only read-only endpoints.

```ts
import { createSafeTonApiTools } from "tonapi-langchain-tools";

const tools = await createSafeTonApiTools({
  clientConfig: {
    apiKey: process.env.TONAPI_API_KEY
  }
});
```

Or apply it with the regular factory:

```ts
const tools = await createTonApiTools({
  preset: "safe-readonly",
  clientConfig: {
    apiKey: process.env.TONAPI_API_KEY
  }
});
```

## Create One Tool By Operation ID

```ts
import { TonApiToolFactory } from "tonapi-langchain-tools";

const factory = await TonApiToolFactory.create({
  clientConfig: {
    apiKey: process.env.TONAPI_API_KEY
  }
});

const getAccountTool = factory.createToolForOperation("getAccount");
const result = await getAccountTool.invoke({
  account_id: "0:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
});
```

## Filtering Controls

- `preset`: `"safe-readonly"` (GET/HEAD/OPTIONS only)
- `includeOperationIds`: only include exact operation IDs
- `excludeOperationIds`: remove exact operation IDs
- `includeTags`: keep operations that have at least one listed tag
- `excludeTags`: remove operations that have any listed tag
- `includeMethods`: include only specific HTTP methods
- `includeDeprecated`: include deprecated operations (`false` by default)

## Output Modes

- `"json-string"` (default): tool returns pretty JSON string
- `"raw"`: tool returns raw parsed response payload

## `@ton-api/client` Adapter

If you already use the official SDK, you can plug it in without using the built-in HTTP client.

```ts
import { TonApiClient as TonApiSdkClient } from "@ton-api/client";
import {
  createTonApiSdkAdapter,
  createTonApiTools
} from "tonapi-langchain-tools";

const sdkClient = new TonApiSdkClient({
  baseUrl: "https://tonapi.io",
  apiKey: process.env.TONAPI_API_KEY
});

const tools = await createTonApiTools({
  client: createTonApiSdkAdapter(sdkClient),
  preset: "safe-readonly"
});
```

You can also instantiate the SDK lazily via dynamic import:

```ts
import {
  createTonApiSdkAdapterFromConfig,
  createTonApiTools
} from "tonapi-langchain-tools";

const client = await createTonApiSdkAdapterFromConfig({
  baseUrl: "https://tonapi.io",
  apiKey: process.env.TONAPI_API_KEY
});

const tools = await createTonApiTools({ client });
```

## Architecture

- `TonApiClient`: HTTP transport, auth, timeout, JSON/binary response parsing
- `createTonApiSdkAdapter`: adapter for `@ton-api/client`
- `OpenApiReferenceResolver`: resolves local `$ref` pointers
- `OpenApiSchemaToZodConverter`: maps OpenAPI schemas into Zod schemas
- `TonApiToolFactory`: turns OpenAPI operations into LangChain tools

## Build and Test

```bash
npm run typecheck
npm run test
npm run build
```

## Notes

- Default OpenAPI source: `https://tonapi.io/v2/openapi.yml`
- Default TON API base URL: `https://tonapi.io`
- Default auth header: `Authorization: Bearer <API_KEY>`
