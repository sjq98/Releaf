import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createStore } from "../src/store.js";
import { createAgentOperations } from "../src/agent-operations.js";
import { ORDER_SPACE_ID } from "../src/order-system.js";

function fixture(t) {
  const store = createStore(":memory:");
  t.after(() => store.close());
  const { user: admin } = store.auth.setup({
    username: "order.admin", displayName: "Order Admin", password: "Test-only-password-2026",
  });
  const as = (user, callback) => store.auth.withUser(user, callback);
  const member = username => as(admin, () => store.auth.createUser({
    username, displayName: username, password: "Test-only-password-2026", role: "user",
  }));
  const alice = member("orders.alice"), bob = member("orders.bob");
  const body = overrides => ({
    spaceId: ORDER_SPACE_ID, customerName: "Lee", fulfillment: "pickup", totalAmount: 17.8,
    notes: "Chicken rice x 2 portions\nOne without chilli", reviewed: true, ...overrides,
  });
  const create = (overrides, user = alice) => as(user, () => store.orders.create(body(overrides)));
  return { store, as, admin, alice, bob, body, create };
}

const output = (overrides = {}) => ({
  isOrder: true, orderEvidence: "Please order 2 portions of Chicken rice",
  customerName: "Lee", customerPhone: null, fulfillment: "pickup", deliveryAddress: null,
  requestedTime: null, notes: null,
  items: [{ productName: "Chicken rice", quantity: 2, unit: "portion", notes: null, evidence: "2 portions of Chicken rice" }],
  ...overrides,
});
const message = "Please order 2 portions of Chicken rice for pickup. Total RM17.80.";
const configureAI = (store, result = output(), onCall = () => {}) => store.orders.configure({
  aiConfig: { credentials: () => ({ apiKey: "private-key", model: "order-model", baseUrl: "https://provider.invalid/v1" }) },
  fetchImpl: async () => { onCall(); return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(result) } }] }); },
});
const source = overrides => ({ channel: "whatsapp", accountId: "merchant", chatId: "customer-chat", messageId: "message-1", ...overrides });

test("orders are real shared forms with one automatically linked unchecked payment confirmation", t => {
  const { store, as, alice } = fixture(t);
  const order = as(alice, () => store.orders.create({ notes: "A customer request awaiting review" }));
  assert.equal(order.totalAmount, null);
  assert.equal(order.customerName, null);
  assert.equal(order.reviewed, false);
  assert.equal(order.status, "draft");
  assert.equal(order.paymentConfirmed, false);
  assert.equal(order.createdBy, alice.id);
  assert.match(order.number, /^ORD-\d{8}-\d{4}$/);
  assert.deepEqual(order.allowedActions, ["cancel"]);
  const workspace = as(alice, () => store.bootstrap(null, ORDER_SPACE_ID));
  assert.deepEqual(workspace.forms.map(form => form.name), ["Orders", "Payment confirmations", "Invoices"]);
  assert.equal(workspace.forms.every(form => form.readOnly), true);
  assert.equal(workspace.navigation.filter(node => node.formId).length, 3);
  const { orders, payments, invoices } = workspace.orders.tables;
  assert.equal(as(alice, () => store.getRecord(order.id)).formId, orders);
  const payment = as(alice, () => store.listRecords(payments))[0];
  assert.equal(payment.values.order, order.id);
  assert.equal(payment.values.confirmed, false);
  assert.equal(payment.values.totalAmount, null);
  assert.equal(payment.values.createdBy, alice.id);
  assert.equal(as(alice, () => store.listRecords(invoices)).length, 0);
  const reference = store.getForm(payments).fields.find(field => field.id === "order");
  assert.deepEqual(reference.reference, { formId: orders, fieldId: "number" });
  assert.equal(reference.unique, true);
  assert.equal(order.receivedAmount, undefined);
  assert.equal(order.outstandingAmount, undefined);
});

