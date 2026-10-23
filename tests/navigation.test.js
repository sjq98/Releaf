import test from "node:test";
import { setupAdmin } from "./helpers/http-auth.js";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store.js";
import { createApp } from "../src/server.js";
import { canDropNavigation } from "../public/navigation-drag.js";

function fixture(t) {
  const store = createStore(":memory:");
  t.after(() => store.close());
  const space = store.spaces.create("Navigation QA");
  const a = store.spaces.createNode({ name: "A", spaceId: space.id });
  const b = store.spaces.createNode({ name: "B", spaceId: space.id });
  const c = store.spaces.createNode({ name: "C", spaceId: space.id });
  const children = (parentId = null) => store.spaces.tree(space.id).filter((item) => item.parentId === parentId).map((item) => item.id);
  return { store, space, a, b, c, children };
}

test("navigation moves insert exactly before/after a sibling and normalize tied positions", (t) => {
  const { store, a, b, c, children } = fixture(t);
  for (const item of [a, b, c]) store.spaces.updateNode(item.id, { position: 0 });
  store.spaces.moveNode(c.id, { targetId: a.id, placement: "before" });
  assert.deepEqual(children(), [c.id, a.id, b.id]);
  store.spaces.moveNode(c.id, { targetId: b.id, placement: "after" });
  assert.deepEqual(children(), [a.id, b.id, c.id]);
  store.spaces.moveNode(b.id, { targetId: a.id, placement: "before" });
  assert.deepEqual(children(), [b.id, a.id, c.id]);
  store.spaces.moveNode(b.id, { targetId: null, placement: "inside" });
  assert.deepEqual(children(), [a.id, c.id, b.id]);
  assert.deepEqual(children().map((id) => store.spaces.node(id).position), [0, 1, 2]);
});

test("moving a parent carries its descendants without changing form data, references or schema versions", (t) => {
  const { store, space, a, b, c, children } = fixture(t);
  const child = store.spaces.createNode({ name: "Child", spaceId: space.id, parentId: a.id });
  const form = store.createForm({ name: "Orders", spaceId: space.id, parentId: child.id, fields: [
    { id: "code", name: "Code", type: "text", required: true, unique: true, options: [] },
  ] });
  const field = form.fields[0];
  const record = store.createRecord(form.id, { schemaVersion: form.version, values: { [field.id]: "11" } }).record;
  const reference = store.createForm({ name: "Linked", spaceId: space.id, parentId: c.id, fields: [
    { id: "order", name: "Order", type: "reference", required: false, unique: false, options: [], reference: { formId: form.id, fieldId: field.id } },
  ] });
  const linked = store.createRecord(reference.id, { schemaVersion: reference.version, values: { order: record.id } }).record;
  const original = store.getForm(form.id), originalChild = store.spaces.node(child.id);
  store.spaces.moveNode(a.id, { targetId: b.id, placement: "inside" });
  assert.deepEqual(children(), [b.id, c.id]);
  assert.deepEqual(children(b.id), [a.id]);
  assert.deepEqual(store.spaces.node(child.id), originalChild);
  assert.equal(store.spaces.node(`form_${form.id}`).parentId, child.id);
  assert.deepEqual(store.getForm(form.id), original);
  assert.deepEqual(store.getRecord(record.id), record);
  assert.deepEqual(store.getRecord(linked.id), linked);
  store.spaces.moveNode(`form_${form.id}`, { targetId: c.id, placement: "after" });
  assert.deepEqual(children(), [b.id, c.id, `form_${form.id}`]);
  assert.deepEqual(store.getForm(form.id), original);
});

