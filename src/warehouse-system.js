import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { AppError } from "./errors.js";
import { inventoryQuantity } from "./quantities.js";

const D = Decimal.clone({ precision: 40 });
const fail = (message, status = 400) => { throw new AppError(status, message); };
const field = (id, name, type = "text", extra = {}) => ({ id, name, type, required: false, unique: false, options: [], ...extra });
const ref = (id, name, form, key) => field(id, name, "reference", { required: true, reference: { formId: form.id, fieldId: key } });
const statuses = ["Draft", "Pending approval", "Approved", "Posted", "Rejected", "Cancelled", "Reversed"];
const editable = (record) => ["Draft", "Rejected"].includes(record.values.status);
const headers = ["inbound", "outbound"];
const lineRole = (role) => role === "inbound" ? "inboundLines" : "outboundLines";
const headerRole = (role) => role === "inboundLines" ? "inbound" : "outbound";
const isLine = (role) => ["inboundLines", "outboundLines"].includes(role);
const managed = {
  stock: ["stockKey", "currentQuantity", "name", "code", "image", "category", "specification", "unit"],
  inbound: ["number", "status", "totalQuantity", "postedDate", "initiator", "workflowStatus", "progress", "startedAt", "endedAt"],
  outbound: ["number", "status", "totalQuantity", "postedDate", "initiator", "workflowStatus", "progress", "startedAt", "endedAt"],
  inboundLines: ["status", "postedDate"], outboundLines: ["status", "postedDate"], warehouses: [], products: [],
};
const coreFields = {
  warehouses: ["code", "name", "location", "manager", "notes"],
  products: ["code", "name", "image", "category", "specification", "unit", "notes", "active"],
  stock: ["product", "name", "currentQuantity", "minimum", "code", "warehouse", "image", "category", "specification", "unit", "openingQuantity", "stockKey"],
  inbound: ["number", "status", "type", "warehouse", "totalQuantity", "applicant", "applicationDate", "approver", "postedDate", "photos", "notes", "initiator", "workflowStatus", "progress", "startedAt", "endedAt"],
  outbound: ["number", "status", "type", "warehouse", "totalQuantity", "applicant", "applicationDate", "approver", "postedDate", "notes", "initiator", "workflowStatus", "progress", "startedAt", "endedAt"],
  inboundLines: ["document", "status", "postedDate", "product", "quantity", "notes"],
  outboundLines: ["document", "status", "postedDate", "product", "quantity", "notes"],
};
const stable = (value) => JSON.stringify(value ?? null);
const today = () => new Date().toISOString().slice(0, 10);
const dateTime = () => new Date().toISOString().slice(0, 16);
function exact(value) {
  const decimal = new D(value);
  if (!decimal.isFinite() || decimal.abs().gt(1e15) || !new D(decimal.toNumber()).eq(decimal)) fail("Warehouse quantity is outside the supported exact numeric range.");
  return decimal.toNumber();
}

