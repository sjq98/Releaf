import { createHash, randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { AppError } from "./errors.js";
import { decodeFile, parseTableFile } from "./table-import.js";
import { inventoryQuantity } from "./quantities.js";

const fail = (message, status = 400) => { throw new AppError(status, message); };
const hash = value => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value, (_, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)).digest("hex");
const normalized = value => String(value ?? "").trim().toLowerCase().replace(/[\s_\-（）()]/g, "");
const identity = value => String(value ?? "").trim().toLowerCase();
const aliases = {
  code: ["商品编码", "产品编码", "物料编码", "sku", "product code", "item code", "code"],
  name: ["商品名称", "产品名称", "商品", "入库产品", "出库产品", "product", "product name", "item", "name"],
  quantity: ["数量", "入库数量", "出库数量", "quantity", "qty", "received quantity", "issued quantity"],
  unit: ["单位", "unit", "uom"], notes: ["备注", "明细备注", "notes", "remarks"],
  warehouseCode: ["仓库编码", "warehouse code"], warehouse: ["仓库", "仓库名称", "入库仓库", "出库仓库", "warehouse"],
  kind: ["方向", "出入库", "出入库方向", "direction", "workflow"],
  applicant: ["申请人", "applicant"], approver: ["审批人", "approver"],
  applicationDate: ["申请日期", "application date"],
  group: ["申请编号", "外部单号", "单据编号", "request", "request number", "document number"],
};
const direction = value => {
  const key = normalized(value);
  if (["in", "inbound", "入库"].includes(key)) return "inbound";
  if (["out", "outbound", "出库"].includes(key)) return "outbound";
  return null;
};

