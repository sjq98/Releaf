import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.js";
import { setupAdmin } from "./helpers/http-auth.js";

async function fixture(t) {
  const app = createApp({ database: ":memory:", env: {} });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise(resolve => app.server.close(resolve));
    app.store.close();
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const admin = await setupAdmin(base), { store } = app;
  const createUser = username => store.auth.withUser(admin.user, () => store.auth.createUser({
    username, displayName: username, password: "Test-only-password-2026", role: "user",
  }));
  const operator = { user: createUser("warehouse.operator") }, approver = { user: createUser("warehouse.approver") };
  for (const account of [operator, approver]) {
    const response = await fetch(base + "/api/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: account.user.username, password: "Test-only-password-2026" }),
    });
    assert.equal(response.status, 200);
    account.cookie = response.headers.get("set-cookie").split(";")[0];
  }
  const tables = store.warehouse.ensureTables().tables;
  const warehouse = store.warehouse.state().warehouses[0];
  const product = store.warehouse.catalog({ role: "products", values: { code: "AUTH-FLOUR", name: "Flour", unit: "kg" } });
  const request = async (account, path, method = "GET", body, key) => {
    const response = await fetch(base + path, {
      method, headers: {
        ...(account ? { Cookie: account.cookie } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  };
  const documentBody = () => ({
    kind: "inbound", values: { warehouse: warehouse.id, applicant: admin.user.username, approver: approver.user.username },
    actor: admin.user.username, lines: [{ product: product.id, quantity: 3 }], submit: true,
  });
  return { store, admin, operator, approver, tables, warehouse, product, request, documentBody };
}

test("administrators can maintain records and custom fields while warehouse invariants stay protected", async t => {
  const { store, admin, operator, tables, request } = await fixture(t);
  const original = store.getForm(tables.products);
  const fields = [
    ...original.fields.map(field => field.id === "name" ? { ...field, name: "Product title" } : field),
    { id: "supplierLabel", name: "Supplier label", type: "text", required: false, unique: false, options: [] },
  ];
  const schema = await request(admin, `/api/forms/${original.id}`, "PUT", { ...original, fields });
  assert.equal(schema.status, 200);
  assert.equal(schema.data.fields.find(field => field.id === "name").name, "Product title");
  const created = await request(admin, `/api/forms/${original.id}/records`, "POST", {
    schemaVersion: schema.data.version, values: { code: "ADMIN-EDIT", name: "Salt", unit: "kg", supplierLabel: "Local" },
  });
  assert.equal(created.status, 201);
  const edited = await request(admin, `/api/records/${created.data.record.id}`, "PATCH", {
    schemaVersion: schema.data.version, version: created.data.record.version, values: { supplierLabel: "Updated" },
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.data.record.values.supplierLabel, "Updated");
  assert.equal((await request(admin, `/api/records/${created.data.record.id}`, "DELETE", { version: edited.data.record.version })).status, 200);
  for (const changed of [
    schema.data.fields.filter(field => field.id !== "unit"),
    schema.data.fields.map(field => field.id === "unit" ? { ...field, type: "longtext" } : field),
  ]) {
    assert.equal((await request(admin, `/api/forms/${original.id}`, "PUT", { ...schema.data, fields: changed })).status, 409);
  }
  const adminBootstrap = await request(admin, `/api/bootstrap?formId=${original.id}`);
  const userBootstrap = await request(operator, `/api/bootstrap?formId=${original.id}`);
  assert.equal(adminBootstrap.data.form.readOnly, false);
  assert.equal(userBootstrap.data.form.readOnly, true);
  assert.equal(adminBootstrap.data.permissions.editRecords, true);
  assert.equal(userBootstrap.data.permissions.editRecords, false);
});

test("ordinary users cannot use generic mutations or administration endpoints", async t => {
  const { store, operator, tables, product, request } = await fixture(t);
  const schema = store.getForm(tables.products);
  const node = store.spaces.tree().find(row => row.formId === schema.id);
  const mutations = [
    ["/api/forms", "POST", { name: "Bypass" }],
    [`/api/forms/${schema.id}`, "PUT", { ...schema, name: "Bypass" }],
    [`/api/forms/${schema.id}/records`, "POST", { schemaVersion: schema.version, values: { code: "BY", name: "Bypass", unit: "kg" } }],
    [`/api/records/${product.id}`, "PATCH", { schemaVersion: schema.version, version: product.version, values: { name: "Bypass" } }],
    [`/api/records/${product.id}`, "DELETE", { version: product.version }],
    [`/api/nodes/${node.id}/move`, "POST", { targetId: null, placement: "inside" }],
    ["/api/spaces", "POST", { name: "Bypass" }],
    ["/api/warehouse/setup", "POST", {}],
    ["/api/auth/users", "POST", { username: "escalate", role: "admin", password: "Test-password-2026" }],
  ];
  for (const [path, method, body] of mutations) assert.equal((await request(operator, path, method, body)).status, 403, path);
  assert.equal((await request(operator, "/api/auth/users")).status, 403);
  assert.equal((await request(null, "/api/bootstrap")).status, 401);
  assert.equal(store.getRecord(product.id).values.name, "Flour");
});

test("catalog maintenance requires an administrator through the service and HTTP", async t => {
  const { store, admin, operator, warehouse, product, request } = await fixture(t);
  const stock = store.warehouse.catalog({
    role: "stock", values: { product: product.id, warehouse: warehouse.id, minimum: 2, openingQuantity: 5 },
  });
  const attempts = [
    { role: "products", values: { code: "MEMBER-P", name: "Forbidden product", unit: "kg" }, record: product, changes: { name: "Forbidden" } },
    { role: "warehouses", values: { code: "MEMBER-W", name: "Forbidden warehouse" }, record: warehouse, changes: { name: "Forbidden" } },
    { role: "stock", values: { product: product.id, warehouse: warehouse.id, minimum: 100 }, record: stock, changes: { minimum: 100, openingQuantity: 100 } },
  ];
  const before = attempts.map(({ record }) => store.getRecord(record.id));
  for (const { role, values, record, changes } of attempts) {
    for (const body of [{ role, values }, { role, recordId: record.id, version: record.version, values: changes }]) {
      store.auth.withUser(operator.user, () => assert.throws(() => store.warehouse.catalog(body), { status: 403 }, role));
      assert.equal((await request(operator, "/api/warehouse/catalog", "POST", body)).status, 403, role);
    }
  }
  assert.deepEqual(attempts.map(({ record }) => store.getRecord(record.id)), before);
  const allowed = await request(admin, "/api/warehouse/catalog", "POST", {
    role: "products", recordId: product.id, version: product.version, values: { name: "Administrator updated flour" },
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.data.values.name, "Administrator updated flour");
  const registered = await request(admin, "/api/warehouse/catalog", "POST", {
    role: "warehouses", values: { code: "ADMIN-W", name: "Administrator warehouse" },
  });
  assert.equal(registered.status, 200);
  assert.equal(registered.data.values.code, "ADMIN-W");
});

test("inventory dashboard is readable by members but requires a login", async t => {
  const { store, admin, operator, warehouse, product, request } = await fixture(t);
  const stock = store.warehouse.catalog({
    role: "stock", values: { product: product.id, warehouse: warehouse.id, minimum: 6, openingQuantity: 5 },
  });
  const path = "/api/warehouse/dashboard?from=2026-10&to=2026-10";
  assert.equal((await request(null, path)).status, 401);
  const administrator = await request(admin, path), member = await request(operator, path);
  assert.equal(administrator.status, 200);
  assert.equal(member.status, 200);
  assert.deepEqual(member.data.summary, administrator.data.summary);
  assert.deepEqual(member.data.warnings, administrator.data.warnings);
  assert.equal(member.data.warnings[0].stockId, stock.id);
  assert.equal(member.data.warnings[0].shortage, 1);
  assert.equal((await request(operator, "/api/warehouse/dashboard", "POST", {})).status, 403);
  assert.deepEqual(store.getRecord(stock.id), stock);
});

test("workflow actors and applicants come from login and only the assigned user can approve", async t => {
  const { store, operator, approver, request, documentBody } = await fixture(t);
  const created = await request(operator, "/api/warehouse/documents", "POST", documentBody());
  assert.equal(created.status, 201);
  let doc = created.data;
  assert.equal(doc.record.values.applicant, operator.user.username);
  assert.equal(doc.record.values.initiator, operator.user.username);
  assert.equal(doc.events[0].actor, operator.user.username);
  const path = `/api/warehouse/documents/${doc.record.id}`;
  const approval = { action: "approve", version: doc.record.version, actor: approver.user.username };
  assert.equal((await request(operator, path + "/preview", "POST", approval)).status, 403);
  assert.equal((await request(operator, path + "/transition", "POST", approval)).status, 403);
  const approved = await request(approver, path + "/transition", "POST", { ...approval, actor: "forged.actor" });
  assert.equal(approved.status, 200);
  doc = approved.data;
  assert.equal(doc.events.at(-1).actor, approver.user.username);
  const post = { action: "post", version: doc.record.version, actor: "forged.actor" };
  const preview = await request(operator, path + "/preview", "POST", post);
  assert.equal(preview.status, 200);
  const posted = await request(operator, path + "/transition", "POST", { ...post, fingerprint: preview.data.fingerprint });
  assert.equal(posted.status, 200);
  assert.equal(posted.data.record.values.status, "Posted");
  assert.equal(posted.data.events.at(-1).actor, operator.user.username);
  assert.equal(store.warehouse.state().stockItems[0].values.currentQuantity, 3);
});

test("spreadsheet completion cannot impersonate its assigned approver", async t => {
  const { store, operator, approver, request, documentBody } = await fixture(t);
  const upload = await request(operator, "/api/warehouse/files", "POST", {
    file: { name: "receipt.csv", data: Buffer.from("SKU,Quantity\nAUTH-FLOUR,4").toString("base64") },
  });
  assert.equal(upload.status, 201);
  const body = { fileId: upload.data.id, kind: "inbound", values: documentBody().values, stage: "post", approvalActor: approver.user.username };
  const preview = await request(operator, "/api/warehouse/imports/preview", "POST", body);
  assert.equal(preview.status, 200);
  assert.match(preview.data.errors[0].message, /assigned approver/);
  assert.equal(preview.data.documents[0].values.applicant, operator.user.username);
  const execute = await request(operator, "/api/warehouse/imports/execute", "POST", { ...body, fingerprint: preview.data.fingerprint });
  assert.equal(execute.status, 403);
  assert.equal(store.warehouse.state().requests.length, 0);
  const allowed = await request(approver, "/api/warehouse/imports/preview", "POST", body);
  assert.deepEqual(allowed.data.errors, []);
  const completed = await request(approver, "/api/warehouse/imports/execute", "POST", { ...body, fingerprint: allowed.data.fingerprint });
  assert.equal(completed.status, 200);
  assert.equal(store.warehouse.state().stockItems[0].values.currentQuantity, 4);
});

test("identical HTTP idempotency keys are scoped per user and disabled sessions stop immediately", async t => {
  const { store, admin, operator, approver, request, documentBody } = await fixture(t);
  const body = { ...documentBody(), submit: false };
  const first = await request(operator, "/api/warehouse/documents", "POST", body, "same-client-key");
  const replay = await request(operator, "/api/warehouse/documents", "POST", body, "same-client-key");
  const other = await request(approver, "/api/warehouse/documents", "POST", body, "same-client-key");
  assert.equal(first.status, 201); assert.deepEqual(first, replay);
  assert.equal(other.status, 201);
  assert.notEqual(first.data.record.id, other.data.record.id);
  assert.equal(other.data.record.values.applicant, approver.user.username);
  store.auth.withUser(admin.user, () => store.auth.updateUser(operator.user.id, { active: false }));
  assert.equal((await request(operator, "/api/warehouse")).status, 401);
  assert.equal((await request(operator, "/api/warehouse/documents", "POST", body)).status, 401);
});
