import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";

const field = (id, type = "text") => ({
  id, name: id, type, required: false, unique: false, options: [],
});

test("DeepSeek AI tasks use JSON mode and keep validated results in review", async t => {
  const store = createStore(":memory:");
  t.after(() => store.close());
  const source = store.createForm({ name: "Documents", fields: [field("text")] });
  const output = store.createForm({ name: "Extracted", fields: [field("code"), field("qty", "number")] });
  const { record } = store.createRecord(source.id, {
    schemaVersion: source.version, values: { text: "Invoice A: 3 units" },
  });
  const task = store.tasks.save({
    name: "Extract items", formId: source.id, inputFields: ["text"], instructions: "Extract the code and quantity.",
    outputFormId: output.id, outputFields: ["code", "qty"], action: "create", mode: "review",
  });
  let request;
  store.tasks.configure({
    aiConfig: { credentials: () => ({
      providerName: "deepseek", apiKey: "test-secret-key", baseUrl: "https://api.deepseek.com",
      model: "deepseek-flash",
    }) },
    fetchImpl: async (url, options) => {
      request = { url, body: JSON.parse(options.body) };
      return Response.json({ choices: [{
        finish_reason: "stop", message: { content: JSON.stringify({ items: [{ code: "A", qty: 3 }] }) },
      }] });
    },
  });

  const result = await store.tasks.process(store.tasks.enqueue(task.id, { recordId: record.id }).id);

  assert.equal(result.status, "Needs review");
  assert.equal(request.url, "https://api.deepseek.com/chat/completions");
  assert.deepEqual(request.body.response_format, { type: "json_object" });
  assert.equal(request.body.max_tokens, 8192);
  const schema = JSON.parse(request.body.messages[0].content.split("Required JSON Schema:\n")[1]);
  assert.equal(schema.properties.items.items.additionalProperties, false);
  assert.equal(schema.properties.items.items.properties.qty.type[0], "number");
  assert.equal(store.listRecords(output.id).length, 0);
  assert.ok(!JSON.stringify(result).includes("test-secret-key"));
});
