import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.js";
import { createStore } from "../src/store.js";
import { createAIConfig } from "../src/ai-config.js";
import { setupAdmin } from "./helpers/http-auth.js";

const SPACE = "meeting-tasks";
const summary = {
  spaceId: SPACE, title: "Weekly follow-up", date: "2026-10-24",
  text: "Alex will check the stock by 2026-10-26.\nPriya will send the report. Budget is still under discussion.",
};
const actions = () => ({ items: [
  { values: { task: "Check the stock", owner: "Alex", dueDate: "2026-10-26", status: "Open", acceptance: null }, evidence: "Alex will check the stock by 2026-10-26." },
  { values: { task: "Send the report", owner: "Priya", dueDate: null, status: null, acceptance: null }, evidence: "Priya will send the report." },
] });
const completion = output => new Response(JSON.stringify({
  choices: [{ finish_reason: "stop", message: { content: JSON.stringify(output) } }],
}), { headers: { "Content-Type": "application/json" } });

async function fixture(t, provider = () => completion(actions()), env) {
  const calls = [];
  const app = createApp({
    database: ":memory:",
    env: env ?? { AI_API_KEY: "test-meeting-secret", AI_MODEL: "meeting-model", AI_BASE_URL: "https://provider.invalid/v1" },
    aiFetch: async (url, options) => { calls.push({ url, options }); return provider(url, options); },
  });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); app.store.close(); });
  const base = `http://127.0.0.1:${app.server.address().port}`, admin = await setupAdmin(base);
  const request = (path, { method = "GET", body, cookie = admin.cookie, key, headers = {} } = {}) => fetch(base + path, {
    method, headers: {
      ...(cookie ? { Cookie: cookie } : {}), ...(body ? { "Content-Type": "application/json" } : {}),
      ...(key ? { "Idempotency-Key": key } : {}), ...headers,
    }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { ...app, request, admin, calls, form: app.store.bootstrap(null, SPACE).form };
}
const importSummary = (request, body = summary, key) => request("/api/meeting-tasks/imports", { method: "POST", body, key });

test("app provisions a separate Meeting Tasks Space and task table without moving inventory forms", async t => {
  const { request, form, store } = await fixture(t);
  const boot = await (await request(`/api/bootstrap?spaceId=${SPACE}`)).json();
  assert.deepEqual(new Set(boot.spaces.map(space => space.id)), new Set(["default", SPACE, "order-management"]));
  assert.equal(boot.space.name, "Meeting Tasks");
  assert.equal(boot.form.name, "Tasks");
  assert.equal(boot.meetingTasks.formId, form.id);
  assert.equal(boot.navigation.length, 1);
  assert.equal(boot.navigation[0].formId, form.id);
  assert.equal(store.bootstrap().form.name, "New form");
  assert.equal(store.bootstrap().meetingTasks.enabled, false);
  assert.deepEqual(form.fields.map(field => field.id), ["task", "owner", "dueDate", "status", "acceptance", "meetingTitle", "meetingDate", "sourceQuote"]);
  assert.equal((await request("/meeting-tasks.js")).status, 200);
  assert.equal((await request("/meeting-tasks.css")).status, 200);
  assert.equal((await request("/src/meeting-tasks.js")).status, 404);
});

test("one import creates validated task records, source context, ordinary activity and persistent history", async t => {
  const { request, form, store, calls } = await fixture(t);
  const response = await importSummary(request);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.duplicate, false);
  assert.equal(result.items.length, 2);
  assert.equal(store.listRecords(form.id).length, 2);
  for (const item of result.items) {
    const record = store.getRecord(item.recordId);
    assert.equal(record.formId, form.id);
    assert.equal(record.values.task, item.values.task);
    assert.equal(record.values.status, "Open");
    assert.equal(record.values.meetingTitle, summary.title);
    assert.equal(record.values.meetingDate, summary.date);
    assert.equal(record.values.sourceQuote, item.evidence);
  }
  assert.equal(store.listChanges(form.id).length, 2);
  const history = await (await request(`/api/meeting-tasks/imports?spaceId=${SPACE}`)).json();
  assert.equal(history.length, 1);
  assert.equal(history[0].count, 2);
  const detail = await (await request(`/api/meeting-tasks/imports/${result.id}?spaceId=${SPACE}`)).json();
  assert.equal(detail.text, summary.text);
  assert.deepEqual(detail.items, result.items);
  assert.doesNotMatch(JSON.stringify(detail), /test-meeting-secret/);
  assert.equal(calls[0].url, "https://provider.invalid/v1/chat/completions");
  const sent = JSON.parse(calls[0].options.body);
  assert.equal(sent.model, "meeting-model");
  assert.equal(sent.response_format.json_schema.strict, true);
  assert.equal(JSON.parse(sent.messages[1].content).summary, summary.text);
});