test("review requires a manually supplied amount and fulfillment details; empty is distinct from zero", t => {
  const { store, as, alice, create } = fixture(t);
  const draft = create({ totalAmount: null, reviewed: false });
  assert.throws(() => as(alice, () => store.orders.transition(draft.id, { version: draft.version, action: "accept" })), { status: 409 });
  assert.throws(() => as(alice, () => store.orders.update(draft.id, { version: draft.version, reviewed: true })), { status: 400 });
  assert.throws(() => create({ reviewed: true, fulfillment: "delivery", deliveryAddress: null }), { status: 400 });
  for (const totalAmount of ["17.8", -1, Infinity, 1.001, 1e13]) assert.throws(() => create({ totalAmount }), { status: 400 });
  const reviewed = as(alice, () => store.orders.update(draft.id, { version: draft.version, totalAmount: 0, reviewed: true }));
  assert.equal(reviewed.totalAmount, 0);
  assert.equal(reviewed.reviewed, true);
  assert.ok(reviewed.allowedActions.includes("accept"));
  assert.equal(reviewed.paymentConfirmation.totalAmount, 0);
  assert.throws(() => create({ status: "completed" }), { status: 400 });
  assert.throws(() => create({ createdBy: "another-user" }), { status: 400 });
});

test("delivery dates retain Singapore wall time and reject invalid calendar dates", t => {
  const { create } = fixture(t);
  for (const estimatedDeliveryAt of ["2026-10-25T04:30:00.000Z", "2026-10-25T12:30", "2026-10-25T12:30:20+08:00"]) {
    assert.equal(create({ estimatedDeliveryAt }).estimatedDeliveryAt, "2026-10-25T12:30");
  }
  for (const estimatedDeliveryAt of ["2026-02-30T12:00:00.000Z", "2026-10-25T24:00:00.000Z", "2026-10-25T12:30:60Z"]) {
    assert.throws(() => create({ estimatedDeliveryAt }), { status: 400 });
  }
});

test("members see only owned records through dedicated and generic forms, references and activity", t => {
  const { store, as, admin, alice, bob, create } = fixture(t);
  const mine = create(), other = create({ customerName: "Bob customer" }, bob);
  const ids = store.orders.tables();
  assert.deepEqual(as(alice, () => store.orders.list()).map(order => order.id), [mine.id]);
  assert.deepEqual(as(alice, () => store.listRecords(ids.orders)).map(row => row.id), [mine.id]);
  assert.equal(as(alice, () => store.listForms(ORDER_SPACE_ID)).find(form => form.id === ids.orders).recordCount, 1);
  assert.equal(as(admin, () => store.orders.list()).length, 2);
  for (const callback of [
    () => store.orders.get(other.id),
    () => store.getRecord(other.id),
    () => store.getRecord(other.paymentConfirmation.id),
    () => store.orders.update(other.id, { version: other.version, notes: "Forbidden" }),
    () => store.orders.transition(other.id, { version: other.version, action: "accept" }),
    () => store.orders.confirmPayment(other.id, { version: other.version, confirmed: true }),
    () => store.orders.invoice(other.id, { version: other.version, amount: 1, number: "NO-ACCESS" }),
  ]) assert.throws(() => as(alice, callback), { status: 404 });
  assert.equal(as(alice, () => store.referenceCatalog(ORDER_SPACE_ID)).find(form => form.id === ids.orders).records.length, 1);
  assert.equal(as(alice, () => store.listChanges(ids.orders)).every(change => change.recordId === mine.id), true);
  assert.throws(() => as(alice, () => store.updateRecord(mine.id, {
    version: mine.version, schemaVersion: store.getForm(ids.orders).version, values: { notes: "Generic member edit" },
  })), { status: 403 });
});

