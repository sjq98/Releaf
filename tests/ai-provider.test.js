import test from "node:test";
import assert from "node:assert/strict";
import { isDeepSeek, jsonOutputInstruction, structuredResponseFormat } from "../src/ai-provider.js";

const schema = {
  type: "object", additionalProperties: false, required: ["items"],
  properties: { items: { type: "array", maxItems: 50, items: { type: "string" } } },
};

test("DeepSeek detection supports official endpoints and explicitly named gateways", () => {
  for (const config of [
    { baseUrl: "https://api.deepseek.com" },
    { baseUrl: "https://api.deepseek.com/v1" },
    { providerName: "DeepSeek", baseUrl: "https://gateway.example/v1" },
  ]) assert.equal(isDeepSeek(config), true);
  for (const config of [
    {}, { baseUrl: "not a URL" }, { providerName: "OpenAI", baseUrl: "https://api.openai.com/v1" },
    { baseUrl: "https://api.deepseek.com.example/v1" }, { baseUrl: "https://gateway.example/deepseek.com" },
  ]) assert.equal(isDeepSeek(config), false);
});

test("JSON object mode carries the full schema in trusted system instructions", () => {
  const config = { baseUrl: "https://api.deepseek.com/v1" };
  assert.deepEqual(structuredResponseFormat(config, "tasks", schema), { type: "json_object" });
  const instruction = jsonOutputInstruction(config, schema);
  assert.match(instruction, /valid JSON object only/);
  assert.deepEqual(JSON.parse(instruction.split("Required JSON Schema:\n")[1]), schema);
});

test("other providers keep strict schema output without additional provider options", () => {
  const config = { providerName: "Custom", baseUrl: "https://provider.example/v1" };
  assert.deepEqual(structuredResponseFormat(config, "tasks", schema), {
    type: "json_schema", json_schema: { name: "tasks", strict: true, schema },
  });
  assert.equal(jsonOutputInstruction(config, schema), "");
});