test("DeepSeek meeting imports include their field schema in JSON object mode and validate before saving", async t => {
  let output = actions();
  const { request, calls, store, form } = await fixture(t, () => completion(output), {
    AI_PROVIDER_NAME: "deepseek", AI_API_KEY: "test-meeting-secret", AI_MODEL: "deepseek-flash",
    AI_BASE_URL: "https://api.deepseek.com",
  });
  assert.equal((await importSummary(request)).status, 200);
  const sent = JSON.parse(calls[0].options.body);
  assert.deepEqual(sent.response_format, { type: "json_object" });
  assert.equal(sent.max_tokens, 8192);
  const schema = JSON.parse(sent.messages[0].content.split("Required JSON Schema:\n")[1]);
  assert.deepEqual(schema.required, ["items"]);
  assert.equal(schema.properties.items.items.properties.values.properties.task.description, "Action item");
  assert.equal(store.listRecords(form.id).length, 2);
  output = actions();
  output.items[0].evidence = "An invented commitment";
  assert.equal((await importSummary(request, { ...summary, text: summary.text + "\nFollow-up." })).status, 502);
  assert.equal(store.listRecords(form.id).length, 2);
  assert.equal(store.meetings.list(SPACE).length, 1);
});

test("same key, changed title, new key and concurrent repeated clicks do not duplicate tasks", async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { request, store, form, calls } = await fixture(t, async () => { await gate; return completion(actions()); });
  const first = importSummary(request, summary, "same-key");
  while (!calls.length) await new Promise(resolve => setTimeout(resolve, 5));
  const repeated = importSummary(request, summary, "same-key");
  const newKey = importSummary(request, { ...summary, title: "Renamed meeting" }, "new-key");
  const conflict = await importSummary(request, { ...summary, text: "Different summary" }, "same-key");
  assert.equal(conflict.status, 409);
  release();
  const results = await Promise.all([first, repeated, newKey].map(async response => (await response).json()));
  assert.equal(new Set(results.map(result => result.id)).size, 1);
  assert.equal(calls.length, 1);
  assert.equal(store.listRecords(form.id).length, 2);
  const replay = await (await importSummary(request, summary, "same-key")).json();
  assert.equal(replay.id, results[0].id);
  assert.equal(replay.duplicate, true);
  assert.equal((await importSummary(request, { ...summary, title: "Changed" }, "same-key")).status, 409);
});

test("an empty action list is a successful history entry, not invented work", async t => {
  const { request, store, form } = await fixture(t, () => completion({ items: [] }));
  const result = await (await importSummary(request)).json();
  assert.deepEqual(result.items, []);
  assert.equal(store.listRecords(form.id).length, 0);
  assert.equal(store.listChanges(form.id).length, 0);
  assert.equal((await (await request(`/api/meeting-tasks/imports?spaceId=${SPACE}`)).json())[0].count, 0);
});

test("invalid input and cross-Space targets are rejected before contacting AI", async t => {
  const { request, store, form, calls } = await fixture(t);
  for (const body of [
    { ...summary, title: "" }, { ...summary, title: "x".repeat(121) }, { ...summary, date: "2026-02-30" },
    { ...summary, text: "" }, { ...summary, text: "x".repeat(40001) }, { ...summary, spaceId: "default" },
  ]) assert.equal((await importSummary(request, body)).status, 400);
  assert.equal(calls.length, 0);
  assert.equal(store.listRecords(form.id).length, 0);
});

test("invalid AI fields, fabricated quotes, missing task names and oversized results save nothing", async t => {
  let result;
  const { request, store, form } = await fixture(t, () => completion(result));
  const wrongQuote = actions(); wrongQuote.items[1].evidence = "Not in the original summary";
  const wrongDate = actions(); wrongDate.items[1].values.dueDate = "2026-02-30";
  const wrongField = actions(); wrongField.items[1].values.unknown = "x";
  const missingTask = actions(); missingTask.items[1].values.task = null;
  for (const output of [wrongQuote, wrongDate, wrongField, missingTask, { items: Array(51).fill(actions().items[0]) }, { items: [], sql: "DROP TABLE records" }]) {
    result = output;
    assert.equal((await importSummary(request)).status, 502);
    assert.equal(store.listRecords(form.id).length, 0);
    assert.equal(store.listChanges(form.id).length, 0);
    assert.deepEqual(store.meetings.list(SPACE), []);
  }
});

test("provider failure, malformed or incomplete output, and missing configuration create no records", async t => {
  let response;
  const { request, store, form } = await fixture(t, () => response);
  for (const output of [
    new Response("unavailable", { status: 429 }),
    new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "{}" } }] })),
    new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { refusal: "no", content: "{}" } }] })),
    new Response("invalid JSON"),
  ]) {
    response = output;
    assert.equal((await importSummary(request)).status, 502);
    assert.equal(store.listRecords(form.id).length, 0);
  }
  const unconfigured = await fixture(t, undefined, {});
  assert.equal((await importSummary(unconfigured.request)).status, 503);
  assert.equal(unconfigured.store.listRecords(unconfigured.form.id).length, 0);
});