test("payment confirmation requires reviewed orders and records human confirmation without amount totals", t => {
  const { store, as, alice, create } = fixture(t);
  let order = create({ reviewed: false });
  assert.throws(() => as(alice, () => store.orders.confirmPayment(order.id, { version: order.version, confirmed: true })), { status: 409 });
  order = as(alice, () => store.orders.update(order.id, { version: order.version, reviewed: true }));
  assert.throws(() => as(alice, () => store.orders.confirmPayment(order.id, { version: order.version, confirmed: "true" })), { status: 400 });
  const before = order;
  order = as(alice, () => store.orders.confirmPayment(order.id, { version: order.version, confirmed: true }));
  assert.equal(order.paymentConfirmed, true);
  assert.equal(order.paymentConfirmation.confirmedBy, alice.username);
  assert.ok(order.paymentConfirmation.confirmedAt);
  assert.equal(as(alice, () => store.getRecord(order.id)).values.paymentConfirmed, true);
  assert.equal(order.receivedAmount, undefined);
  assert.equal(order.outstandingAmount, undefined);
  const duplicate = as(alice, () => store.orders.confirmPayment(order.id, { version: order.version, confirmed: true }));
  assert.equal(duplicate.version, order.version);
  assert.equal(as(alice, () => store.listRecords(store.orders.tables().payments)).length, 1);
  assert.throws(() => as(alice, () => store.orders.confirmPayment(order.id, { version: before.version, confirmed: false })), { status: 409 });
  assert.throws(() => as(alice, () => store.orders.transition(order.id, { version: order.version, action: "cancel" })), { status: 409 });
  const cleared = as(alice, () => store.orders.confirmPayment(order.id, { version: order.version, confirmed: false }));
  assert.equal(cleared.paymentConfirmed, false);
  assert.equal(cleared.paymentConfirmation.confirmedAt, null);
  assert.equal(cleared.paymentConfirmation.confirmedBy, null);
  assert.ok(cleared.events.some(event => event.action === "payment_confirmed"));
  assert.ok(cleared.events.some(event => event.action === "payment_confirmation_cleared"));
});

test("amount changes update the same confirmation and clear both payment and order checkboxes", t => {
  const { store, as, alice, create } = fixture(t);
  let order = create();
  order = as(alice, () => store.orders.confirmPayment(order.id, { version: order.version, confirmed: true }));
  const paymentId = order.paymentConfirmation.id;
  order = as(alice, () => store.orders.update(order.id, { version: order.version, totalAmount: 22.5 }));
  assert.equal(order.totalAmount, 22.5);
  assert.equal(order.reviewed, false);
  assert.equal(order.paymentConfirmed, false);
  assert.equal(order.paymentConfirmation.id, paymentId);
  assert.equal(order.paymentConfirmation.totalAmount, 22.5);
  assert.equal(order.paymentConfirmation.confirmed, false);
  assert.equal(as(alice, () => store.getRecord(order.id)).values.paymentConfirmed, false);
  assert.ok(order.events.some(event => event.action === "payment_recheck_required"));
});

test("administrator generic confirmation edits enforce the same review, actor and managed-field rules", t => {
  const { store, as, admin, alice, create } = fixture(t);
  let order = create({ reviewed: false });
  const payments = store.getForm(store.orders.tables().payments);
  const write = values => as(admin, () => store.updateRecord(order.paymentConfirmation.id, {
    version: order.paymentConfirmation.version, schemaVersion: payments.version, values,
  }));
  assert.throws(() => write({ confirmed: true }), { status: 409 });
  order = as(alice, () => store.orders.update(order.id, { version: order.version, reviewed: true }));
  for (const values of [{ totalAmount: 1 }, { createdBy: admin.id }, { confirmedBy: "Invented" }]) {
    assert.throws(() => write(values), { status: 409 });
  }
  write({ confirmed: true });
  order = as(admin, () => store.orders.get(order.id));
  assert.equal(order.paymentConfirmed, true);
  assert.equal(order.paymentConfirmation.confirmedBy, admin.username);
  const orders = store.getForm(store.orders.tables().orders);
  assert.throws(() => as(admin, () => store.createRecord(orders.id, {
    schemaVersion: orders.version, values: { customerName: "Lee", fulfillment: "pickup", totalAmount: 1, reviewed: "false" },
  })), { status: 400 });
  for (const role of ["payments", "invoices"]) {
    const form = store.getForm(store.orders.tables()[role]);
    assert.throws(() => as(admin, () => store.createRecord(form.id, {
      schemaVersion: form.version, values: { number: "MISSING-ORDER", amount: 1 },
    })), { status: 400 });
  }
});

