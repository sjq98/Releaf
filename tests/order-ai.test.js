import test from "node:test";
import assert from "node:assert/strict";
import { createOrderAI, validateOrderExtraction } from "../src/order-ai.js";

const input = {
  text: "I'm Lee. Please deliver 2 portions of Chicken rice, one without chilli, and 1 cup of Tea. Tomorrow at 12. Total RM20.20.",
};
const extraction = () => ({
  isOrder: true, orderEvidence: "Please deliver 2 portions of Chicken rice",
  customerName: "Lee", customerPhone: null, fulfillment: "delivery", deliveryAddress: null,
  requestedTime: "Tomorrow at 12", notes: null,
  items: [
    { productName: "Chicken rice", quantity: 1, unit: "portion", notes: "without chilli",
      evidence: "2 portions of Chicken rice, one without chilli" },
    { productName: "Chicken rice", quantity: 1, unit: "portion", notes: null,
      evidence: "2 portions of Chicken rice, one without chilli" },
    { productName: "Tea", quantity: 1, unit: "cup", notes: null, evidence: "1 cup of Tea" },
  ],
});
const completion = output => Response.json({
  choices: [{ finish_reason: "stop", message: { content: JSON.stringify(output) } }],
});
const configured = { credentials: () => ({ apiKey: "test-secret", model: "order-model", baseUrl: "https://provider.invalid/v1/" }) };
const deepSeekConfigured = { credentials: () => ({ providerName: "deepseek", apiKey: "test-secret", model: "deepseek-flash", baseUrl: "https://api.deepseek.com" }) };
const badOutput = output => assert.throws(() => validateOrderExtraction(output, input), { status: 502 });

test("extraction preserves split preparation requests in notes without catalog or price lookup", () => {
  const result = validateOrderExtraction(extraction(), input);
  assert.equal(result.customerName, "Lee");
  assert.equal(result.fulfillment, "delivery");
  assert.equal(result.requestedTime, "Tomorrow at 12");
  assert.equal(result.totalAmount, null);
  assert.equal(result.isOrder, true);
  assert.equal(result.notes, "Chicken rice x 1 portion (without chilli)\nChicken rice x 1 portion\nTea x 1 cup");
  assert.deepEqual(result.issues.map(issue => issue.code), ["manual_amount", "missing_address"]);
  for (const key of ["items", "catalog", "amountEvidence", "unitPrice", "productId"]) assert.equal(result[key], undefined);
});

test("manual amount and missing fulfillment details remain unresolved instead of acquiring defaults", () => {
  const result = validateOrderExtraction({
    ...extraction(), customerName: null, fulfillment: null,
  }, input);
  assert.equal(result.totalAmount, null);
  assert.equal(result.fulfillment, null);
  assert.deepEqual(result.issues.map(issue => issue.code), ["manual_amount", "missing_customer", "missing_fulfillment"]);
  const empty = validateOrderExtraction({
    isOrder: false, orderEvidence: null,
    customerName: null, customerPhone: null, fulfillment: null, deliveryAddress: null,
    requestedTime: null, notes: null, items: [],
  }, { text: "Hello there!" });
  assert.equal(empty.notes, null);
  assert.equal(empty.totalAmount, null);
  assert.equal(empty.isOrder, false);
});

test("AI cannot supply an order amount even when a total appears in customer text", () => {
  for (const totalAmount of [0, null, 20.2, -1, Infinity, "20.2", 20.201]) badOutput({ ...extraction(), totalAmount });
  badOutput({ ...extraction(), amountEvidence: "Total RM20.20" });
  assert.equal(validateOrderExtraction(extraction(), input).totalAmount, null);
});

test("new orders require source evidence while non-order classifications cannot contain item requests", () => {
  badOutput({ ...extraction(), isOrder: "true" });
  badOutput({ ...extraction(), orderEvidence: null });
  badOutput({ ...extraction(), orderEvidence: "A made-up new order" });
  badOutput({ ...extraction(), isOrder: false });
  badOutput({ ...extraction(), isOrder: false, orderEvidence: null });
  const result = validateOrderExtraction({
    isOrder: false, orderEvidence: null, customerName: null, customerPhone: null, fulfillment: null,
    deliveryAddress: null, requestedTime: null, notes: "Customer reports payment", items: [],
  }, { text: "I paid RM40. Thanks!" });
  assert.equal(result.isOrder, false);
  assert.ok(result.issues.some(issue => issue.code === "not_an_order"));
});

test("malformed structures, unexpected pricing fields and fabricated evidence are rejected", () => {
  for (const change of [
    { status: "completed" }, { customerName: "" }, { fulfillment: "collection" }, { customerPhone: 123 },
    { items: {} }, { items: Array(101).fill(extraction().items[0]) },
  ]) badOutput({ ...extraction(), ...change });
  const missing = extraction(); delete missing.notes; badOutput(missing);
  for (const changes of [
    { unitPrice: 0.01 }, { productId: "invented" }, { productCode: "RICE" },
    { evidence: "Not present in the message" }, { evidence: " " }, { evidence: null },
    { productName: "" }, { notes: [] }, { quantity: 0 }, { quantity: -1 },
    { quantity: NaN }, { quantity: Infinity }, { quantity: "1" }, { quantity: 1e13 }, { quantity: 0.0000001 },
  ]) {
    const output = extraction(); Object.assign(output.items[0], changes); badOutput(output);
  }
});

