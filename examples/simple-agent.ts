import { ChatOpenAI } from "@langchain/openai";
import { createAgent } from "langchain";

import { createSafeTonApiTools } from "../src/index.js";

const DEFAULT_TON_ADDRESS =
  "0:97264395BD65A255A429B11326C84128B7D70FFED7949ABAE3036D506BA38621";

async function main(): Promise<void> {
  const openAiApiKey = process.env.OPENAI_API_KEY;
  if (!openAiApiKey) {
    throw new Error("Missing OPENAI_API_KEY environment variable.");
  }

  const tonApiKey = process.env.TONAPI_API_KEY;
  if (!tonApiKey) {
    throw new Error("Missing TONAPI_API_KEY environment variable.");
  }

  const model = new ChatOpenAI({
    apiKey: openAiApiKey,
    model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
    temperature: 0
  });

  const tools = await createSafeTonApiTools({
    includeOperationIds: ["status", "addressParse"],
    clientConfig: {
      apiKey: tonApiKey
    }
  });

  if (tools.length === 0) {
    throw new Error("No tools were generated. Check OpenAPI loading and filters.");
  }

  const agent = createAgent({
    model,
    tools,
    systemPrompt:
      "You are a strict TON API assistant. Use tools for TON blockchain facts and return concise answers."
  });

  const cliPrompt = process.argv.slice(2).join(" ").trim();
  const address = process.env.TON_TEST_ADDRESS ?? DEFAULT_TON_ADDRESS;
  const prompt =
    cliPrompt ||
    [
      "Use tools to do both steps:",
      "1) Get TON API status.",
      `2) Parse this TON address: ${address}`,
      'Return compact JSON with keys: "status" and "parsed_address".'
    ].join("\n");

  console.log(`Model: ${process.env.OPENAI_MODEL ?? "gpt-4o-mini"}`);
  console.log(`Tools loaded: ${tools.map((tool) => tool.name).join(", ")}`);
  console.log("Running agent...\n");

  const result = await agent.invoke({
    messages: [{ role: "user", content: prompt }]
  });

  const messages = getMessages(result);
  const toolMessages = messages.filter((message) => getMessageType(message) === "tool");
  console.log(`Tool calls observed: ${toolMessages.length}`);
  for (const message of toolMessages) {
    const name = (message as { name?: unknown }).name;
    const preview = stringifyContent((message as { content?: unknown }).content).slice(0, 180);
    console.log(`- ${String(name ?? "tool")} => ${preview}`);
  }

  const finalMessage = messages[messages.length - 1] as { content?: unknown } | undefined;
  console.log("\nFinal response:");
  console.log(stringifyContent(finalMessage?.content));
}

function getMessages(value: unknown): unknown[] {
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const messages = (value as { messages?: unknown }).messages;
  return Array.isArray(messages) ? messages : [];
}

function getMessageType(message: unknown): string {
  if (typeof message !== "object" || message === null) {
    return "unknown";
  }
  const maybeGetType = message as {
    getType?: () => string;
    _getType?: () => string;
    type?: unknown;
  };
  if (typeof maybeGetType.getType === "function") {
    return maybeGetType.getType();
  }
  if (typeof maybeGetType._getType === "function") {
    return maybeGetType._getType();
  }
  return typeof maybeGetType.type === "string" ? maybeGetType.type : "unknown";
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (typeof item === "object" && item !== null && "text" in item) {
          const text = (item as { text?: unknown }).text;
          return typeof text === "string" ? text : JSON.stringify(item);
        }
        return JSON.stringify(item);
      })
      .join("\n");
  }
  if (content === undefined) {
    return "";
  }
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});