test("manual invoices use linked shared records, preserve exact totals and require reviewed orders", t => {
  const { store, as, alice, create } = fixture(t);
  let order = create({ totalAmount: 0.3, reviewed: false });
  assert.throws(() => as(alice, () => store.orders.invoice(order.id, { version: order.version, amount: 0.1, number: "I1" })), { status: 409 });
  order = as(alice, () => store.orders.update(order.id, { version: order.version, reviewed: true }));
  for (const [number, value] of [["I1", 0.1], ["I2", 0.2]]) {
    order = as(alice, () => store.orders.invoice(order.id, { version: order.version, amount: value, number, note: "Manual invoice" }));
  }
  assert.equal(order.invoicedAmount, 0.3);
  assert.equal(order.uninvoicedAmount, 0);
  assert.equal(order.paymentConfirmed, false);
  assert.equal(order.invoices.length, 2);
  assert.equal(order.invoices[0].order, order.id);
  assert.equal(order.invoices[0].note, "Manual invoice");
  assert.throws(() => as(alice, () => store.orders.invoice(order.id, { version: order.version, amount: 0.01, number: "I3" })), { status: 400 });
  assert.throws(() => as(alice, () => store.orders.update(order.id, { version: order.version, totalAmount: 0.29 })), { status: 400 });
});

test("pickup and delivery workflows preserve warehouse independence and lock later order details", t => {
  const { store, as, admin, alice, create } = fixture(t);
  const warehouse = as(admin, () => store.warehouse.ensureTables());
  const snapshot = () => Object.fromEntries(Object.entries(warehouse.tables).map(([role, id]) => [role, store.listRecords(id)]));
  const before = snapshot();
  for (const fulfillment of ["pickup", "delivery"]) {
    let order = create({ fulfillment, deliveryAddress: fulfillment === "delivery" ? "1 Main Street" : null });
    assert.throws(() => as(alice, () => store.orders.transition(order.id, { version: order.version, action: "complete" })), { status: 409 });
    for (const action of ["accept", "prepare", "ready", ...(fulfillment === "delivery" ? ["dispatch"] : []), "complete"]) {
      order = as(alice, () => store.orders.transition(order.id, { version: order.version, action }));
    }
    assert.equal(order.status, "completed");
    assert.ok(order.actualDeliveryAt);
    assert.equal(order.canEdit, false);
    assert.throws(() => as(alice, () => store.orders.update(order.id, { version: order.version, notes: "Rewrite history" })), { status: 409 });
  }
  assert.deepEqual(snapshot(), before);
  assert.equal(store.orders.issueDraft, undefined);
});

test("administrators can add and remove custom fields but cannot change core field rules", t => {
  const { store, as, admin, alice, create } = fixture(t);
  const order = create(), form = store.getForm(store.orders.tables().orders);
  const extra = { id: "deliveryNote", name: "Delivery note", type: "text", required: false, unique: false };
  let updated = as(admin, () => store.updateForm(form.id, { version: form.version, name: "Customer orders", fields: [...form.fields, extra] }));
  as(admin, () => store.updateRecord(order.id, { schemaVersion: updated.version, version: order.version, values: { deliveryNote: "Door 2" } }));
  assert.equal(as(alice, () => store.getRecord(order.id)).values.deliveryNote, "Door 2");
  assert.equal(store.orders.state().coreFields.orders.includes(extra.id), false);
  assert.throws(() => as(admin, () => store.updateForm(form.id, {
    version: updated.version, name: updated.name, fields: updated.fields.filter(field => field.id !== "totalAmount"),
  })), { status: 409 });
  assert.throws(() => as(admin, () => store.updateForm(form.id, {
    version: updated.version, name: updated.name, fields: updated.fields.map(field => field.id === "number" ? { ...field, unique: false } : field),
  })), { status: 409 });
  updated = as(admin, () => store.updateForm(form.id, { version: updated.version, name: updated.name, fields: updated.fields.filter(field => field.id !== extra.id) }));
  assert.equal(updated.fields.some(field => field.id === extra.id), false);
  assert.throws(() => as(alice, () => store.updateForm(form.id, { version: updated.version, name: "Renamed", fields: updated.fields })), { status: 403 });
});