export function createWarehouseImport({ db, store }) {
  db.exec(`CREATE TABLE IF NOT EXISTS warehouse_import_files (
    id TEXT PRIMARY KEY, space_id TEXT NOT NULL, name TEXT NOT NULL, digest TEXT NOT NULL,
    bytes BLOB NOT NULL, sheets_json TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(space_id, digest)
  );
  CREATE TABLE IF NOT EXISTS warehouse_import_runs (
    id TEXT PRIMARY KEY, file_id TEXT NOT NULL REFERENCES warehouse_import_files(id),
    import_key TEXT NOT NULL UNIQUE, result_json TEXT NOT NULL, created_at TEXT NOT NULL
  );`);
  function file(id) {
    const row = db.prepare("SELECT * FROM warehouse_import_files WHERE id = ?").get(id);
    if (!row) fail("Warehouse import file not found.", 404);
    return { id: row.id, spaceId: row.space_id, name: row.name, digest: row.digest, sheets: JSON.parse(row.sheets_json) };
  }
  function info(id) {
    const result = file(id);
    return { ...result, sheets: result.sheets.map(sheet => ({ name: sheet.name, headers: sheet.rows[0] ?? [], rowCount: Math.max(0, sheet.rows.length - 1), sample: sheet.rows.slice(1, 6) })) };
  }
  async function upload(body) {
    const spaceId = store.spaces.get(body.spaceId ?? "default").id;
    const decoded = decodeFile(body.file, ["xlsx", "csv"]), digest = hash(decoded.bytes);
    const existing = db.prepare("SELECT id FROM warehouse_import_files WHERE space_id = ? AND digest = ?").get(spaceId, digest);
    if (existing) return info(existing.id);
    const parsed = await parseTableFile(body.file);
    return store.transaction(() => {
      const prior = db.prepare("SELECT id FROM warehouse_import_files WHERE space_id = ? AND digest = ?").get(spaceId, digest);
      if (prior) return info(prior.id);
      const id = randomUUID();
      db.prepare("INSERT INTO warehouse_import_files VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, spaceId, decoded.name.replace(/[\\/\x00-\x1f]/g, "_"), digest, decoded.bytes, JSON.stringify(parsed.sheets), new Date().toISOString());
      return info(id);
    });
  }
  function match(body) {
    const source = file(body.fileId), state = store.warehouse.state(source.spaceId);
    if (!state.tables.products) fail("Set up Warehouse Management in this Space first.");
    const sheetIndex = body.sheetIndex ?? 0;
    if (!Number.isInteger(sheetIndex) || !source.sheets[sheetIndex]) fail("Choose a worksheet.");
    const sheet = source.sheets[sheetIndex], headers = (sheet.rows[0] ?? []).map(value => String(value ?? ""));
    const rows = sheet.rows.slice(1).map((cells, index) => ({ cells, row: index + 2 })).filter(row => row.cells.some(v => v !== null && String(v).trim() !== ""));
    if (!rows.length || rows.length > 1000) fail("Import 1-1,000 data rows with the header in the first row.");
    const mapping = {}, errors = [], warnings = [];
    if (body.mapping !== undefined && (!body.mapping || typeof body.mapping !== "object" || Array.isArray(body.mapping))) fail("Choose valid column mappings.");
    for (const [key, choices] of Object.entries(aliases)) {
      const matches = headers.flatMap((h, index) => choices.some(alias => normalized(alias) === normalized(h)) ? [index] : []);
      if (Object.hasOwn(body.mapping ?? {}, key)) {
        const index = body.mapping[key];
        if (index !== null && (!Number.isInteger(index) || index < 0 || index >= headers.length)) fail("Choose valid column mappings.");
        mapping[key] = index;
      } else {
        mapping[key] = matches.length === 1 ? matches[0] : null;
        if (matches.length > 1) errors.push({ row: 1, field: key, message: "Several headers match this field. Choose one column." });
      }
    }
    if (Object.keys(body.mapping ?? {}).some(key => !Object.hasOwn(aliases, key))) fail("Choose valid column mappings.");
    if (mapping.code === null && mapping.name === null) errors.push({ row: 1, field: "code", message: "Map a product code or product name column." });
    if (mapping.quantity === null) errors.push({ row: 1, field: "quantity", message: "Map a quantity column." });
    const used = new Set(Object.values(mapping).filter(index => index !== null));
    if (used.size !== Object.values(mapping).filter(index => index !== null).length) errors.push({ row: 1, message: "A source column cannot map to several fields." });
    for (const [index, header] of headers.entries()) if (!used.has(index)) warnings.push({ column: index + 1, header });
    const defaults = body.values ?? {}, matched = [], groups = new Map();
    const user = store.auth.currentUser();
    if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) fail("Enter request defaults.");
    if (body.kind && !["inbound", "outbound"].includes(body.kind)) fail("Choose inbound or outbound.");
    const lookup = (records, value, key, label) => {
      const found = records.filter(row => identity(row.values[key]) === identity(value));
      if (found.length !== 1) fail(found.length ? `${label} is ambiguous: ${value}` : `${label} was not found: ${value}`);
      return found[0];
    };
    if (!errors.length) for (const row of rows) {
      const cell = key => mapping[key] === null ? "" : String(row.cells[mapping[key]] ?? "").trim();
      try {
        const code = cell("code"), name = cell("name");
        if (!code && !name) fail("Enter a product code or name.");
        const product = lookup(state.products, code || name, code ? "code" : "name", "Product");
        if (code && name && identity(product.values.name) !== identity(name)) fail("Product code and name identify different products.");
        if (!product.values.active) fail("Choose an active product.");
        if (cell("unit") && cell("unit") !== product.values.unit) fail(`Unit does not match the product: ${product.values.unit}`);
        const raw = cell("quantity");
        if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)) fail("Quantity must be a positive number without separators.");
        const quantity = inventoryQuantity(Number(raw), "Line quantity"), notes = cell("notes");
        let warehouse = defaults.warehouse ? state.warehouses.find(r => r.id === defaults.warehouse) : null;
        if (defaults.warehouse && !warehouse) fail("Choose a warehouse in this Space.");
        if (cell("warehouseCode") || cell("warehouse")) {
          const selected = cell("warehouseCode") ? lookup(state.warehouses, cell("warehouseCode"), "code", "Warehouse")
            : state.warehouses.find(r => identity(r.values.code) === identity(cell("warehouse"))) ?? lookup(state.warehouses, cell("warehouse"), "name", "Warehouse");
          if (warehouse && warehouse.id !== selected.id) fail("The row warehouse differs from the selected warehouse.");
          if (cell("warehouseCode") && cell("warehouse") && ![selected.values.code, selected.values.name].some(v => identity(v) === identity(cell("warehouse")))) fail("Warehouse code and name do not match.");
          warehouse = selected;
        }
        const inferred = headers.some(h => h.trim() === "入库数量") && !headers.some(h => h.trim() === "出库数量") ? "inbound" : headers.some(h => h.trim() === "出库数量") && !headers.some(h => h.trim() === "入库数量") ? "outbound" : null;
        const rowKind = cell("kind") ? direction(cell("kind")) : body.kind ?? inferred;
        if (cell("kind") && !rowKind || body.kind && rowKind !== body.kind) fail("The row direction does not match the selected workflow.");
        const line = { product: product.id, quantity, notes };
        matched.push({ row: row.row, ...line, code: product.values.code, name: product.values.name, unit: product.values.unit });
        const values = { ...defaults, ...(warehouse ? { warehouse: warehouse.id } : {}) };
        for (const key of ["applicant", "approver", "applicationDate"]) if (cell(key)) {
          const value = key === "applicationDate" ? cell(key).slice(0, 10) : cell(key);
          if (defaults[key] && defaults[key] !== value) fail(`The row ${key} differs from the request defaults.`);
          values[key] = value;
        }
        if (user) values.applicant = user.username;
        if (!body.linesOnly && (!warehouse || !rowKind)) fail("Choose a direction and warehouse, or map their columns.");
        const key = body.linesOnly ? "lines" : JSON.stringify([rowKind, values, cell("group")]);
        if (!groups.has(key)) groups.set(key, { kind: rowKind, values, lines: [], sourceRows: [] });
        const group = groups.get(key), existing = group.lines.find(l => l.product === line.product);
        if (existing) {
          existing.quantity = inventoryQuantity(new Decimal(existing.quantity).plus(quantity).toNumber(), "Line quantity");
          if (notes && notes !== existing.notes) existing.notes = [existing.notes, notes].filter(Boolean).join("; ");
        } else group.lines.push(line);
        group.sourceRows.push(row.row);
      } catch (error) { errors.push({ row: row.row, message: error.message }); }
    }
    const documents = [...groups.values()];
    if (documents.length > 20 || documents.reduce((n, doc) => n + doc.lines.length, 0) > 100) errors.push({ row: 0, message: "A batch supports up to 20 requests and 100 distinct product lines." });
    return { fileId: source.id, spaceId: source.spaceId, fileName: source.name, sheetIndex, sheetName: sheet.name, headers, mapping, warnings, errors, rowCount: rows.length, matchedRows: matched, documents };
  }
  function keyFor(body, plan) {
    return hash({ fileId: body.fileId, sheetIndex: body.sheetIndex ?? 0, documents: plan.documents.map(({ kind, values, lines }) => ({ kind, values, lines })) });
  }
  function previous(body, plan) {
    const row = db.prepare("SELECT result_json FROM warehouse_import_runs WHERE import_key = ?").get(keyFor(body, plan));
    return row ? JSON.parse(row.result_json) : null;
  }
  function run(plan, body) {
    const stage = body.stage ?? "submit";
    if (!["draft", "submit", "post"].includes(stage)) fail("Choose a workflow completion stage.");
    if (stage === "post" && (typeof body.approvalActor !== "string" || !body.approvalActor.trim())) fail("Enter the assigned approver to complete workflows.");
    return plan.documents.map(doc => {
      let result = store.warehouse.createDocument({ spaceId: plan.spaceId, kind: doc.kind, values: doc.values, lines: doc.lines, submit: stage !== "draft", actor: body.actor || doc.values.applicant });
      if (stage === "post") {
        result = store.warehouse.transition(result.record.id, { action: "approve", version: result.record.version, actor: body.approvalActor });
        result = store.warehouse.transition(result.record.id, { action: "post", version: result.record.version, actor: body.actor || body.approvalActor });
      }
      return { id: result.record.id, formId: result.record.formId, number: result.record.values.number, status: result.record.values.status, kind: doc.kind, lines: doc.lines.length };
    });
  }
  function preview(body) {
    const plan = match(body), saved = previous(body, plan);
    const fingerprint = hash({ body: { ...body, fingerprint: undefined }, data: store.automation.fingerprint(plan.spaceId) });
    if (saved) return { ...plan, alreadySaved: true, result: saved, fingerprint };
    let changes = [];
    if (!plan.errors.length) {
      try { changes = store.preview(() => { run(plan, body); return store.automation.changes(); }); }
      catch (error) { plan.errors.push({ row: 0, message: error.message }); }
    }
    return { ...plan, fingerprint, stage: body.stage ?? "submit", changes };
  }
  function execute(body) {
    return store.transaction(() => {
      const checked = match(body), saved = previous(body, checked);
      if (saved) return { ...saved, alreadySaved: true };
      const fingerprint = hash({ body: { ...body, fingerprint: undefined }, data: store.automation.fingerprint(checked.spaceId) });
      if (body.fingerprint !== fingerprint) fail("Warehouse import data changed. Preview this batch again.", 409);
      if (checked.errors.length) fail("Correct all import errors before running the workflows.");
      const documents = run(checked, body), result = { documents, fileId: body.fileId, stage: body.stage ?? "submit" };
      db.prepare("INSERT INTO warehouse_import_runs VALUES (?, ?, ?, ?, ?)").run(randomUUID(), body.fileId, keyFor(body, checked), JSON.stringify(result), new Date().toISOString());
      return result;
    });
  }
  return { upload, info, match, preview, execute };
}
