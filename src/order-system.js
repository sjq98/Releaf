import { randomUUID, createHash } from "node:crypto";
import Decimal from "decimal.js";
import { AppError } from "./errors.js";
import { normalizeValues, validDate } from "./field-types.js";
import { createOrderAI } from "./order-ai.js";

export const ORDER_SPACE_ID = "order-management";
const MAX_AMOUNT = 1e12;
const STATUSES = ["draft", "accepted", "preparing", "ready", "dispatched", "completed", "cancelled"];
const ORDER_FIELDS = [
  "customerName", "customerPhone", "department", "salesperson", "fulfillment",
  "deliveryAddress", "estimatedDeliveryAt", "messageSentAt", "requestedTime", "notes", "sourceText", "attachments", "totalAmount", "reviewed",
];
const fail = (message, status = 400) => { throw new AppError(status, message); };
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const stable = value => JSON.stringify(value ?? null);
const now = () => new Date().toISOString();
const timeFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Singapore", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
function minute(value) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(value)) return value.slice(0, 16);
  const parts = Object.fromEntries(timeFormat.formatToParts(new Date(value)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
function dateTime(value, label) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?$/.test(value) ||
      !validDate(value.slice(0, 16), true) || Number.isNaN(Date.parse(value))) {
    fail(`Choose a valid ${label} date.`);
  }
  return minute(value);
}
export function whatsappOrderFields(source) {
  if (source?.channel !== "whatsapp") return {};
  const customerName = [source.chatName, source.sender, source.chatId]
    .find(value => typeof value === "string" && value.trim());
  return {
    customerName: customerName?.trim().slice(0, 200) || null,
    messageSentAt: dateTime(source.timestamp, "message sent"),
  };
}
const field = (id, name, type = "text", extra = {}) => ({ id, name, type, required: false, unique: false, options: [], ...extra });
const sum = values => values.reduce((total, value) => total.plus(value), new Decimal(0)).toDecimalPlaces(2).toNumber();

function amount(value, label = "Order amount", required = false) {
  if (value == null && !required) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_AMOUNT ||
      new Decimal(value).decimalPlaces() > 2) {
    fail(`${label} must be a non-negative number with up to two decimal places.`);
  }
  return value;
}

function text(value, label, limit = 200) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || value.trim().length > limit) fail(`${label} must contain up to ${limit} characters.`);
  return value.trim() || null;
}

function orderFields() {
  return [
    field("number", "Order number", "text", { required: true, unique: true }),
    field("status", "Order status", "select", { required: true, options: STATUSES }),
    field("customerName", "Customer", "text", { maxLength: 200 }),
    field("messageSentAt", "Message sent at", "datetime"),
    field("customerPhone", "Phone", "text", { maxLength: 80 }),
    field("department", "Department", "text", { maxLength: 200 }),
    field("salesperson", "Salesperson", "text", { maxLength: 200 }),
    field("fulfillment", "Fulfillment", "select", { options: ["pickup", "delivery"] }),
    field("deliveryAddress", "Delivery address", "longtext", { maxLength: 2000 }),
    field("requestedTime", "Requested time", "text", { maxLength: 500 }),
    field("estimatedDeliveryAt", "Estimated delivery", "datetime"),
    field("actualDeliveryAt", "Actual delivery time", "datetime"),
    field("totalAmount", "Order amount (MYR)", "number"),
    field("reviewed", "Order reviewed", "checkbox"),
    field("paymentConfirmed", "Payment fully received", "checkbox"),
    field("notes", "Notes", "longtext", { maxLength: 10000 }),
    field("sourceText", "Customer message", "longtext", { maxLength: 40000 }),
    field("attachments", "Attachments", "attachment"),
    field("createdBy", "Created by"),
  ];
}

const CORE_FIELDS = {
  orders: orderFields().map(field => field.id),
  payments: ["number", "order", "totalAmount", "method", "confirmed", "confirmedBy", "confirmedAt", "notes", "createdBy"],
  invoices: ["number", "order", "amount", "note", "createdBy", "recordedBy"],
};