test("failed automatic payment creation rolls back order, numbering and all activity atomically", t => {
  const { store, as, admin, create } = fixture(t);
  const form = store.getForm(store.orders.tables().payments);
  as(admin, () => store.updateForm(form.id, { version: form.version, name: form.name, fields: [
    ...form.fields, { id: "mandatory", name: "Mandatory custom value", type: "text", required: true, unique: false },
  ] }));
  const before = store.orders.fingerprint();
  assert.throws(() => create(), { status: 400 });
  assert.deepEqual(store.orders.fingerprint(), before);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM form_activity WHERE form_id = ?").get(store.orders.tables().orders).count, 0);
});

test("administrator deletion removes paired unpaid draft but never orphan-confirms or erases completed orders", t => {
  const { store, as, admin, create } = fixture(t);
  const draft = create(), ids = store.orders.tables();
  assert.throws(() => as(admin, () => store.deleteRecord(draft.paymentConfirmation.id, { version: draft.paymentConfirmation.version })), { status: 409 });
  as(admin, () => store.deleteRecord(draft.id, { version: draft.version }));
  assert.equal(as(admin, () => store.listRecords(ids.orders)).length, 0);
  assert.equal(as(admin, () => store.listRecords(ids.payments)).length, 0);
  let active = create();
  active = as(admin, () => store.orders.transition(active.id, { version: active.version, action: "accept" }));
  assert.throws(() => as(admin, () => store.deleteRecord(active.id, { version: active.version })), { status: 409 });
});

test("AI intake automatically creates unreviewed shared records without extracting or confirming money", async t => {
  const { store, as, alice } = fixture(t);
  configureAI(store);
  const draft = await as(alice, () => store.orders.extract({ text: message }));
  assert.equal(draft.isOrder, true);
  assert.equal(draft.totalAmount, null);
  assert.equal(as(alice, () => store.orders.list()).length, 0);
  const order = await as(alice, () => store.orders.intake({ text: message, source: source() }));
  assert.equal(order.totalAmount, null);
  assert.equal(order.reviewed, false);
  assert.equal(order.paymentConfirmed, false);
  assert.equal(order.source.messageId, "message-1");
  assert.equal(order.sourceText, message);
  assert.equal(order.notes, "Chicken rice x 2 portion");
  assert.equal(as(alice, () => store.listRecords(store.orders.tables().payments)).length, 1);
});

test("source identity deduplicates before AI and concurrent source replay creates one order and one confirmation", async t => {
  const { store, as, alice, bob } = fixture(t);
  let calls = 0;
  configureAI(store, output(), () => { calls++; });
  const orders = await as(alice, () => Promise.all([
    store.orders.intake({ text: message, source: source() }),
    store.orders.intake({ text: message, source: source() }),
  ]));
  assert.equal(orders[0].id, orders[1].id);
  assert.ok(orders.some(order => order.intakeDuplicate));
  const before = calls;
  const duplicate = await as(alice, () => store.orders.intake({ text: "Changed text must not reprocess a message", source: source() }));
  assert.equal(duplicate.id, orders[0].id);
  assert.equal(calls, before);
  assert.equal(as(alice, () => store.orders.list()).length, 1);
  assert.equal(as(alice, () => store.listRecords(store.orders.tables().payments)).length, 1);
  await assert.rejects(as(bob, () => store.orders.intake({ text: message, source: source() })), { status: 404 });
  const anotherAccount = await as(alice, () => store.orders.intake({ text: message, source: source({ accountId: "merchant-two" }) }));
  assert.notEqual(anotherAccount.id, orders[0].id);
});