export function createWarehouseSystem({ db, store }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS warehouse_forms (space_id TEXT NOT NULL, role TEXT NOT NULL, form_id TEXT NOT NULL UNIQUE REFERENCES forms(id), PRIMARY KEY(space_id, role));
    CREATE TABLE IF NOT EXISTS warehouse_sequences (space_id TEXT NOT NULL, prefix TEXT NOT NULL, day TEXT NOT NULL, value INTEGER NOT NULL, PRIMARY KEY(space_id, prefix, day));
    CREATE TABLE IF NOT EXISTS warehouse_movements (id TEXT PRIMARY KEY, space_id TEXT NOT NULL, document_id TEXT NOT NULL REFERENCES records(id), stock_id TEXT NOT NULL REFERENCES records(id), direction TEXT NOT NULL, quantity TEXT NOT NULL, reversal INTEGER NOT NULL DEFAULT 0, actor TEXT NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(document_id, stock_id, reversal));
    CREATE TABLE IF NOT EXISTS warehouse_events (id TEXT PRIMARY KEY, space_id TEXT NOT NULL, document_id TEXT NOT NULL REFERENCES records(id), action TEXT NOT NULL, actor TEXT NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS warehouse_movement_stock ON warehouse_movements(stock_id);
  `);
  let permit = null;
  const isAdmin = () => store.auth.currentUser()?.role === "admin";
  const operator = (supplied) => {
    const user = store.auth.currentUser();
    return user ? user.username : typeof supplied === "string" ? supplied.trim() : "";
  };
  function assignedApprover(value) {
    if (!store.auth.currentUser()) return null;
    const users = store.auth.assignees();
    const exact = users.find(user => user.id === value || user.username === value);
    const named = users.filter(user => user.displayName === value);
    const user = exact ?? (named.length === 1 ? named[0] : null);
    if (!user) fail("Choose an active approver by username.", 400);
    return user;
  }
  const roleOf = (formId) => db.prepare("SELECT role FROM warehouse_forms WHERE form_id = ?").get(formId)?.role;
  const tableIds = (spaceId = "default") => Object.fromEntries(db.prepare("SELECT role, form_id FROM warehouse_forms WHERE space_id = ?").all(spaceId).map(row => [row.role, row.form_id]));
  const table = (spaceId, role) => {
    const id = tableIds(spaceId)[role];
    if (!id) fail("Set up Warehouse Management in this Space first.");
    return store.getForm(id);
  };
  function ensureTables(spaceId = "default") {
    return store.transaction(() => {
      store.spaces.get(spaceId);
      if (Object.keys(tableIds(spaceId)).length) { migrate(); return state(spaceId); }
      const root = store.spaces.createNode({ spaceId, name: "仓储管理" });
      const stockNode = store.spaces.createNode({ spaceId, parentId: root.id, name: "库存管理" });
      const inNode = store.spaces.createNode({ spaceId, parentId: root.id, name: "入库管理" });
      const outNode = store.spaces.createNode({ spaceId, parentId: root.id, name: "出库管理" });
      const settingsNode = store.spaces.createNode({ spaceId, parentId: root.id, name: "系统配置" });
      const create = (role, name, fields, parentId) => {
        const form = store.createForm({ spaceId, moduleId: "inventory", parentId, name, fields });
        db.prepare("INSERT INTO warehouse_forms VALUES (?, ?, ?)").run(spaceId, role, form.id);
        return form;
      };
      const warehouses = create("warehouses", "仓库信息", [field("code", "仓库编码", "text", { required: true, unique: true }), field("name", "仓库名称", "text", { required: true }), field("location", "仓库地址"), field("manager", "负责人"), field("notes", "备注", "longtext")], settingsNode.id);
      const products = create("products", "商品表", productFields(), settingsNode.id);
      const stock = create("stock", "库存表", [ref("product", "商品", products, "code"), field("name", "商品名称", "text", { required: true }), field("currentQuantity", "当前库存数量", "number"), field("minimum", "库存下限", "number"), field("code", "商品编码", "text", { required: true }), ref("warehouse", "仓库", warehouses, "code"), field("image", "商品图片", "attachment"), field("category", "商品分类"), field("specification", "规格型号"), field("unit", "单位", "text", { required: true }), field("openingQuantity", "期初库存数量", "number"), field("stockKey", "库存标识", "text", { required: true, unique: true })], stockNode.id);
      for (const role of headers) {
        const incoming = role === "inbound", prefix = incoming ? "入库" : "出库";
        const form = create(role, `${prefix}单`, [
          field("number", `${prefix}单号`, "text", { required: true, unique: true }),
          field("status", `${prefix}状态`, "select", { required: true, options: statuses }),
          field("type", `${prefix}类型`, "select", { required: true, options: incoming ? ["Direct receipt", "Purchase receipt", "Return receipt"] : ["Direct issue", "Sales issue", "Production issue", "Return issue"] }),
          ref("warehouse", `${prefix}仓库`, warehouses, "code"), field("totalQuantity", `${prefix}总量`, "number"),
          field("applicant", "申请人", "text", { required: true }), field("applicationDate", "申请日期", "date", { required: true }), field("approver", "审批人"), field("postedDate", `${prefix}日期`, "date"),
          ...(incoming ? [field("photos", "入库拍照", "attachment")] : []), field("notes", "备注", "longtext"),
          field("initiator", "流程发起人"), field("workflowStatus", "流程状态", "select", { options: ["Not started", "In progress", "Completed", "Rejected", "Cancelled", "Reversed"] }),
          field("progress", "流程进度"), field("startedAt", "流程启动时间", "datetime"), field("endedAt", "流程结束时间", "datetime"),
        ], incoming ? inNode.id : outNode.id);
        create(lineRole(role), `${prefix}明细`, [ref("document", `所属${prefix}单`, form, "number"), field("status", `${prefix}状态`, "select", { options: statuses }), field("postedDate", `${prefix}日期`, "date"), ref("product", `${prefix}产品`, products, "code"), field("quantity", `${prefix}数量`, "number", { required: true }), field("notes", "备注", "longtext")], incoming ? inNode.id : outNode.id);
      }
      insert(warehouses, { code: "WH001", name: "默认仓库" });
      return state(spaceId);
    });
  }
  function nextNumber(spaceId, role) {
    const prefix = role === "inbound" ? "RK" : "CK", day = today().replaceAll("-", "");
    db.prepare("INSERT INTO warehouse_sequences VALUES (?, ?, ?, 1) ON CONFLICT(space_id, prefix, day) DO UPDATE SET value = value + 1").run(spaceId, prefix, day);
    const count = db.prepare("SELECT value FROM warehouse_sequences WHERE space_id = ? AND prefix = ? AND day = ?").get(spaceId, prefix, day).value;
    return `${prefix}_${day}_${String(count).padStart(3, "0")}`;
  }
  function balance(id, opening = store.getRecord(id).values.openingQuantity ?? 0) {
    return db.prepare("SELECT direction, quantity FROM warehouse_movements WHERE stock_id = ?").all(id).reduce((total, row) => row.direction === "In" ? total.plus(row.quantity) : total.minus(row.quantity), new D(opening));
  }
  const linesFor = (record) => store.listRecords(table(store.getForm(record.formId).spaceId, lineRole(roleOf(record.formId))).id).filter(row => row.values.document === record.id);
  function insert(form, values) {
    permit = { formId: form.id, input: values, mode: "workflow" };
    try { return store.createRecord(form.id, { schemaVersion: form.version, values }).record; }
    finally { permit = null; }
  }
  function managedUpdate(recordId, values, mode = "system", version) {
    const record = store.getRecord(recordId), form = store.getForm(record.formId);
    permit = { recordId, input: values, mode };
    try { return store.updateRecord(recordId, { schemaVersion: form.version, version: version ?? record.version, values }).record; }
    finally { permit = null; }
  }
  function removeLine(record) {
    permit = { deleting: record.id };
    try { return store.deleteRecord(record.id, { version: record.version }); }
    finally { permit = null; }
  }
  function catalog(body) {
    return store.transaction(() => {
      const { role, values = {}, recordId, version, spaceId = "default" } = body;
      if (!["products", "warehouses", "stock"].includes(role)) fail("Choose a catalog workflow.");
      const form = table(spaceId, role);
      if (recordId) {
        const record = store.getRecord(recordId);
        if (record.formId !== form.id) fail("Choose a record in this catalog and Space.");
        if (version !== record.version) fail("The catalog record changed. Refresh and try again.", 409);
        return managedUpdate(recordId, values, "workflow", version);
      }
      return insert(form, values);
    });
  }
  function stockFor(spaceId, productId, warehouseId, create = false) {
    const form = table(spaceId, "stock");
    const found = store.listRecords(form.id).find(row => row.values.product === productId && row.values.warehouse === warehouseId);
    return found ?? (create ? insert(form, { product: productId, warehouse: warehouseId, openingQuantity: 0, minimum: 0 }) : null);
  }
  function migrate() {
    for (const { space_id: spaceId } of db.prepare("SELECT DISTINCT space_id FROM warehouse_forms").all()) {
      if (tableIds(spaceId).products) continue;
      store.transaction(() => {
        const stock = table(spaceId, "stock"), warehouses = table(spaceId, "warehouses");
        const parentId = store.spaces.tree(spaceId).find(node => node.formId === warehouses.id)?.parentId;
        const products = store.createForm({ name: "商品表", moduleId: "inventory", spaceId, parentId, fields: productFields() });
        db.prepare("INSERT INTO warehouse_forms VALUES (?, 'products', ?)").run(spaceId, products.id);
        const byCode = new Map(), stockToProduct = new Map();
        for (const row of store.listRecords(stock.id)) {
          const key = row.values.code.toLowerCase(), existing = byCode.get(key);
          if (existing && ["name", "unit", "category", "specification", "image"].some(id => stable(existing.values[id]) !== stable(row.values[id]))) {
            fail(`Product migration needs matching catalog details for code ${row.values.code}.`, 409);
          }
          const product = existing ?? insert(products, { ...Object.fromEntries(["code", "name", "unit", "image", "category", "specification"].map(id => [id, row.values[id]])), active: true });
          byCode.set(key, product); stockToProduct.set(row.id, product.id);
          db.prepare("UPDATE records SET values_json = ?, version = version + 1 WHERE id = ?").run(JSON.stringify({ ...row.values, product: product.id }), row.id);
        }
        db.prepare("UPDATE forms SET fields_json = ?, version = version + 1 WHERE id = ?").run(JSON.stringify([ref("product", "商品", products, "code"), ...stock.fields]), stock.id);
        for (const role of ["inboundLines", "outboundLines"]) {
          const form = table(spaceId, role);
          for (const row of store.listRecords(form.id)) {
            const product = stockToProduct.get(row.values.product);
            if (!product) fail("A warehouse line references missing stock. Repair it before migration.", 409);
            db.prepare("UPDATE records SET values_json = ?, version = version + 1 WHERE id = ?").run(JSON.stringify({ ...row.values, product }), row.id);
          }
          const fields = form.fields.map(f => f.id === "product" ? { ...f, reference: { formId: products.id, fieldId: "code" } } : f);
          db.prepare("UPDATE forms SET fields_json = ?, version = version + 1 WHERE id = ?").run(JSON.stringify(fields), form.id);
        }
      });
    }
  }
  function prepare(form, input, previous, id, creating) {
    const role = roleOf(form.id);
    if (!role || !input || typeof input !== "object" || Array.isArray(input)) return input;
    const access = permit?.input === input && (creating ? permit.formId === form.id : permit.recordId === id) ? permit.mode : null;
    if (!access && !isAdmin()) fail("Warehouse tables are read-only. Use a warehouse workflow.", 403);
    permit = null;
    const trusted = access === "system";
    const values = { ...Object.fromEntries(form.fields.filter(f => !f.formula && Object.hasOwn(previous, f.id)).map(f => [f.id, previous[f.id]])), ...input };
    if (!trusted) {
      for (const key of managed[role]) if (Object.hasOwn(input, key) && (creating ? input[key] != null && input[key] !== "" : stable(input[key]) !== stable(previous[key]))) fail("Use the warehouse workflow to change managed stock and status fields.", 409);
      if (headers.includes(role) && !creating && !editable({ values: previous }) && form.fields.some(f => stable(values[f.id]) !== stable(previous[f.id]))) fail("Only draft or rejected warehouse documents can be edited.", 409);
      if (isLine(role)) {
        if (!creating && previous.document !== values.document) fail("A warehouse line cannot be moved to another document.", 409);
        const doc = values.document && store.getRecord(values.document);
        if (doc && !editable(doc)) fail("Only draft or rejected warehouse documents can be edited.", 409);
      }
    }
    if (role === "stock") {
      const product = values.product && store.getRecord(values.product);
      if (!product || product.formId !== table(form.spaceId, "products").id) fail("Choose a product in this Space.");
      for (const key of ["name", "code", "image", "category", "specification", "unit"]) values[key] = product.values[key] ?? null;
      values.openingQuantity ??= 0; values.minimum ??= 0;
      inventoryQuantity(values.openingQuantity, "Opening quantity", true);
      const warehouse = values.warehouse && store.getRecord(values.warehouse);
      values.stockKey = warehouse ? `${String(values.code ?? "").trim()} @ ${warehouse.values.code}` : "";
      values.currentQuantity = exact(balance(id, values.openingQuantity));
    } else if (role === "products" && creating) values.active ??= true;
    else if (headers.includes(role) && creating) {
      Object.assign(values, { number: nextNumber(form.spaceId, role), status: "Draft", totalQuantity: 0, postedDate: null, initiator: null, workflowStatus: "Not started", progress: "Draft", startedAt: null, endedAt: null });
      values.type ||= role === "inbound" ? "Direct receipt" : "Direct issue";
      values.applicationDate ||= today();
    } else if (isLine(role) && values.document) {
      const doc = store.getRecord(values.document);
      values.status = doc.values.status; values.postedDate = doc.values.postedDate;
    }
    return values;
  }
  function validateRecord(form, previous, values, id) {
    const role = roleOf(form.id);
    if (!role) return;
    if (role === "products") {
      if (!values.unit || values.unit.length > 32) fail("A stock unit must contain 1-32 characters.");
      for (const fileId of values.image ?? []) if (!store.files.get(fileId).mime.startsWith("image/")) fail("Product pictures must be PNG or JPEG images.");
      if (previous && ["code", "unit"].some(key => values[key] !== previous.values[key])) {
        const stocks = tableIds(form.spaceId).stock;
        const used = stocks && store.listRecords(stocks).some(row => row.values.product === id);
        const mentioned = ["inboundLines", "outboundLines"].some(role => tableIds(form.spaceId)[role] && store.listRecords(tableIds(form.spaceId)[role]).some(row => row.values.product === id));
        if (used || mentioned) fail("A referenced product cannot change its code or unit.", 409);
      }
    }
    if (role === "stock") {
      inventoryQuantity(values.openingQuantity ?? 0, "Opening quantity", true);
      inventoryQuantity(values.minimum ?? 0, "Minimum stock", true);
      if (values.currentQuantity < 0) fail("Insufficient warehouse stock.", 409);
      if (!values.unit || values.unit.length > 32) fail("A stock unit must contain 1-32 characters.");
      for (const fileId of values.image ?? []) if (!store.files.get(fileId).mime.startsWith("image/")) fail("Product pictures must be PNG or JPEG images.");
      if (previous && ["product", "code", "warehouse", "unit", "openingQuantity"].some(key => stable(values[key]) !== stable(previous.values[key])) && db.prepare("SELECT 1 FROM warehouse_movements WHERE stock_id = ? LIMIT 1").get(id)) fail("Stock with movement history cannot change code, warehouse, unit or opening quantity.", 409);
      const peers = store.listRecords(form.id).filter(row => row.id !== id && row.values.code?.toLowerCase() === values.code?.toLowerCase());
      if (peers.some(row => row.values.unit !== values.unit)) fail("The same product code must use the same unit in every warehouse.");
    }
    if (isLine(role)) {
      inventoryQuantity(values.quantity, "Line quantity");
      const doc = store.getRecord(values.document), product = store.getRecord(values.product);
      if (doc.formId !== table(form.spaceId, headerRole(role)).id || product.formId !== table(form.spaceId, "products").id) fail("Choose a document and product in the same warehouse system.");
      if ((!previous || previous.values.product !== values.product) && !product.values.active) fail("Choose an active product.");
      if (store.listRecords(form.id).some(row => row.id !== id && row.values.document === values.document && row.values.product === values.product)) fail("This document already contains that product. Edit its existing line.", 409);
    }
    if (headers.includes(role) && previous && values.warehouse !== previous.values.warehouse && linesFor(previous).length) fail("Remove document lines before changing its warehouse.", 409);
    if (role === "warehouses" && previous && values.code !== previous.values.code) {
      const stockId = tableIds(form.spaceId).stock;
      if (stockId && store.listRecords(stockId).some(row => row.values.warehouse === id)) fail("A warehouse code used by stock records cannot be changed.", 409);
    }
  }
  function afterWrite(form, record, kind, previous) {
    const role = roleOf(form.id);
    if (role === "products" && kind === "updated") {
      for (const row of store.listRecords(table(form.spaceId, "stock").id).filter(row => row.values.product === record.id)) managedUpdate(row.id, {});
    }
    if (role === "stock" && kind !== "deleted" && record.values.currentQuantity < record.values.minimum && (!previous || previous.values.currentQuantity >= previous.values.minimum)) {
      store.automation.notify(form.spaceId, form.id, record.id, `${record.values.name}: ${record.values.currentQuantity} ${record.values.unit} < ${record.values.minimum}`);
    }
    if (isLine(role)) {
      const doc = store.getRecord(record.values.document);
      const total = linesFor(doc).reduce((sum, line) => sum.plus(line.values.quantity), new D(0));
      managedUpdate(doc.id, { totalQuantity: exact(total) });
    } else if (headers.includes(role) && kind === "updated") {
      for (const line of linesFor(record)) if (line.values.status !== record.values.status || line.values.postedDate !== record.values.postedDate) managedUpdate(line.id, { status: record.values.status, postedDate: record.values.postedDate });
    }
  }
  function assertDelete(record) {
    const role = roleOf(record.formId);
    if (!role) return;
    if (permit?.deleting !== record.id && !isAdmin()) fail("Warehouse tables are read-only. Use a warehouse workflow.", 403);
    permit = null;
    if (headers.includes(role) && record.values.status !== "Draft") fail("Submitted warehouse documents retain their history. Cancel or reverse instead.", 409);
    if (isLine(role) && !editable(store.getRecord(record.values.document))) fail("Only draft or rejected warehouse documents can be edited.", 409);
    if (role === "stock" && db.prepare("SELECT 1 FROM warehouse_movements WHERE stock_id = ? LIMIT 1").get(record.id)) fail("Stock with movement history cannot be deleted.", 409);
  }
  function assertSchema(form, fields) {
    const role = roleOf(form.id);
    if (!role) return;
    if (!isAdmin()) fail("Warehouse tables are read-only. Use a warehouse workflow.", 403);
    if (!fields) return;
    for (const id of coreFields[role]) {
      const previous = form.fields.find(field => field.id === id), next = fields.find(field => field.id === id);
      if (!previous || !next || ["type", "required", "unique", "options", "reference", "formula"].some(key => stable(previous[key]) !== stable(next[key]))) {
        fail("Core warehouse fields may be renamed or reordered, but their types and business constraints cannot be changed.", 409);
      }
    }
  }
  function document(id) {
    const record = store.getRecord(id), role = roleOf(record.formId);
    if (!headers.includes(role)) fail("Choose an inbound or outbound document.");
    return { record, kind: role, lines: linesFor(record), events: db.prepare("SELECT * FROM warehouse_events WHERE document_id = ? ORDER BY rowid").all(id) };
  }
  function createDocument(body) {
    return store.transaction(() => {
      const { kind, spaceId = "default", lines = [], submit = false } = body;
      const user = store.auth.currentUser();
      const values = { ...body.values, ...(user ? { applicant: user.username } : {}) };
      if (typeof submit !== "boolean") fail("Submit must be true or false.");
      if (!headers.includes(kind)) fail("Choose inbound or outbound.");
      if (!Array.isArray(lines) || lines.length > 100) fail("A warehouse document supports up to 100 product lines.");
      const form = table(spaceId, kind), detail = table(spaceId, lineRole(kind));
      const record = insert(form, values);
      for (const values of lines) insert(detail, { ...values, document: record.id });
      if (submit) transition(record.id, { action: "submit", version: store.getRecord(record.id).version, actor: body.actor || values.applicant });
      return document(record.id);
    });
  }
  function updateDocument(id, body) {
    return store.transaction(() => {
      const current = document(id), { record } = current;
      if (!editable(record)) fail("Only draft or rejected warehouse documents can be edited.", 409);
      if (body.version !== record.version) fail("The warehouse document changed. Refresh and try again.", 409);
      if (!Array.isArray(body.lines) || body.lines.length > 100) fail("A warehouse document supports up to 100 product lines.");
      const form = store.getForm(record.formId), detail = table(form.spaceId, lineRole(current.kind));
      const supplied = new Set();
      for (const line of body.lines) if (line.id) {
        if (supplied.has(line.id) || !current.lines.some(row => row.id === line.id)) fail("Choose existing lines from this document.");
        supplied.add(line.id);
      }
      for (const line of current.lines.filter(row => !supplied.has(row.id))) removeLine(line);
      const header = store.getRecord(id);
      const user = store.auth.currentUser();
      const values = { ...body.values, ...(user ? { applicant: record.values.applicant } : {}) };
      managedUpdate(id, values, "workflow", header.version);
      for (const line of body.lines) {
        const { id: lineId, version, ...values } = line;
        if (lineId) {
          if (version !== store.getRecord(lineId).version) fail("The warehouse line changed. Refresh and try again.", 409);
          managedUpdate(lineId, { ...values, document: id }, "workflow", version);
        } else insert(detail, { ...values, document: id });
      }
      return document(id);
    });
  }
  function transition(id, body) {
    return store.transaction(() => {
      const { record, kind, lines } = document(id), form = store.getForm(record.formId), { action, version } = body;
      try {
        if (version !== record.version) fail("The warehouse document changed. Refresh and try again.", 409);
        const actor = operator(body.actor);
        const note = typeof body.note === "string" ? body.note.trim() : "";
        if (!actor || actor.length > 100 || note.length > 1000) fail("Enter an operator name of 1-100 characters and a note up to 1000 characters.");
        const allowed = { submit: ["Draft", "Rejected"], approve: ["Pending approval"], reject: ["Pending approval"], cancel: ["Draft", "Rejected", "Pending approval", "Approved"], post: ["Approved"], reverse: ["Posted"] };
        if (!Object.hasOwn(allowed, action) || !allowed[action].includes(record.values.status)) fail("This action is not available in the current warehouse document status.", 409);
        if (["reject", "cancel", "reverse"].includes(action) && !note) fail("Enter a reason for this workflow action.");
        if (["submit", "post"].includes(action) && (!lines.length || lines.length > 100)) fail("Add 1-100 product lines before submitting or posting.");
        if (action === "submit" && !record.values.approver?.trim()) fail("Choose an approver before submitting the warehouse document.");
        const approver = ["submit", "approve", "reject"].includes(action) && record.values.approver ? assignedApprover(record.values.approver) : null;
        if (["submit", "post"].includes(action) && lines.some(line => !store.getRecord(line.values.product).values.active)) fail("Choose an active product.");
        if (["approve", "reject"].includes(action) && actor !== (approver?.username ?? record.values.approver)) fail("Use the assigned approver for this workflow step.", 403);
        const changes = {};
        if (action === "submit") Object.assign(changes, { status: "Pending approval", workflowStatus: "In progress", progress: "Approval", initiator: actor, startedAt: dateTime(), endedAt: null });
        if (action === "approve") Object.assign(changes, { status: "Approved", workflowStatus: "In progress", progress: "Warehouse confirmation" });
        if (action === "reject") Object.assign(changes, { status: "Rejected", workflowStatus: "Rejected", progress: "Rejected", endedAt: dateTime() });
        if (action === "cancel") Object.assign(changes, { status: "Cancelled", workflowStatus: "Cancelled", progress: "Cancelled", endedAt: dateTime() });
        if (["post", "reverse"].includes(action)) {
          const reversal = action === "reverse", incoming = (kind === "inbound") !== reversal;
          const movements = reversal ? db.prepare("SELECT stock_id, quantity FROM warehouse_movements WHERE document_id = ? AND reversal = 0").all(id).map(row => ({ stockId: row.stock_id, quantity: row.quantity })) : lines.map(line => {
            const stock = stockFor(form.spaceId, line.values.product, record.values.warehouse, incoming);
            if (!stock) fail(`Insufficient warehouse stock: ${store.getRecord(line.values.product).values.name}.`, 409);
            return { stockId: stock.id, quantity: inventoryQuantity(line.values.quantity, "Line quantity") };
          });
          if (!movements.length) fail("No warehouse movements are available.", 409);
          for (const movement of movements) {
            const stock = store.getRecord(movement.stockId);
            if (stock.values.warehouse !== record.values.warehouse) fail("The product and document must belong to the same warehouse.");
            const after = incoming ? balance(stock.id).plus(movement.quantity) : balance(stock.id).minus(movement.quantity);
            if (after.lt(0)) fail(`Insufficient warehouse stock: ${stock.values.name}.`, 409);
            exact(after);
          }
          for (const movement of movements) {
            db.prepare("INSERT INTO warehouse_movements VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(randomUUID(), form.spaceId, id, movement.stockId, incoming ? "In" : "Out", String(movement.quantity), reversal ? 1 : 0, actor, note, new Date().toISOString());
          }
          Object.assign(changes, { status: reversal ? "Reversed" : "Posted", workflowStatus: reversal ? "Reversed" : "Completed", progress: reversal ? "Reversed" : "Completed", endedAt: dateTime(), ...(!reversal ? { postedDate: body.date || today() } : {}) });
          // Status locks the document before stock updates can trigger further automations.
          managedUpdate(id, changes);
          for (const movement of movements) managedUpdate(movement.stockId, { currentQuantity: exact(balance(movement.stockId)) });
        } else managedUpdate(id, changes);
        db.prepare("INSERT INTO warehouse_events VALUES (?, ?, ?, ?, ?, ?, ?)").run(randomUUID(), form.spaceId, id, action, actor, note, new Date().toISOString());
        return document(id);
      } catch (error) {
        error.operationContext ??= { operation: "warehouse_transition", spaceId: form.spaceId, formId: form.id, recordId: id, action };
        throw error;
      }
    });
  }
  function state(spaceId = "default") {
    store.spaces.get(spaceId);
    const tables = tableIds(spaceId);
    const requests = headers.flatMap(role => tables[role] ? store.listRecords(tables[role]) : []).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { tables, readOnlyForms: isAdmin() ? [] : Object.values(tables), managedFields: managed, coreFields, assignees: store.auth.assignees(), products: tables.products ? store.listRecords(tables.products) : [], stockItems: tables.stock ? store.listRecords(tables.stock) : [], warehouses: tables.warehouses ? store.listRecords(tables.warehouses) : [], workflows: headers.map(kind => ({ kind, name: kind === "inbound" ? "Inbound workflow" : "Outbound workflow", formId: tables[kind], steps: ["Draft", "Approval", "Warehouse confirmation", "Completed"] })),
      requests: requests.slice(0, 100), documentWarehouses: Object.fromEntries(requests.map(row => [row.id, row.values.warehouse])),
      movements: db.prepare("SELECT * FROM warehouse_movements WHERE space_id = ? ORDER BY rowid DESC LIMIT 1000").all(spaceId).map(movement => ({ ...movement, documentNumber: store.getRecord(movement.document_id).values.number })) };
  }
  const fingerprint = (spaceId) => ({ tables: tableIds(spaceId), movements: db.prepare("SELECT * FROM warehouse_movements WHERE space_id = ? ORDER BY rowid").all(spaceId), events: db.prepare("SELECT * FROM warehouse_events WHERE space_id = ? ORDER BY rowid").all(spaceId) });
  return { ensureTables, migrate, catalog, state, roleOf, tableIds, prepare, validateRecord, afterWrite, assertDelete, assertSchema, document, createDocument, updateDocument, transition, fingerprint };
}

function productFields() {
  return [field("code", "商品编码", "text", { required: true, unique: true }), field("name", "商品名称", "text", { required: true }), field("image", "商品图片", "attachment"), field("category", "商品分类"), field("specification", "规格型号"), field("unit", "单位", "text", { required: true }), field("notes", "备注", "longtext"), field("active", "启用", "checkbox")];
}