export function createOrderSystem({ db, store }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS customer_orders (
      id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id),
      created_by TEXT, number TEXT NOT NULL, status TEXT NOT NULL,
      data_json TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(space_id, number)
    );
    CREATE TABLE IF NOT EXISTS order_sequences (
      space_id TEXT NOT NULL REFERENCES spaces(id), day TEXT NOT NULL, value INTEGER NOT NULL,
      PRIMARY KEY(space_id, day)
    );
    CREATE TABLE IF NOT EXISTS order_forms (
      space_id TEXT NOT NULL REFERENCES spaces(id), role TEXT NOT NULL,
      form_id TEXT NOT NULL UNIQUE REFERENCES forms(id), PRIMARY KEY(space_id, role)
    );
    CREATE TABLE IF NOT EXISTS order_details (
      order_id TEXT PRIMARY KEY REFERENCES records(id), events_json TEXT NOT NULL DEFAULT '[]',
      notifications_json TEXT NOT NULL DEFAULT '[]', source_json TEXT, legacy_json TEXT
    );
    CREATE TABLE IF NOT EXISTS order_intake_sources (
      source_key TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES records(id), created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS order_migrations (
      legacy_id TEXT PRIMARY KEY, migrated_at TEXT NOT NULL
    );
  `);
  let ai, permit = null, synchronizing = 0;
  const user = () => store.auth.currentUser();
  const actor = () => user()?.username ?? "System";
  const roleOf = formId => db.prepare("SELECT role FROM order_forms WHERE form_id = ?").get(formId)?.role;
  const tables = (spaceId = ORDER_SPACE_ID) => Object.fromEntries(db.prepare("SELECT role, form_id FROM order_forms WHERE space_id = ?").all(spaceId)
    .map(row => [row.role, row.form_id]));
  const table = role => {
    const id = tables()[role];
    if (!id) fail("Order forms are not initialized.", 503);
    return store.getForm(id);
  };
  const space = (id = ORDER_SPACE_ID) => {
    store.spaces.get(id);
    if (id !== ORDER_SPACE_ID) fail("Choose the Order Management Space.");
    return id;
  };
  const editable = order => ["draft", "accepted"].includes(order.status);
  const isVisible = (formId, values) => !roleOf(formId) || !user() || user().role === "admin" || values.createdBy === user().id;
  const raw = id => {
    const row = db.prepare("SELECT * FROM records WHERE id = ? AND deleted_at IS NULL").get(id);
    if (!row || !roleOf(row.form_id)) fail("Order record not found.", 404);
    const values = JSON.parse(row.values_json);
    if (!isVisible(row.form_id, values)) fail("Order record not found.", 404);
    return { id: row.id, formId: row.form_id, values, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at };
  };
  const orderRecord = id => {
    if (typeof id !== "string" || !id) fail("Choose an order record.");
    const record = raw(id);
    if (roleOf(record.formId) !== "orders") fail("Order not found.", 404);
    return record;
  };
  function details(id) {
    const row = db.prepare("SELECT * FROM order_details WHERE order_id = ?").get(id);
    return {
      events: row ? JSON.parse(row.events_json) : [],
      notifications: row ? JSON.parse(row.notifications_json) : [],
      source: row?.source_json ? JSON.parse(row.source_json) : null,
      legacy: row?.legacy_json ? JSON.parse(row.legacy_json) : null,
    };
  }
  function saveDetails(id, data) {
    db.prepare(`INSERT INTO order_details (order_id, events_json, notifications_json, source_json, legacy_json)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(order_id) DO UPDATE SET events_json = excluded.events_json,
      notifications_json = excluded.notifications_json, source_json = excluded.source_json, legacy_json = excluded.legacy_json`)
      .run(id, JSON.stringify(data.events ?? []), JSON.stringify(data.notifications ?? []),
        data.source ? JSON.stringify(data.source) : null, data.legacy ? JSON.stringify(data.legacy) : null);
  }
  function event(id, action, message, extra = {}) {
    const data = details(id);
    data.events.push({ id: randomUUID(), action, message, actor: actor(), createdAt: now(), ...extra });
    saveDetails(id, data);
  }
  const associated = (role, id) => store.listRecords(table(role).id).filter(record => record.values.order === id);
  const paymentFor = id => associated("payments", id)[0] ?? null;
  function permitted(access, callback) {
    const previous = permit;
    permit = access;
    try { return callback(); } finally { permit = previous; }
  }
  const insert = (role, values) => {
    const form = table(role);
    return permitted({ formId: form.id, creating: true }, () =>
      store.createRecord(form.id, { schemaVersion: form.version, values }).record);
  };
  const updateRecord = (id, values) => {
    const record = raw(id), form = store.getForm(record.formId);
    return permitted({ recordId: id }, () =>
      store.updateRecord(id, { schemaVersion: form.version, version: record.version, values }).record);
  };
  function touchOrder(id) {
    db.prepare("UPDATE records SET version = version + 1, updated_at = ? WHERE id = ?").run(now(), id);
  }
  function nextNumber() {
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Singapore", year: "numeric", month: "2-digit", day: "2-digit" })
      .format(new Date()).replaceAll("-", "");
    let number;
    do {
      db.prepare(`INSERT INTO order_sequences VALUES (?, ?, 1)
        ON CONFLICT(space_id, day) DO UPDATE SET value = value + 1`).run(ORDER_SPACE_ID, day);
      const sequence = db.prepare("SELECT value FROM order_sequences WHERE space_id = ? AND day = ?").get(ORDER_SPACE_ID, day).value;
      number = `ORD-${day}-${String(sequence).padStart(4, "0")}`;
    } while (db.prepare("SELECT 1 FROM unique_values WHERE form_id = ? AND field_id = 'number' AND value_key = ?")
      .get(table("orders").id, `string:${number.toLowerCase()}`));
    return number;
  }
  function reviewable(values) {
    if (!values.customerName) fail("Customer name is required before reviewing an order.");
    amount(values.totalAmount, "Order amount", true);
    if (!["pickup", "delivery"].includes(values.fulfillment)) fail("Choose pickup or delivery before reviewing an order.");
    if (values.fulfillment === "delivery" && !values.deliveryAddress) fail("Delivery address is required for delivery orders.");
  }
  function actions(order) {
    const next = {
      draft: ["accept", "cancel"], accepted: ["prepare", "cancel"], preparing: ["ready"],
      ready: [order.fulfillment === "delivery" ? "dispatch" : "complete"],
      dispatched: ["complete"], completed: [], cancelled: [],
    }[order.status] ?? [];
    return next.filter(action => (action === "cancel" || order.reviewed) &&
      (action !== "cancel" || !order.paymentConfirmed && !order.invoices.length));
  }
  function get(id) {
    const record = orderRecord(id), data = details(id), payment = paymentFor(id);
    const invoices = associated("invoices", id).map(entry => ({
      id: entry.id, version: entry.version, ...entry.values, createdAt: entry.createdAt, actor: entry.values.recordedBy,
    }));
    const invoicedAmount = sum(invoices.map(entry => entry.amount));
    const order = {
      ...record.values, id: record.id, formId: record.formId, spaceId: ORDER_SPACE_ID, version: record.version,
      createdAt: record.createdAt, updatedAt: record.updatedAt, ...data, invoices,
      paymentConfirmed: Boolean(payment?.values.confirmed),
      paymentConfirmation: payment ? { id: payment.id, version: payment.version, ...payment.values } : null,
      invoicedAmount,
      uninvoicedAmount: record.values.totalAmount == null ? null : new Decimal(record.values.totalAmount).minus(invoicedAmount).toNumber(),
    };
    return { ...order, allowedActions: actions(order), canEdit: editable(order),
      canDelete: (!user() || user().role === "admin") && order.status === "draft" && !order.paymentConfirmed && !invoices.length,
      canConfirmPayment: order.status !== "cancelled" && Boolean(order.reviewed) && order.totalAmount != null,
      canInvoice: order.status !== "cancelled" && Boolean(order.reviewed) && order.totalAmount != null && order.uninvoicedAmount > 0 };
  }
  function list(spaceId = ORDER_SPACE_ID) {
    space(spaceId);
    return store.listRecords(table("orders").id).filter(record => isVisible(record.formId, record.values)).map(record => get(record.id));
  }
  function current(id, body) {
    const order = get(id);
    if (!object(body) || !Number.isInteger(body.version) || body.version !== order.version) fail("This order changed. Reload it and try again.", 409);
    return order;
  }
  function fields(body) {
    if (!object(body) || Object.keys(body).some(key => ![...ORDER_FIELDS, "spaceId", "version"].includes(key))) {
      fail("Change order details through their supported fields and workflow actions.");
    }
    const values = {};
    for (const key of ORDER_FIELDS) if (Object.hasOwn(body, key)) values[key] = body[key];
    for (const [key, limit] of [["customerName", 200], ["customerPhone", 80], ["department", 200], ["salesperson", 200],
      ["deliveryAddress", 2000], ["requestedTime", 500], ["notes", 10000], ["sourceText", 40000]]) {
      if (Object.hasOwn(values, key)) values[key] = text(values[key], key, limit);
    }
    if (Object.hasOwn(values, "totalAmount")) values.totalAmount = amount(values.totalAmount);
    if (Object.hasOwn(values, "reviewed") && typeof values.reviewed !== "boolean") fail("Order review must be true or false.");
    for (const [key, label] of [["estimatedDeliveryAt", "estimated delivery"], ["messageSentAt", "message sent"]]) {
      if (Object.hasOwn(values, key)) values[key] = dateTime(values[key], label);
    }
    if (values.attachments && (!Array.isArray(values.attachments) || values.attachments.length > 10 ||
        new Set(values.attachments).size !== values.attachments.length)) fail("Choose up to 10 distinct uploaded attachments.");
    return values;
  }
  function create(body) {
    return store.transaction(() => { space(body?.spaceId); return get(insert("orders", fields(body)).id); });
  }
  function update(id, body) {
    return store.transaction(() => {
      const order = current(id, body);
      if (!editable(order)) fail("Only draft or accepted orders can be edited.", 409);
      if (body.spaceId !== undefined && body.spaceId !== ORDER_SPACE_ID) fail("An order cannot move to another Space.");
      updateRecord(id, fields(body));
      return get(id);
    });
  }
  function transition(id, body) {
    return store.transaction(() => {
      const order = current(id, body);
      if (!order.allowedActions.includes(body.action)) fail("This action is not available in the current order status.", 409);
      if (body.action !== "cancel") reviewable(order);
      const status = { accept: "accepted", prepare: "preparing", ready: "ready", dispatch: "dispatched", complete: "completed", cancel: "cancelled" }[body.action];
      updateRecord(id, { status, ...(status === "completed" ? { actualDeliveryAt: minute(now()) } : {}) });
      event(id, body.action, `${order.status} -> ${status}`, { fromStatus: order.status, toStatus: status });
      return get(id);
    });
  }
  function confirmPayment(id, body) {
    return store.transaction(() => {
      const order = current(id, body);
      if (typeof body.confirmed !== "boolean") fail("Payment confirmation must be true or false.");
      if (order.status === "cancelled") fail("Cancelled orders cannot confirm payment.", 409);
      if (body.confirmed) {
        if (!order.reviewed) fail("Review the order before confirming payment.", 409);
        reviewable(order);
      }
      const payment = paymentFor(id);
      if (!payment) fail("This order has no payment confirmation.", 409);
      if (Boolean(payment.values.confirmed) === body.confirmed) return order;
      updateRecord(payment.id, { confirmed: body.confirmed });
      return get(id);
    });
  }
  function invoice(id, body) {
    return store.transaction(() => {
      const order = current(id, body);
      if (order.status === "cancelled") fail("Cancelled orders cannot receive invoices.", 409);
      if (!order.reviewed) fail("Review the order before recording an invoice.", 409);
      reviewable(order);
      const invoiceAmount = amount(body.amount, "Invoice amount", true);
      if (invoiceAmount <= 0) fail("Invoice amount must be positive.");
      const number = text(body.number, "Invoice number", 200);
      if (!number) fail("Invoice number is required.");
      insert("invoices", { order: id, number, amount: invoiceAmount, note: text(body.note, "Note", 2000) });
      return get(id);
    });
  }
  function notification(id, body) {
    return store.transaction(() => {
      const order = current(id, body), data = details(id);
      const labels = { draft: "awaiting human review", accepted: "confirmed", preparing: "being prepared",
        ready: order.fulfillment === "pickup" ? "ready for pickup" : "ready for dispatch", dispatched: "out for delivery",
        completed: "completed", cancelled: "cancelled" };
      const entry = { id: randomUUID(), message: `Hi ${order.customerName || "there"}, your order ${order.number} is ${labels[order.status]}.`,
        createdAt: now(), status: "prepared", channel: "local", actor: actor() };
      data.notifications.push(entry); saveDetails(id, data);
      event(id, "notification_prepared", "Customer status message prepared"); touchOrder(id);
      return entry;
    });
  }
  function prepare(form, input, previous, id, creating) {
    const role = roleOf(form.id);
    if (!role) return input;
    if (!object(input)) fail("Record values must be a JSON object.");
    const access = Boolean(permit && (creating ? permit.formId === form.id : permit.recordId === id));
    if (!access) store.auth.requireAdmin();
    const values = { ...input };
    const protectedFields = role === "orders" ? ["number", "status", "actualDeliveryAt", "paymentConfirmed", "createdBy"]
      : role === "payments" ? ["number", "order", "totalAmount", "confirmedBy", "confirmedAt", "createdBy"] : ["createdBy", "recordedBy"];
    if (!access && !creating) for (const key of protectedFields) {
      if (Object.hasOwn(input, key) && stable(input[key]) !== stable(previous[key])) fail("Use the order workflow to change managed fields.", 409);
    }
    if (role === "orders") {
      if (Object.hasOwn(input, "reviewed") && typeof input.reviewed !== "boolean") fail("Order review must be true or false.");
      if (creating) {
        values.number = nextNumber(); values.status = "draft"; values.createdBy = user()?.id ?? null;
        values.reviewed = Boolean(input.reviewed); values.paymentConfirmed = false; values.actualDeliveryAt = null;
        values.salesperson ??= actor();
      } else {
        if (!access && !editable({ status: previous.status })) {
          if (orderFields().some(field => Object.hasOwn(input, field.id) && stable(input[field.id]) !== stable(previous[field.id]))) {
            fail("Only draft or accepted orders can be edited.", 409);
          }
        }
        const detailKeys = ORDER_FIELDS.filter(key => key !== "reviewed" && key !== "sourceText");
        if (!Object.hasOwn(input, "reviewed") && detailKeys.some(key => Object.hasOwn(input, key) && stable(input[key]) !== stable(previous[key]))) values.reviewed = false;
        if (Object.hasOwn(input, "totalAmount") && stable(input.totalAmount) !== stable(previous.totalAmount)) values.paymentConfirmed = false;
      }
    } else if (role === "payments") {
      const parent = orderRecord(creating ? values.order : previous.order);
      if (creating) {
        values.number = `PAY-${parent.values.number}`; values.createdBy = parent.values.createdBy;
        values.totalAmount = parent.values.totalAmount; values.confirmed = false; values.method = "E-wallet";
        values.confirmedBy = null; values.confirmedAt = null;
      } else if (Object.hasOwn(input, "confirmed") && Boolean(input.confirmed) !== Boolean(previous.confirmed)) {
        if (typeof input.confirmed !== "boolean") fail("Payment confirmation must be true or false.");
        if (parent.values.status === "cancelled") fail("Cancelled orders cannot confirm payment.", 409);
        if (input.confirmed) {
          if (!parent.values.reviewed) fail("Review the order before confirming payment.", 409);
          reviewable(parent.values);
        }
        values.confirmedBy = input.confirmed ? actor() : null; values.confirmedAt = input.confirmed ? minute(now()) : null;
      }
    } else {
      const parent = orderRecord(values.order ?? previous?.order);
      if (creating) { values.createdBy = parent.values.createdBy; values.recordedBy = actor(); }
      else if (Object.hasOwn(input, "order") && input.order !== previous.order) fail("An invoice cannot move to another order.", 409);
    }
    return values;
  }
  function validateRecord(form, previous, values, id) {
    const role = roleOf(form.id);
    if (!role) return;
    if (role === "orders") {
      amount(values.totalAmount);
      if (values.reviewed) reviewable(values);
      if (!STATUSES.includes(values.status)) fail("Choose a valid order status.");
      if (values.fulfillment != null && !["pickup", "delivery"].includes(values.fulfillment)) fail("Choose pickup or delivery.");
      const invoices = associated("invoices", id);
      if (invoices.length && (values.totalAmount == null || new Decimal(sum(invoices.map(record => record.values.amount))).gt(values.totalAmount))) {
        fail("The order total cannot be below its recorded invoices.");
      }
    } else {
      const parent = orderRecord(values.order);
      if (values.createdBy !== parent.values.createdBy) fail("Order record ownership cannot be changed.", 409);
      if (role === "payments") {
        if (stable(values.totalAmount) !== stable(parent.values.totalAmount)) fail("The payment amount follows its order.", 409);
        if (values.confirmed) {
          if (!parent.values.reviewed) fail("Review the order before confirming payment.", 409);
          reviewable(parent.values);
          if (!values.confirmedBy || !values.confirmedAt) fail("Payment confirmation needs a recorded confirmer and time.");
        } else if (values.confirmedBy || values.confirmedAt) fail("Unconfirmed payments cannot have confirmation details.");
      } else {
        if (!parent.values.reviewed) fail("Review the order before recording an invoice.", 409);
        reviewable(parent.values);
        if (parent.values.status === "cancelled") fail("Cancelled orders cannot receive invoices.", 409);
        const value = amount(values.amount, "Invoice amount", true);
        if (!values.number || value <= 0) fail("Enter a positive amount and invoice number.");
        const peers = associated("invoices", parent.id).filter(record => record.id !== id);
        if (peers.some(record => record.values.number.toLowerCase() === values.number.toLowerCase())) fail("This invoice number is already recorded.", 409);
        if (new Decimal(sum(peers.map(record => record.values.amount))).plus(value).gt(parent.values.totalAmount)) fail("Invoice amount exceeds the uninvoiced balance.");
      }
    }
  }
  function afterWrite(form, record, kind, previous) {
    const role = roleOf(form.id);
    if (!role) return;
    if (role === "orders") {
      if (kind === "created") {
        saveDetails(record.id, { events: [], notifications: [] }); event(record.id, "created", "Order created");
        insert("payments", { order: record.id });
      } else if (kind === "updated") {
        const before = previous?.values ?? previous ?? {};
        const payment = paymentFor(record.id);
        if (payment && stable(payment.values.totalAmount) !== stable(record.values.totalAmount)) {
          synchronizing++;
          try { updateRecord(payment.id, { totalAmount: record.values.totalAmount, confirmed: false, confirmedBy: null, confirmedAt: null }); }
          finally { synchronizing--; }
          if (payment.values.confirmed) event(record.id, "payment_recheck_required", "Order amount changed; payment confirmation was cleared");
        }
        if (before.reviewed !== record.values.reviewed) event(record.id, record.values.reviewed ? "reviewed" : "review_required",
          record.values.reviewed ? "Order reviewed" : "Order requires review");
        else event(record.id, "updated", "Order details updated");
      } else event(record.id, "deleted", "Draft order deleted");
    } else if (!synchronizing) {
      const parentId = record.values.order;
      if (role === "payments") {
        const before = previous?.values ?? previous ?? {};
        if (kind === "updated" && Boolean(before.confirmed) !== Boolean(record.values.confirmed)) {
          synchronizing++;
          try { updateRecord(parentId, { paymentConfirmed: Boolean(record.values.confirmed) }); }
          finally { synchronizing--; }
          event(parentId, record.values.confirmed ? "payment_confirmed" : "payment_confirmation_cleared",
            record.values.confirmed ? "Payment confirmed fully received" : "Payment confirmation cleared");
        }
      } else {
        event(parentId, kind === "created" ? "invoice" : `invoice_${kind}`, kind === "created" ? "Invoice recorded" : `Invoice ${kind}`, { invoiceId: record.id });
        touchOrder(parentId);
      }
    }
  }
  function assertSchema(form, fields) {
    if (!roleOf(form.id)) return;
    store.auth.requireAdmin();
    if (!fields) return;
    const core = CORE_FIELDS[roleOf(form.id)];
    for (const id of core) {
      const before = form.fields.find(field => field.id === id), after = fields.find(field => field.id === id);
      if (!before || !after || ["type", "required", "unique", "options", "reference", "formula", "maxLength"].some(key => stable(before[key]) !== stable(after[key]))) {
        fail("Core order fields may be renamed or reordered, but their types and business constraints cannot be changed.", 409);
      }
    }
  }
  function assertDelete(record) {
    const role = roleOf(record.formId);
    if (!role) return;
    if (permit?.deleting === record.id) return;
    store.auth.requireAdmin();
    if (role === "payments") fail("Payment confirmations belong to their orders and cannot be deleted separately.", 409);
    if (role === "orders") {
      const order = get(record.id);
      if (order.status !== "draft" || order.paymentConfirmed || order.invoices.length) fail("Only an unpaid draft without invoices can be deleted.", 409);
      const payment = paymentFor(record.id);
      if (payment) permitted({ deleting: payment.id }, () => store.deleteRecord(payment.id, { version: payment.version }));
    }
  }
  function directInsert(form, id, values, version, createdAt, updatedAt) {
    const normalized = normalizeValues(values, form.fields, {}, true);
    db.prepare("INSERT INTO records (id, form_id, values_json, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, form.id, JSON.stringify(normalized), version, createdAt, updatedAt);
    for (const field of form.fields.filter(field => field.unique && normalized[field.id] != null)) {
      db.prepare("INSERT INTO unique_values (form_id, field_id, value_key, record_id) VALUES (?, ?, ?, ?)")
        .run(form.id, field.id, `${typeof normalized[field.id]}:${typeof normalized[field.id] === "string" ? normalized[field.id].toLowerCase() : normalized[field.id]}`, id);
    }
    return { id, formId: form.id, values: normalized, version, createdAt, updatedAt };
  }
  function migrate() {
    if (store.spaces.wasDeleted(ORDER_SPACE_ID)) return {};
    return store.transaction(() => {
      db.prepare("INSERT OR IGNORE INTO spaces VALUES (?, ?)").run(ORDER_SPACE_ID, "Order management");
      const create = (role, name, fields) => {
        if (tables()[role]) return table(role);
        const form = store.createForm({ name, spaceId: ORDER_SPACE_ID, moduleId: "custom", parentId: null, fields });
        db.prepare("INSERT INTO order_forms VALUES (?, ?, ?)").run(ORDER_SPACE_ID, role, form.id);
        return form;
      };
      let orders = create("orders", "Orders", orderFields());
      if (!orders.fields.some(field => field.id === "messageSentAt")) {
        const fields = [...orders.fields, orderFields().find(field => field.id === "messageSentAt")];
        db.prepare("UPDATE forms SET fields_json = ?, version = version + 1, updated_at = ? WHERE id = ?")
          .run(JSON.stringify(fields), now(), orders.id);
        orders = table("orders");
      }
      const orderReference = { formId: orders.id, fieldId: "number" };
      const payments = create("payments", "Payment confirmations", [
        field("number", "Payment confirmation number", "text", { required: true, unique: true }),
        field("order", "Order number", "reference", { required: true, unique: true, reference: orderReference }),
        field("totalAmount", "Order amount (MYR)", "number"), field("method", "Payment method"),
        field("confirmed", "Payment fully received", "checkbox"), field("confirmedBy", "Confirmed by"),
        field("confirmedAt", "Confirmed at", "datetime"), field("notes", "Notes", "longtext"), field("createdBy", "Created by"),
      ]);
      const invoices = create("invoices", "Invoices", [
        field("number", "Invoice number", "text", { required: true }),
        field("order", "Order number", "reference", { required: true, reference: orderReference }),
        field("amount", "Invoice amount (MYR)", "number", { required: true }),
        field("note", "Notes", "longtext"), field("createdBy", "Created by"), field("recordedBy", "Recorded by"),
      ]);
      db.prepare(`INSERT INTO order_sequences (space_id, day, value)
        SELECT ?, day, value FROM order_sequences WHERE space_id = 'default'
        ON CONFLICT(space_id, day) DO UPDATE SET value = MAX(order_sequences.value, excluded.value)`).run(ORDER_SPACE_ID);
      const copiedAttachments = new Map();
      for (const row of db.prepare(`SELECT * FROM customer_orders
        WHERE id NOT IN (SELECT legacy_id FROM order_migrations) ORDER BY created_at, rowid`).all()) {
        if (!["default", ORDER_SPACE_ID].includes(row.space_id)) continue;
        if (db.prepare("SELECT id FROM records WHERE id = ?").get(row.id)) fail("An existing record conflicts with a legacy order ID.", 409);
        const data = JSON.parse(row.data_json), values = {};
        for (const key of ORDER_FIELDS.filter(key => key !== "reviewed")) if (Object.hasOwn(data, key)) values[key] = data[key];
        if (Array.isArray(data.items) && data.items.length) {
          const description = data.items.map(item =>
            `${item.menuName ?? item.productName ?? item.menuCode ?? ""} x ${item.quantity} ${item.unit ?? ""}${item.notes ? ` (${item.notes})` : ""}`.trim()).join("\n");
          values.notes = [values.notes, description].filter(Boolean).join("\n");
        }
        values.totalAmount ??= Array.isArray(data.items) && data.items.length ? sum(data.items.map(item => item.lineTotal ?? 0)) : null;
        values.number = row.number; values.status = row.status; values.createdBy = row.created_by;
        values.reviewed = values.totalAmount != null && Boolean(values.customerName && values.fulfillment && (values.fulfillment !== "delivery" || values.deliveryAddress));
        values.paymentConfirmed = false; values.actualDeliveryAt = minute(data.actualDeliveryAt);
        values.estimatedDeliveryAt = minute(values.estimatedDeliveryAt);
        values.messageSentAt = dateTime(values.messageSentAt, "message sent");
        const events = [...(data.events ?? [])];
        if (db.prepare("SELECT 1 FROM unique_values WHERE form_id = ? AND field_id = 'number' AND value_key = ?").get(orders.id, `string:${values.number.toLowerCase()}`)) {
          const previousNumber = values.number; values.number = nextNumber();
          events.push({ id: randomUUID(), action: "space_migration", actor: "System", createdAt: now(), previousNumber,
            message: `Order number changed from ${previousNumber} to ${values.number} during migration.` });
        }
        values.attachments = (values.attachments ?? []).map(id => {
          const file = store.files.get(id);
          if (file.spaceId === ORDER_SPACE_ID) return id;
          if (copiedAttachments.has(id)) return copiedAttachments.get(id);
          const copy = randomUUID();
          db.prepare(`INSERT INTO attachments (id, space_id, name, mime, bytes, images_json, created_at)
            SELECT ?, ?, name, mime, bytes, images_json, created_at FROM attachments WHERE id = ?`).run(copy, ORDER_SPACE_ID, id);
          copiedAttachments.set(id, copy); return copy;
        });
        directInsert(orders, row.id, values, row.version + (row.space_id === "default" ? 1 : 0), row.created_at, row.updated_at);
        saveDetails(row.id, { events, notifications: data.notifications ?? [], source: data.source ?? null,
          legacy: { payments: data.payments ?? [], originalData: data } });
        directInsert(payments, randomUUID(), { number: `PAY-${values.number}`, order: row.id, totalAmount: values.totalAmount,
          method: "E-wallet", confirmed: false, createdBy: values.createdBy }, 1, row.created_at, row.updated_at);
        for (const entry of data.invoices ?? []) {
          directInsert(invoices, entry.id ?? randomUUID(), { number: entry.number, order: row.id, amount: entry.amount,
            note: entry.note ?? null, createdBy: values.createdBy, recordedBy: entry.actor ?? "System" },
          1, entry.createdAt ?? row.created_at, entry.createdAt ?? row.updated_at);
        }
        db.prepare("INSERT INTO order_migrations VALUES (?, ?)").run(row.id, now());
      }
      for (const row of db.prepare(`SELECT r.id, r.values_json, d.source_json FROM records r
        JOIN order_details d ON d.order_id = r.id
        WHERE r.form_id = ? AND r.deleted_at IS NULL AND d.source_json IS NOT NULL`).all(orders.id)) {
        const values = JSON.parse(row.values_json), source = JSON.parse(row.source_json);
        if ((values.messageSentAt != null && values.messageSentAt !== "") || source?.channel !== "whatsapp") continue;
        let messageSentAt;
        try { messageSentAt = whatsappOrderFields(source).messageSentAt; }
        catch (error) { if (error instanceof AppError) continue; throw error; }
        if (messageSentAt == null) continue;
        db.prepare("UPDATE records SET values_json = ?, version = version + 1, updated_at = ? WHERE id = ?")
          .run(JSON.stringify({ ...values, messageSentAt }), now(), row.id);
      }
      return tables();
    });
  }
  function sourceKey(source) {
    if (!object(source) || typeof source.channel !== "string" || !source.channel ||
        typeof source.chatId !== "string" || !source.chatId || typeof source.messageId !== "string" || !source.messageId ||
        [source.channel, source.accountId, source.chatId, source.messageId].some(value => value != null && (typeof value !== "string" || value.length > 500))) {
      fail("An imported message needs stable channel, chat and message IDs.");
    }
    return createHash("sha256").update(JSON.stringify([source.channel, source.accountId ?? null, source.chatId, source.messageId])).digest("hex");
  }
  function findSource(source) {
    const row = db.prepare(`SELECT s.order_id FROM order_intake_sources s
      JOIN records r ON r.id = s.order_id
      WHERE s.source_key = ? AND r.deleted_at IS NULL`).get(sourceKey(source));
    return row ? get(row.order_id) : null;
  }
  function importExtracted({ draft, source, text: sourceText, customerName, customerPhone } = {}, { deduplicateSource = true } = {}) {
    const key = source ? sourceKey(source) : null;
    return store.transaction(() => {
      const existing = source && deduplicateSource ? findSource(source) : null;
      if (existing) return { ...existing, intakeDuplicate: true };
      if (!object(draft) || draft.isOrder !== true) return { skipped: true, reason: "not_an_order" };
      const body = {};
      for (const name of ORDER_FIELDS) if (Object.hasOwn(draft, name)) body[name] = draft[name];
      body.customerName ??= customerName ?? null; body.customerPhone ??= customerPhone ?? null;
      Object.assign(body, whatsappOrderFields(source));
      if (sourceText !== undefined) body.sourceText = sourceText;
      body.totalAmount = null; body.reviewed = false;
      const order = create(body);
      const data = details(order.id); data.source = source ? structuredClone(source) : null; saveDetails(order.id, data);
      if (key) db.prepare(`INSERT INTO order_intake_sources VALUES (?, ?, ?)
        ON CONFLICT(source_key) DO UPDATE SET order_id = excluded.order_id, created_at = excluded.created_at`)
        .run(key, order.id, now());
      event(order.id, "imported", "Customer message imported for human review");
      return get(order.id);
    });
  }
  function state(spaceId = ORDER_SPACE_ID) {
    store.spaces.get(spaceId);
    if (spaceId !== ORDER_SPACE_ID) return { enabled: false, spaceId: ORDER_SPACE_ID, orders: [], tables: {} };
    const orders = list(spaceId);
    const managedFields = {
      orders: ["number", "status", "actualDeliveryAt", "paymentConfirmed", "createdBy"],
      payments: ["number", "order", "totalAmount", "confirmedBy", "confirmedAt", "createdBy"],
      invoices: ["order", "createdBy", "recordedBy"],
    };
    return { enabled: true, spaceId, tables: tables(spaceId), coreFields: CORE_FIELDS, managedFields, orders, statuses: STATUSES, currency: "MYR",
      summary: { total: orders.length, active: orders.filter(order => !["completed", "cancelled"].includes(order.status)).length,
        totalAmount: sum(orders.filter(order => order.status !== "cancelled").map(order => order.totalAmount ?? 0)),
        pendingReview: orders.filter(order => !order.reviewed && order.status !== "cancelled").length,
        paymentConfirmed: orders.filter(order => order.paymentConfirmed).length,
        paymentPending: orders.filter(order => !order.paymentConfirmed && order.status !== "cancelled").length } };
  }
  return {
    roleOf, tables, isVisible, prepare, validateRecord, afterWrite, assertSchema, assertDelete, migrate,
    state, list, get, create, update, transition, confirmPayment, invoice, notification,
    payment() { fail("Per-payment amount registration has been replaced by full-payment confirmation.", 410); },
    configure(options) { ai = createOrderAI(options); },
    async extract({ spaceId = ORDER_SPACE_ID, text }) {
      space(spaceId);
      if (!ai) fail("AI is not configured. Open AI settings to connect a provider.", 503);
      return ai.extract({ text });
    },
    findSource, importExtracted,
    async intake({ text, source, customerName, customerPhone, spaceId = ORDER_SPACE_ID } = {}) {
      space(spaceId);
      if (source) { const existing = findSource(source); if (existing) return { ...existing, intakeDuplicate: true }; }
      const draft = await this.extract({ spaceId, text });
      return importExtracted({ draft, source, text, customerName, customerPhone });
    },
    fingerprint(spaceId = ORDER_SPACE_ID) {
      if (spaceId !== ORDER_SPACE_ID) return { orders: [] };
      return {
        forms: db.prepare("SELECT * FROM order_forms ORDER BY role").all(),
        records: db.prepare("SELECT * FROM records WHERE form_id IN (SELECT form_id FROM order_forms) ORDER BY id").all(),
        details: db.prepare("SELECT * FROM order_details ORDER BY order_id").all(),
        sources: db.prepare("SELECT * FROM order_intake_sources ORDER BY source_key").all(),
      };
    },
  };
}