test("non-order messages are skipped and importExtracted cannot inject money or reviewed status", t => {
  const { store, as, alice } = fixture(t);
  const skipped = as(alice, () => store.orders.importExtracted({ draft: { isOrder: false }, source: source() }));
  assert.equal(skipped.skipped, true);
  assert.equal(as(alice, () => store.orders.list()).length, 0);
  const order = as(alice, () => store.orders.importExtracted({
    draft: { isOrder: true, customerName: "Lee", fulfillment: "pickup", totalAmount: 999, reviewed: true },
    source: source(), text: message,
  }));
  assert.equal(order.totalAmount, null);
  assert.equal(order.reviewed, false);
  assert.equal(order.paymentConfirmed, false);
});

test("Order Management remains a separate Space with real forms and no warehouse forms", t => {
  const { store, as, admin, alice, create } = fixture(t);
  as(admin, () => store.warehouse.ensureTables());
  const order = create();
  const inventory = as(alice, () => store.bootstrap(null, "default"));
  assert.equal(inventory.orders.enabled, false);
  assert.deepEqual(inventory.orders.tables, {});
  const orders = as(alice, () => store.bootstrap(order.formId, ORDER_SPACE_ID));
  assert.equal(orders.space.id, ORDER_SPACE_ID);
  assert.equal(orders.orders.enabled, true);
  assert.equal(orders.forms.length, 3);
  assert.deepEqual(orders.warehouse.tables, {});
  assert.equal(orders.meetingTasks.enabled, false);
  assert.throws(() => as(alice, () => store.orders.create({ spaceId: "default" })), /Order Management Space/);
  assert.throws(() => as(alice, () => store.orders.list("default")), /Order Management Space/);
});

test("Agent review/full access and stale previews share the real form and confirmation transaction", t => {
  const { store, as, admin, alice, body } = fixture(t);
  const operations = createAgentOperations(store);
  const actor = { type: "chat", id: store.agent.createSession(alice.id).id, name: "Assistant", userId: alice.id };
  const pending = as(alice, () => operations.run("create_order", body(), actor, "create"));
  assert.equal(pending.status, "pending");
  assert.equal(as(alice, () => store.orders.list()).length, 0);
  assert.equal(as(alice, () => store.listRecords(store.orders.tables().payments)).length, 0);
  const applied = as(alice, () => operations.approve(pending.id));
  assert.equal(applied.status, "applied");
  assert.equal(applied.result.paymentConfirmed, false);
  assert.equal(as(alice, () => store.listRecords(store.orders.tables().payments)).length, 1);
  assert.equal(as(alice, () => operations.run("create_order", body(), actor, "create")).id, pending.id);
  const order = applied.result;
  const edit = as(alice, () => operations.run("update_order", { orderId: order.id, version: order.version, notes: "Proposed" }, actor, "edit"));
  as(alice, () => store.orders.update(order.id, { version: order.version, notes: "Manual change" }));
  assert.throws(() => as(admin, () => operations.approve(edit.id)), { status: 409 });
  as(alice, () => operations.setMode("full"));
  assert.equal(as(alice, () => operations.run("create_order", body(), actor, "full")).status, "applied");
});

test("long order text and notes remain in shared fields without truncation", t => {
  const { store, as, alice, create } = fixture(t);
  const sourceText = "S".repeat(40000), notes = "N".repeat(10000);
  const order = create({ sourceText, notes });
  const record = as(alice, () => store.getRecord(order.id));
  assert.equal(record.values.sourceText, sourceText);
  assert.equal(record.values.notes, notes);
  assert.throws(() => create({ sourceText: `${sourceText}x` }), { status: 400 });
});

