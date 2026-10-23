import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createApp } from "../src/server.js";

function taskFixture(store) {
  const password = "Test-only-password-2026";
  const admin = store.auth.setup({ username: "task.admin", password }).user;
  return store.auth.withUser(admin, () => {
    const member = store.auth.createUser({ username: "task.member", password, role: "user" });
    const fields = [{ id: "name", name: "Name", type: "text", required: true, unique: true }];
    const source = store.createForm({ name: "Source", fields });
    const target = store.createForm({ name: "Processed", fields });
    const record = store.createRecord(source.id, { schemaVersion: source.version, values: { name: "Saved source" } }).record;
    const task = store.tasks.save({
      name: "Copy saved source", instructions: "Copy the source name.", action: "create", mode: "auto",
      formId: source.id, inputFields: ["name"], outputFormId: target.id, outputFields: ["name"],
    });
    return { admin, member, password, source, target, record, task };
  });
}

test("AI task enqueue rejects caller-supplied event snapshots and requires a saved source record", t => {
  const store = createStore(":memory:");
  t.after(() => store.close());
  const { admin, member, source, target, record, task } = taskFixture(store);
  const other = store.auth.withUser(admin, () => store.createRecord(target.id, { schemaVersion: target.version, values: { name: "Wrong source" } }).record);
  store.auth.withUser(member, () => {
    for (const body of [
      { recordId: record.id, snapshot: { kind: "deleted", formId: source.id, before: { name: "Forged" }, after: null } },
      { recordId: record.id, values: { name: "Forged" } },
      { snapshot: { kind: "deleted", before: { name: "Forged" }, after: null } },
      {},
      null,
    ]) assert.throws(() => store.tasks.enqueue(task.id, body), { status: 400 });
    assert.throws(() => store.tasks.enqueue(task.id, { recordId: "missing-record" }), { status: 404 });
    assert.throws(() => store.tasks.enqueue(task.id, { recordId: other.id }), { status: 400 });
  });
  assert.equal(store.tasks.runs().length, 0);
});

test("HTTP task execution rejects forged input while members can run configured tasks on saved data", async t => {
  const app = createApp({ database: ":memory:", env: {}, taskAI: ({ input }) => ({ items: [{ name: input.values.name }] }) });
  const { admin, member, password, source, target, record, task } = taskFixture(app.store);
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise(resolve => app.server.close(resolve));
    app.store.close();
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (user, path, body) => fetch(base + path, {
    method: "POST",
    headers: {
      Cookie: `releaf_session=${app.store.auth.login({ username: user.username, password }).sessionToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const forged = { recordId: record.id, snapshot: { kind: "deleted", formId: source.id, before: { name: "Forged" }, after: null } };
  for (const user of [admin, member]) {
    const response = await request(user, `/api/ai-tasks/${task.id}/run`, forged);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /saved input recordId/);
  }
  assert.equal(app.store.tasks.runs().length, 0);
  const valid = await request(member, `/api/ai-tasks/${task.id}/run`, { recordId: record.id });
  assert.equal(valid.status, 202);
  const queued = await valid.json();
  assert.deepEqual(queued.input.values, { name: "Saved source" });
  assert.equal((await app.store.tasks.process(queued.id)).status, "Applied");
  assert.deepEqual(app.store.listRecords(target.id).map(row => row.values.name), ["Saved source"]);
});