test("provider receives a strict schema and customer text without inventory metadata", async () => {
  const calls = [];
  const ai = createOrderAI({ aiConfig: configured, fetchImpl: async (url, options) => {
    calls.push({ url, options }); return completion(extraction());
  } });
  await ai.extract(input);
  const { url, options } = calls[0], sent = JSON.parse(options.body);
  assert.equal(url, "https://provider.invalid/v1/chat/completions");
  assert.equal(options.headers.Authorization, "Bearer test-secret");
  assert.equal(options.redirect, "error");
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(sent.model, "order-model");
  assert.equal(sent.response_format.json_schema.strict, true);
  assert.equal(sent.response_format.json_schema.schema.additionalProperties, false);
  assert.deepEqual(JSON.parse(sent.messages[1].content), { customer_text: input.text });
  assert.match(sent.messages[0].content, /untrusted data/);
  assert.match(sent.messages[0].content, /separate lines/);
  assert.match(sent.messages[0].content, /Never extract or return totalAmount/);
  assert.equal(sent.response_format.json_schema.schema.properties.totalAmount, undefined);
});

test("DeepSeek uses its supported JSON object mode instead of JSON Schema mode", async () => {
  const calls = [];
  const ai = createOrderAI({ aiConfig: deepSeekConfigured, fetchImpl: async (url, options) => {
    calls.push({ url, options }); return completion(extraction());
  } });
  await ai.extract(input);
  const sent = JSON.parse(calls[0].options.body);
  assert.equal(calls[0].url, "https://api.deepseek.com/chat/completions");
  assert.deepEqual(sent.response_format, { type: "json_object" });
  assert.equal(sent.response_format.json_schema, undefined);
  assert.equal(sent.max_tokens, 8192);
  assert.match(sent.messages[0].content, /valid JSON object only/);
  const schema = JSON.parse(sent.messages[0].content.split("Required JSON Schema:\n")[1]);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, Object.keys(extraction()));
  assert.equal(schema.properties.items.items.properties.quantity.type, "number");
  assert.equal(schema.properties.totalAmount, undefined);
  assert.equal(calls.length, 1);
});

test("DeepSeek output still rejects invented evidence, unexpected amount fields and incomplete fields", async () => {
  const fabricated = extraction();
  fabricated.items[0].evidence = "An invented customer request";
  const missing = extraction();
  delete missing.items[0].quantity;
  for (const output of [fabricated, missing, { ...extraction(), totalAmount: 20.2 }, {}]) {
    const ai = createOrderAI({ aiConfig: deepSeekConfigured, fetchImpl: async () => completion(output) });
    await assert.rejects(ai.extract(input), { status: 502 });
  }
});

test("bad input and missing configuration fail before contacting a provider", async () => {
  let calls = 0;
  const ai = createOrderAI({ aiConfig: configured, fetchImpl: async () => { calls++; return completion(extraction()); } });
  for (const body of [null, { text: "" }, { text: 123 }, { text: "x".repeat(40001) }]) {
    await assert.rejects(ai.extract(body), { status: 400 });
  }
  const missing = createOrderAI({ aiConfig: { credentials: () => ({}) }, fetchImpl: async () => { calls++; } });
  await assert.rejects(missing.extract(input), { status: 503 });
  assert.equal(calls, 0);
});

test("refusal, truncation, tools, malformed output and provider errors are controlled failures", async () => {
  let response;
  const ai = createOrderAI({ aiConfig: configured, fetchImpl: async () => response });
  for (const value of [
    new Response("provider-secret-in-body", { status: 429 }),
    new Response("not json"),
    Response.json({ choices: [{ finish_reason: "length", message: { content: "{}" } }] }),
    Response.json({ choices: [{ finish_reason: "stop", message: { refusal: "No", content: "{}" } }] }),
    Response.json({ choices: [{ finish_reason: "stop", message: { tool_calls: [{}], content: "{}" } }] }),
    Response.json({ choices: [{ finish_reason: "stop", message: { content: "not json" } }] }),
    completion({}),
  ]) {
    response = value;
    await assert.rejects(ai.extract(input), error => error.status === 502 && !error.message.includes("provider-secret"));
  }
});

test("timeouts and network errors do not expose credentials", async () => {
  for (const reason of [new DOMException("secret", "TimeoutError"), new Error("Bearer test-secret")]) {
    const ai = createOrderAI({ aiConfig: configured, fetchImpl: async () => { throw reason; } });
    await assert.rejects(ai.extract(input), error => error.status === 502 && !/secret/.test(error.message));
  }
});

test("extraction never mutates supplied customer text or model data", () => {
  const localInput = structuredClone(input), original = structuredClone(localInput);
  const output = extraction(), originalOutput = structuredClone(output);
  validateOrderExtraction(output, localInput);
  assert.deepEqual(localInput, original);
  assert.deepEqual(output, originalOutput);
});