test("legacy migration preserves IDs, ownership, amounts, notes, ledger archive and invoice history without confirming payment", t => {
  const { store, as, admin, alice } = fixture(t);
  const id = randomUUID(), invoiceId = randomUUID(), timestamp = "2026-10-20T10:00:00.000Z";
  const file = store.files.upload({ spaceId: "default", file: { name: "source.pdf", data: Buffer.from("%PDF-source").toString("base64") } });
  const legacy = {
    customerName: "Legacy customer", fulfillment: "pickup", totalAmount: 17.8, notes: "Call on arrival",
    attachments: [file.id], items: [{ menuName: "Chicken rice", quantity: 2, unit: "portion", lineTotal: 17.8, notes: "No chilli" }],
    payments: [{ id: "old-payment", amount: 17.8, method: "Cash", reference: "OLD-1" }],
    invoices: [{ id: invoiceId, number: "INV-LEGACY", amount: 17.8, actor: "Old operator", createdAt: timestamp }],
    events: [{ id: "old-event", action: "created", message: "Order created", createdAt: timestamp }],
    notifications: [], outboundDocumentId: "obsolete-inventory-link",
  };
  store.database.prepare(`INSERT INTO customer_orders
    (id,space_id,created_by,number,status,data_json,version,created_at,updated_at) VALUES (?, 'default', ?, ?, 'draft', ?, 4, ?, ?)`)
    .run(id, alice.id, "ORD-20261020-0001", JSON.stringify(legacy), timestamp, timestamp);
  const before = as(admin, () => store.bootstrap(null, "default"));
  store.orders.migrate();
  const order = as(alice, () => store.orders.get(id));
  assert.equal(order.id, id);
  assert.equal(order.createdBy, alice.id);
  assert.equal(order.createdAt, timestamp);
  assert.equal(order.version, 5);
  assert.equal(order.totalAmount, 17.8);
  assert.equal(order.notes, "Call on arrival\nChicken rice x 2 portion (No chilli)");
  assert.equal(order.outboundDocumentId, undefined);
  assert.equal(order.paymentConfirmed, false);
  assert.deepEqual(order.legacy.payments, legacy.payments);
  assert.equal(order.legacy.originalData.outboundDocumentId, "obsolete-inventory-link");
  assert.equal(order.invoices[0].id, invoiceId);
  assert.deepEqual(order.events, legacy.events);
  assert.notEqual(order.attachments[0], file.id);
  assert.equal(store.files.get(order.attachments[0]).spaceId, ORDER_SPACE_ID);
  assert.equal(as(alice, () => store.getRecord(id)).values.number, order.number);
  assert.deepEqual(as(admin, () => store.bootstrap(null, "default")), before);
  store.orders.migrate();
  assert.equal(as(alice, () => store.orders.get(id)).version, 5);
  assert.equal(as(alice, () => store.listRecords(store.orders.tables().payments)).length, 1);
});

test("legacy number collisions preserve both orders and record the original number", t => {
  const { store, as, alice, create } = fixture(t);
  const existing = create(), id = randomUUID(), timestamp = "2026-10-20T10:00:00.000Z";
  store.database.prepare(`INSERT INTO customer_orders
    (id,space_id,created_by,number,status,data_json,created_at,updated_at) VALUES (?, 'default', ?, ?, 'draft', ?, ?, ?)`)
    .run(id, alice.id, existing.number, JSON.stringify({ customerName: "Legacy", fulfillment: "pickup", totalAmount: 10 }), timestamp, timestamp);
  store.orders.migrate();
  const migrated = as(alice, () => store.orders.get(id));
  assert.notEqual(migrated.number, existing.number);
  assert.equal(migrated.events.at(-1).previousNumber, existing.number);
  assert.equal(as(alice, () => store.orders.get(existing.id)).number, existing.number);
  assert.notEqual(create().number, migrated.number);
});