test("all task writes roll back if a later record violates custom form validation", async t => {
  const { request, store, form } = await fixture(t);
  const updated = store.updateForm(form.id, { version: form.version, name: form.name, fields: [
    ...form.fields, { id: "uniqueOwner", name: "Unique owner copy", type: "number", required: false, unique: true, options: [],
      formula: { expression: "1", bindings: {} } },
  ] });
  assert.equal((await importSummary(request)).status, 409);
  assert.equal(store.listRecords(updated.id).length, 0);
  assert.equal(store.listChanges(updated.id).length, 0);
  assert.deepEqual(store.meetings.list(SPACE), []);
});

test("changing schema while AI is running rejects the stale output", async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { request, store, form, calls } = await fixture(t, async () => { await gate; return completion(actions()); });
  const response = importSummary(request);
  while (!calls.length) await new Promise(resolve => setTimeout(resolve, 5));
  store.updateForm(form.id, { version: form.version, name: "Team tasks", fields: form.fields });
  release();
  assert.equal((await response).status, 409);
  assert.equal(store.listRecords(form.id).length, 0);
});

test("authentication, roles, origins and Space validation also apply to meeting import endpoints", async t => {
  const { request, store, admin, form } = await fixture(t);
  const member = store.auth.withUser(admin.user, () => store.auth.createUser({
    username: "meeting.member", password: "Meeting-test-password", role: "user",
  }));
  const { sessionToken } = store.auth.login({ username: member.username, password: "Meeting-test-password" });
  const cookie = `releaf_session=${sessionToken}`;
  assert.equal((await importSummary(request)).status, 200);
  assert.equal((await request(`/api/meeting-tasks/imports?spaceId=${SPACE}`, { cookie })).status, 200);
  assert.equal((await request("/api/meeting-tasks/imports", { method: "POST", cookie, body: summary })).status, 403);
  assert.equal((await request("/api/meeting-tasks/imports", { method: "POST", cookie: null, body: summary })).status, 401);
  assert.equal((await request("/api/meeting-tasks/imports", { method: "POST", body: summary, headers: { Origin: "https://evil.invalid" } })).status, 403);
  assert.equal((await request("/api/meeting-tasks/imports?spaceId=default")).status, 400);
  const id = store.meetings.list(SPACE)[0].id;
  assert.equal((await request(`/api/meeting-tasks/imports/${id}?spaceId=default`)).status, 400);
  assert.equal((await request(`/api/meeting-tasks/imports/missing?spaceId=${SPACE}`)).status, 404);
  assert.equal(store.listRecords(form.id).length, 2);
});

test("losing admin privileges while extraction is running prevents the write", async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { request, store, admin, form, calls } = await fixture(t, async () => { await gate; return completion(actions()); });
  const backup = store.auth.createUser({ username: "meeting.backup", password: "Meeting-backup-password", role: "admin" });
  const response = importSummary(request);
  while (!calls.length) await new Promise(resolve => setTimeout(resolve, 5));
  store.auth.withUser(backup, () => store.auth.updateUser(admin.user.id, { role: "user" }));
  release();
  assert.equal((await response).status, 403);
  assert.equal(store.listRecords(form.id).length, 0);
});

test("task table core fields and deletion are protected, while labels and optional fields stay editable", async t => {
  const { store, form } = await fixture(t);
  assert.equal(store.deletions.inspect(form.id).canDelete, false);
  assert.throws(() => store.updateForm(form.id, { version: form.version, name: form.name, fields: form.fields.filter(field => field.id !== "task") }), /core fields/);
  const updated = store.updateForm(form.id, { version: form.version, name: "Team tasks", fields: form.fields.map(field => ({ ...field, name: `Team ${field.name}` })) });
  assert.equal(updated.name, "Team tasks");
});

test("Space setup and imported task history survive restart without adding duplicate forms or tasks", async () => {
  const directory = mkdtempSync(join(tmpdir(), "releaf-meetings-"));
  let store;
  try {
    const path = join(directory, "forms.sqlite");
    store = createStore(path);
    store.meetings.initialize();
    const formId = store.meetings.state(SPACE).formId;
    store.meetings.configure({
      aiConfig: createAIConfig({ store, env: { AI_API_KEY: "persist-test", AI_MODEL: "test-model" } }),
      fetchImpl: async () => completion(actions()),
    });
    const imported = await store.meetings.importSummary(summary, "persisted-key");
    store.close(); store = createStore(path);
    store.meetings.initialize();
    assert.equal(store.meetings.state(SPACE).formId, formId);
    assert.equal(store.listForms(SPACE).length, 1);
    assert.equal(store.spaces.tree(SPACE).length, 1);
    assert.equal(store.meetings.get(imported.id, SPACE).text, summary.text);
    assert.equal(store.listRecords(formId).length, 2);
    assert.equal((await store.meetings.importSummary(summary, "persisted-key")).duplicate, true);
    assert.equal(store.listRecords(formId).length, 2);
  } finally { store?.close(); rmSync(directory, { recursive: true, force: true }); }
});
