import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { AppError } from "./errors.js";
import { inventoryQuantity } from "./inventory-repository.js";

const D = Decimal.clone({ precision: 40 });
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const field = (id, name, type = "text", extra = {}) => ({ id, name, type, required: true, unique: false, options: [], ...extra });
const ref = (id, name, form, key) => field(id, name, "reference", { reference: { formId: form.id, fieldId: key } });
const label = (form, record) => String(record.values[form.fields.find((item) => item.unique)?.id] ?? record.id);

export function createInventoryModule(store) {
  const repo = store.inventory;
  function ensureTables() {
    return store.transaction(() => {
      const ids = repo.tables(), forms = {};
      const ensure = (role, name, fields) => {
        forms[role] = ids[role] ? store.getForm(ids[role]) : store.createForm({ name, moduleId: "inventory", fields });
        if (!ids[role]) repo.setTable(role, forms[role].id);
      };
      ensure("materials", "Materials", [
        field("sku", "Material SKU", "text", { unique: true }), field("name", "Material name"),
        field("unit", "Stock unit"), field("reorderLevel", "Reorder level", "number", { required: false }),
        field("notes", "Notes", "longtext", { required: false }),
      ]);
      ensure("products", "Products", [
        field("productCode", "Product code", "text", { unique: true }), field("name", "Product name"),
        field("notes", "Notes", "longtext", { required: false }),
      ]);
      ensure("recipes", "Recipes", [
        ref("product", "Product", forms.products, "productCode"), ref("material", "Material", forms.materials, "sku"),
        field("quantityPerUnit", "Quantity per product", "number"),
      ]);
      ensure("purchases", "Purchases", [
        field("purchaseNumber", "Purchase line number", "text", { unique: true }),
        ref("material", "Material", forms.materials, "sku"), field("quantity", "Quantity", "number"),
        field("supplier", "Supplier", "text", { required: false }),
        field("receivedAt", "Received date", "date", { required: false }),
        field("notes", "Notes", "longtext", { required: false }),
      ]);
      for (const form of store.listForms().filter((item) => item.moduleId === "orders")) {
        if (!repo.mappings().some((item) => item.formId === form.id) &&
            form.fields.some((item) => item.id === "item" && item.type === "text") &&
            form.fields.some((item) => item.id === "quantity" && item.type === "number")) {
          repo.saveMapping(form.id, { itemField: "item", quantityField: "quantity" });
        }
      }
      return forms;
    });
  }
  function forms() {
    const ids = repo.tables();
    if (Object.keys(ids).length !== 4) throw new AppError(400, "Open Inventory Management to set up its tables first.");
    return Object.fromEntries(Object.entries(ids).map(([role, id]) => [role, store.getForm(id)]));
  }
  function saveMapping(body) {
    return store.transaction(() => {
      if (typeof body?.formId !== "string" || !/^[a-zA-Z0-9-]{1,64}$/.test(body.formId)) {
        throw new AppError(400, "Choose an existing order table.");
      }
      const configured = forms(), form = store.getForm(body?.formId);
      const item = form.fields.find((field) => field.id === body.itemField);
      const quantity = form.fields.find((field) => field.id === body.quantityField);
      if (form.moduleId !== "orders" || !item || !["text", "select", "reference"].includes(item.type) ||
          item.type === "reference" && item.reference.formId !== configured.products.id || quantity?.type !== "number") {
        throw new AppError(400, "Choose an order table, a product code/name or Products reference field, and a numeric quantity field.");
      }
      const mapping = { itemField: item.id, quantityField: quantity.id };
      const old = repo.mappings().find((value) => value.formId === form.id);
      if (old && JSON.stringify(old) !== JSON.stringify({ formId: form.id, ...mapping }) &&
          repo.postings().some((posting) => posting.kind === "order" && !posting.reversedBy && posting.source.formId === form.id)) {
        throw new AppError(409, "Reverse this order table's active stock postings before changing its field mapping.");
      }
      repo.saveMapping(form.id, mapping);
      return { formId: form.id, ...mapping };
    });
  }
  function summary() {
    const ids = repo.tables();
    if (!ids.materials) return [];
    const totals = new Map();
    for (const entry of repo.entries()) {
      const total = totals.get(entry.materialId) || { incoming: new D(0), outgoing: new D(0) };
      if (entry.direction === "In") total.incoming = total.incoming.plus(entry.quantity);
      else total.outgoing = total.outgoing.plus(entry.quantity);
      totals.set(entry.materialId, total);
    }
    return store.listRecords(ids.materials).map((record) => {
      const total = totals.get(record.id) || { incoming: new D(0), outgoing: new D(0) };
      const onHand = total.incoming.minus(total.outgoing);
      return { materialId: record.id, sku: record.values.sku, name: record.values.name, unit: record.values.unit,
        incoming: total.incoming.toFixed(), outgoing: total.outgoing.toFixed(), onHand: onHand.toFixed(),
        reorderLevel: record.values.reorderLevel ?? 0, lowStock: onHand.lte(record.values.reorderLevel ?? 0) };
    }).sort((a, b) => a.sku.localeCompare(b.sku));
  }
  function state() {
    const postings = repo.postings(), byId = new Map(postings.map((posting) => [posting.id, posting]));
    return { tables: repo.tables(), mappings: repo.mappings(), summary: summary(),
      activeSources: Object.fromEntries(postings.filter((posting) => ["order", "purchase", "receipt"].includes(posting.kind) && !posting.reversedBy)
        .map((posting) => [posting.source.recordId, posting.id])),
      movements: repo.entries().reverse().map((entry) => {
        const posting = byId.get(entry.postingId);
        return { ...entry, kind: posting.kind, source: posting.source, note: posting.note,
          createdAt: posting.createdAt, reverses: posting.reverses, reversedBy: posting.reversedBy };
      }) };
  }
  function input(body) {
    if (!body || !["purchase", "order", "adjustment", "reversal"].includes(body.kind)) throw new AppError(400, "Choose a supported stock operation.");
    const allowed = ["kind", "sourceId", "materialId", "direction", "quantity", "note", "previewToken", "idempotencyKey"];
    if (Object.keys(body).some((key) => !allowed.includes(key))) throw new AppError(400, "Unknown stock operation arguments.");
    if (body.kind !== "adjustment" && (typeof body.sourceId !== "string" || !/^[a-zA-Z0-9-]{1,64}$/.test(body.sourceId))) {
      throw new AppError(400, "Choose an existing source record.");
    }
    if (body.kind === "adjustment" && (typeof body.materialId !== "string" || !/^[a-zA-Z0-9-]{1,64}$/.test(body.materialId))) {
      throw new AppError(400, "Choose an existing material.");
    }
    const note = body.note ?? "";
    if (typeof note !== "string" || note.length > 1000) throw new AppError(400, "Stock notes must be text of at most 1000 characters.");
    return { kind: body.kind, ...(body.kind === "adjustment" ? {
      materialId: body.materialId, direction: body.direction, quantity: body.quantity,
    } : { sourceId: body.sourceId }), note: note.trim() };
  }
  function calculate(body) {
    const request = input(body), configured = forms();
    const result = { kind: request.kind, source: null, lines: [], note: request.note, canPost: true, shortages: [] };
    const dependencies = [];
    const sourceRecord = (id, form) => {
      const record = store.getRecord(id);
      if (record.formId !== form.id) throw new AppError(400, "The source record belongs to a different table.");
      dependencies.push(form, record);
      return record;
    };
    const add = (materialId, quantity, direction, extra = {}) => {
      const material = sourceRecord(materialId, configured.materials);
      const amount = new D(quantity);
      if (!amount.isFinite() || amount.lte(0) || amount.gt("1e24")) throw new AppError(400, "The calculated stock quantity is out of range.");
      result.lines.push({ materialId, sku: material.values.sku, name: material.values.name,
        unit: material.values.unit, direction, quantity: amount.toFixed(), ...extra });
    };
    if (["purchase", "order"].includes(request.kind)) {
      if (repo.activeForSource(request.sourceId)) throw new AppError(409, "Stock has already been posted for this record. Reverse it before posting again.");
      const record = store.getRecord(request.sourceId), form = store.getForm(record.formId);
      dependencies.push(form, record);
      result.source = { recordId: record.id, formId: form.id, title: label(form, record), version: record.version, stockValues: {} };
      if (request.kind === "purchase") {
        if (form.id !== configured.purchases.id) throw new AppError(400, "Choose a purchase record from the configured Purchases table.");
        inventoryQuantity(record.values.quantity, "Purchase quantity");
        result.source.stockValues = { material: record.values.material, quantity: record.values.quantity };
        add(record.values.material, record.values.quantity, "In");
      } else {
        if (form.moduleId !== "orders") throw new AppError(400, "Choose an order record.");
        const mapping = repo.mappings().find((item) => item.formId === form.id);
        if (!mapping) throw new AppError(400, "Configure this order table's product and quantity fields in Inventory settings.");
        dependencies.push(mapping);
        const itemField = form.fields.find((item) => item.id === mapping.itemField);
        const item = record.values[mapping.itemField], quantity = record.values[mapping.quantityField];
        inventoryQuantity(quantity, "Order quantity");
        const products = store.listRecords(configured.products.id);
        const exact = (value) => typeof value === "string" && typeof item === "string" && value.trim().toLowerCase() === item.trim().toLowerCase();
        const matches = itemField?.type === "reference" ? products.filter((product) => product.id === item) :
          products.filter((product) => exact(product.values.productCode));
        const candidates = matches.length ? matches : itemField?.type === "reference" ? [] : products.filter((product) => exact(product.values.name));
        if (candidates.length !== 1) throw new AppError(400, candidates.length ? "The order product name is ambiguous. Use its unique product code." : "No inventory product matches the order item. Use its exact product code/name or a Products reference.");
        const product = candidates[0];
        dependencies.push(configured.products, product, configured.recipes);
        const recipes = store.listRecords(configured.recipes.id).filter((line) => line.values.product === product.id).sort((a, b) => a.id.localeCompare(b.id));
        if (!recipes.length) throw new AppError(400, "This product has no recipe. Add its material quantities before issuing stock.");
        if (recipes.length > 100) throw new AppError(400, "An order supports up to 100 recipe materials.");
        result.source.stockValues = { [mapping.itemField]: item, [mapping.quantityField]: quantity };
        result.source.product = { id: product.id, code: product.values.productCode, name: product.values.name, quantity };
        for (const line of recipes) {
          dependencies.push(line);
          inventoryQuantity(line.values.quantityPerUnit, "Recipe quantity per product");
          add(line.values.material, new D(quantity).times(line.values.quantityPerUnit), "Out", { perProduct: String(line.values.quantityPerUnit) });
        }
      }
    } else if (request.kind === "adjustment") {
      if (!["In", "Out"].includes(request.direction) || !request.note) throw new AppError(400, "Choose In or Out and enter a reason for the adjustment.");
      inventoryQuantity(request.quantity, "Adjustment quantity");
      add(request.materialId, request.quantity, request.direction);
    } else {
      const original = repo.posting(request.sourceId);
      if (original.kind === "reversal" || original.reversedBy) throw new AppError(409, "This posting has already been reversed or is itself a reversal.");
      if (!request.note) throw new AppError(400, "Enter a reason for the reversal.");
      dependencies.push(original);
      result.source = original.source;
      result.reverses = original.id;
      for (const line of original.lines) add(line.materialId, line.quantity, line.direction === "In" ? "Out" : "In");
    }
    const balances = new Map(summary().map((row) => [row.materialId, row.onHand]));
    for (const line of result.lines) {
      const before = new D(balances.get(line.materialId) || 0);
      const after = line.direction === "In" ? before.plus(line.quantity) : before.minus(line.quantity);
      line.before = before.toFixed(); line.after = after.toFixed();
      balances.set(line.materialId, line.after);
      if (after.lt(0)) {
        result.canPost = false;
        result.shortages.push(`${line.sku}: short by ${after.negated().toFixed()} ${line.unit}`);
      }
    }
    return { ...result, previewToken: hash({ request, dependencies, result }) };
  }
  function preview(body) { return store.transaction(() => calculate(body)); }
  function post(body) {
    return store.transaction(() => {
      const key = body?.idempotencyKey;
      if (typeof key !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(key) || typeof body.previewToken !== "string") {
        throw new AppError(400, "A preview token and an 8-100 character idempotency key are required.");
      }
      const request = input(body), fingerprint = hash({ ...request, previewToken: body.previewToken });
      const previous = repo.request(key);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new AppError(409, "This idempotency key was already used for another request.");
        return { posting: previous.posting, alreadyPosted: true };
      }
      const draft = calculate(body);
      if (draft.previewToken !== body.previewToken) throw new AppError(409, "Stock, source data or the recipe changed. Refresh the stock preview before confirming.");
      if (!draft.canPost) throw new AppError(409, `Insufficient stock. ${draft.shortages.join("; ")}`);
      return { posting: repo.savePosting(draft, key, fingerprint), alreadyPosted: false };
    });
  }
  return { ensureTables, saveMapping, state, preview, post };
}