test("invalid and cross-Space drops leave the complete tree unchanged", (t) => {
  const { store, space, a, b } = fixture(t);
  const child = store.spaces.createNode({ name: "Child", spaceId: space.id, parentId: a.id });
  const leaf = store.createForm({ name: "Leaf", spaceId: space.id });
  const foreign = store.spaces.createNode({ name: "Foreign" });
  const before = store.spaces.tree(space.id);
  for (const body of [null, {}, { targetId: b.id, placement: "bad" }, { targetId: null, placement: "before" },
    { targetId: a.id, placement: "inside" }, { targetId: child.id, placement: "inside" },
    { targetId: child.id, placement: "before" }, { targetId: `form_${leaf.id}`, placement: "inside" },
    { targetId: foreign.id, placement: "before" }, { targetId: foreign.id, placement: "inside" },
    { targetId: "missing", placement: "after" }]) {
    assert.throws(() => store.spaces.moveNode(a.id, body));
    assert.deepEqual(store.spaces.tree(space.id), before);
  }
  assert.throws(() => store.transaction(() => { store.spaces.moveNode(a.id, { targetId: b.id, placement: "inside" }); throw new Error("rollback"); }), /rollback/);
  assert.deepEqual(store.spaces.tree(space.id), before);
  store.database.exec(`CREATE TEMP TRIGGER navigation_failure BEFORE UPDATE OF position ON navigation_nodes
    WHEN NEW.id = '${a.id}' BEGIN SELECT RAISE(ABORT, 'test move failure'); END`);
  assert.throws(() => store.spaces.moveNode(a.id, { targetId: b.id, placement: "inside" }), /test move failure/);
  assert.deepEqual(store.spaces.tree(space.id), before);
});

test("navigation ordering and nesting survive database reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "releaf-navigation-"));
  let store;
  try {
    const path = join(directory, "forms.sqlite");
    store = createStore(path);
    const a = store.spaces.createNode({ name: "A" }), b = store.spaces.createNode({ name: "B" });
    store.spaces.moveNode(a.id, { targetId: b.id, placement: "inside" });
    store.spaces.moveNode(b.id, { targetId: `form_${store.listForms()[0].id}`, placement: "before" });
    const expected = store.spaces.tree();
    store.close(); store = createStore(path);
    assert.deepEqual(store.spaces.tree(), expected);
  } finally { store?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("client drop validation rejects self/descendant/foreign/form-container targets", (t) => {
  const { store, space, a, b } = fixture(t);
  const child = store.spaces.createNode({ name: "Child", spaceId: space.id, parentId: a.id });
  const form = store.createForm({ name: "Leaf", spaceId: space.id });
  const nodes = [...store.spaces.tree(space.id), ...store.spaces.tree()];
  assert.equal(canDropNavigation(nodes, a.id, b.id, "inside"), true);
  assert.equal(canDropNavigation(nodes, a.id, null, "inside"), true);
  for (const [targetId, placement] of [[a.id, "after"], [child.id, "before"], [child.id, "inside"], [`form_${form.id}`, "inside"], ["node_orders", "after"], [null, "after"], [b.id, "bad"]]) {
    assert.equal(canDropNavigation(nodes, a.id, targetId, placement), false);
  }
});

test("HTTP navigation moves are local-only, idempotent and return the persisted tree", async (t) => {
  const app = createApp({ database: ":memory:", env: {} });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise((resolve) => app.server.close(resolve)); app.store.close(); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const { cookie } = await setupAdmin(base);
  const a = app.store.spaces.createNode({ name: "A" }), b = app.store.spaces.createNode({ name: "B" });
  const url = `${base}/api/nodes/${a.id}/move`;
  const options = { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json", "Idempotency-Key": "move-1" }, body: JSON.stringify({ targetId: b.id, placement: "inside" }) };
  for (const headers of [{ Origin: "https://example.com" }, { Authorization: "Bearer test" }]) {
    assert.equal((await fetch(url, { ...options, headers: { ...options.headers, ...headers } })).status, 403);
    assert.equal(app.store.spaces.node(a.id).parentId, null);
  }
  const response = await fetch(url, options);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.node.parentId, b.id);
  assert.deepEqual(result.navigation, app.store.spaces.tree());
  assert.deepEqual(await (await fetch(url, options)).json(), result);
  assert.equal((await fetch(`${base}/navigation-drag.js`)).status, 200);
});
