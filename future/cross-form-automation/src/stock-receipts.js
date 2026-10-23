import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { AppError } from "./errors.js";
import { inventoryQuantity } from "./inventory-repository.js";

const D = Decimal.clone({ precision: 40 });
const fail = (message, status = 400) => { throw new AppError(status, message); };
const comparable = (value) => typeof value === "string" ? value.trim().toLowerCase() : value;
const keyTypes = ["text", "select", "number", "reference"];
const fieldContract = (field) => ({ id: field.id, type: field.type, reference: field.reference ?? null, formula: field.formula ?? null });

export function createStockReceipts({ db, store }) {
  db.exec(`CREATE TABLE IF NOT EXISTS stock_receipts (
    id TEXT PRIMARY KEY, source_record_id TEXT NOT NULL UNIQUE REFERENCES records(id),
    space_id TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
  )`);
  function parse(row) {
    if (!row) fail("Stock receipt not found.", 404);
    const item = { ...JSON.parse(row.payload_json), id: row.id, spaceId: row.space_id, createdAt: row.created_at };
    if (item.postingId) item.reversed = Boolean(store.inventory.posting(item.postingId).reversedBy);
    return item;
  }
  const get = (id) => parse(db.prepare("SELECT * FROM stock_receipts WHERE id = ?").get(id));
  const list = (spaceId) => db.prepare("SELECT * FROM stock_receipts WHERE space_id = ? ORDER BY created_at, id").all(spaceId).map(parse);
  const save = (id, item) => db.prepare("UPDATE stock_receipts SET payload_json = ? WHERE id = ?").run(JSON.stringify(item), id);
  const ledgerTarget = (formId) => store.inventory.tables().materials === formId;

  function validate(action, source, target) {
    if (!source || !target || source.id === target.id || source.spaceId !== target.spaceId) fail("Choose a stock form in the same Space, different from the receipt form.");
    const field = (form, id) => form.fields.find((item) => item.id === id);
    const item = field(source, action.itemField), quantity = field(source, action.quantityField), match = field(target, action.matchField);
    if (!item || !match || !keyTypes.includes(item.type) || !keyTypes.includes(match.type) || item.formula || match.formula) fail("Choose non-calculated material matching fields.");
    const directReference = item.type === "reference" && item.reference.formId === target.id;
    const sameReference = item.type === "reference" && match.type === "reference" && item.reference.formId === match.reference.formId && item.reference.fieldId === match.reference.fieldId;
    if (!directReference && !sameReference && !(item.type === "number" && match.type === "number") &&
        !(["text", "select"].includes(item.type) && ["text", "select"].includes(match.type))) fail("Material matching fields must have compatible types or reference the stock form.");
    if (quantity?.type !== "number" || quantity.formula || quantity.id === item.id) fail("Choose a non-calculated numeric received quantity field.");
    const ledger = ledgerTarget(target.id), stock = field(target, action.stockField);
    if (!ledger && (stock?.type !== "number" || stock.formula || stock.unique || stock.id === match.id)) fail("Choose an editable, non-unique numeric stock field.");
    if (ledger && action.stockField) fail("Materials stock uses the inventory ledger.");
    const sourceUnit = field(source, action.sourceUnitField), targetUnit = field(target, ledger ? "unit" : action.targetUnitField);
    if (ledger || action.sourceUnitField || action.targetUnitField) {
      if (!sourceUnit || !targetUnit || !["text", "select"].includes(sourceUnit.type) || !["text", "select"].includes(targetUnit.type) || sourceUnit.formula || targetUnit.formula || targetUnit.id === match.id || sourceUnit.id === item.id) fail("Choose separate receipt and stock unit fields.");
    }
    const mapped = new Set([match.id, ledger ? null : stock.id, targetUnit?.id]);
    const defaults = action.newRecordValues ?? {};
    if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) fail("Configure new material values.");
    for (const [id, value] of Object.entries(defaults)) {
      const destination = field(target, id);
      if (!destination || destination.formula || mapped.has(id)) fail("New material values cannot override matched material, quantity or unit fields.");
      if (!value || !["literal", "field", "empty"].includes(value.kind) || value.kind === "field" && (value.scope !== "source" || value.formId && value.formId !== source.id)) fail("New material values must be fixed values or receipt fields.");
      store.automation.validateValue(value, source, target, source.spaceId);
      if (value.kind === "empty" && destination.required) fail("Required new material fields cannot be empty.");
    }
    if (!directReference && target.fields.some((f) => f.required && !f.formula && !mapped.has(f.id) && (!Object.hasOwn(defaults, f.id) || defaults[f.id].kind === "empty" || defaults[f.id].kind === "literal" && (defaults[f.id].value == null || defaults[f.id].value === "")))) fail("Map every required field in New material values.");
    return { item, quantity, match, stock, sourceUnit, targetUnit, ledger, directReference };
  }
  function balance(materialId) {
    return store.inventory.entries().filter((entry) => entry.materialId === materialId)
      .reduce((total, entry) => entry.direction === "In" ? total.plus(entry.quantity) : total.minus(entry.quantity), new D(0));
  }
  function stockEffect(formId, recordId, before, after) {
    store.automation.effect({ kind: "stock_received", formId, recordId, before: { "Stock balance": before.toFixed() }, after: { "Stock balance": after.toFixed() } });
  }
  function execute(action, event, rule) {
    return store.transaction(() => {
      const source = store.getForm(event.formId), target = store.getForm(action.formId);
      const checked = validate(action, source, target);
      if (event.kind !== "created" || !event.after) fail("Receive stock requires a newly created receipt record.");
      const previous = db.prepare("SELECT * FROM stock_receipts WHERE source_record_id = ?").get(event.recordId);
      if (previous) fail("This receipt already has a stock operation. Configure only one Receive stock action per receipt.", 409);
      if (store.inventory.activeForSource(event.recordId)) fail("Stock has already been posted for this record.", 409);
      const { item, quantity, match, stock, sourceUnit, targetUnit, ledger, directReference } = checked;
      const key = event.after[item.id];
      if (key == null || key === "") fail("The receipt material cannot be empty.");
      const amount = new D(inventoryQuantity(event.after[quantity.id], "Received quantity"));
      const unit = sourceUnit ? event.after[sourceUnit.id] : null;
      if (sourceUnit && (typeof unit !== "string" || !unit.trim())) fail("The receipt unit cannot be empty.");
      const matches = store.listRecords(target.id).filter((record) => directReference ? record.id === key : comparable(record.values[match.id]) === comparable(key));
      if (matches.length > 1) fail("Multiple materials match this receipt. Use a unique material code or remove duplicate materials.", 409);
      if (directReference && !matches.length) fail("The referenced material no longer exists.", 409);
      let material = matches[0];
      if (material && targetUnit && comparable(material.values[targetUnit.id]) !== comparable(unit)) fail("Receipt and stock units do not match. Unit conversion is not automatic.", 409);
      const sourceFields = [item, quantity, sourceUnit].filter(Boolean);
      const targetFields = [match, ledger ? null : stock, targetUnit].filter(Boolean);
      const id = randomUUID();
      const receipt = { sourceFormId: source.id, sourceRecordId: event.recordId, targetFormId: target.id,
        ruleId: rule.id, ruleName: rule.name, materialId: material?.id ?? null, quantity: amount.toNumber(), unit,
        stockField: ledger ? null : stock.id, matchField: match.id, unitField: targetUnit?.id ?? null,
        sourceValues: Object.fromEntries(sourceFields.map((f) => [f.id, event.after[f.id] ?? null])),
        sourceFields: sourceFields.map(fieldContract), targetFields: targetFields.map(fieldContract), reversed: false };
      // Reserve the receipt before cascading record writes so a recursive rule cannot receive it twice.
      db.prepare("INSERT INTO stock_receipts VALUES (?, ?, ?, ?, ?)").run(id, event.recordId, source.spaceId, JSON.stringify(receipt), new Date().toISOString());
      let before = ledger ? (material ? balance(material.id) : new D(0)) : new D(material?.values[stock.id] ?? 0);
      if (!before.isFinite() || before.lt(0)) fail("Stock balance must be nonnegative.");
      const after = before.plus(amount);
      if (after.gt(1e15) || !new D(after.toNumber()).eq(after)) fail("The resulting stock balance cannot be stored exactly within the supported numeric range.");
      if (!material) {
        const values = Object.fromEntries(Object.entries(action.newRecordValues ?? {}).map(([fieldId, value]) => [fieldId, store.automation.value(value, { event, spaceId: source.spaceId })]));
        values[match.id] = key;
        if (targetUnit) values[targetUnit.id] = unit;
        if (!ledger) values[stock.id] = after.toNumber();
        material = store.createRecord(target.id, { schemaVersion: target.version, values }).record;
      } else if (!ledger) {
        material = store.updateRecord(material.id, { schemaVersion: target.version, version: material.version, values: { [stock.id]: after.toNumber() } }).record;
      }
      receipt.materialId = material.id;
      receipt.materialValues = Object.fromEntries([match.id, targetUnit?.id].filter(Boolean).map((fieldId) => [fieldId, material.values[fieldId]]));
      if (ledger) {
        // A material-creation cascade may itself have posted stock; read the balance again.
        before = balance(material.id);
        const posting = store.inventory.savePosting({ kind: "receipt", source: { recordId: event.recordId, formId: source.id,
          title: String(event.after[source.fields.find((f) => f.unique)?.id] ?? key), stockValues: receipt.sourceValues },
          lines: [{ materialId: material.id, sku: material.values.sku, name: material.values.name, unit: material.values.unit,
            direction: "In", quantity: amount.toFixed(), before: before.toFixed(), after: before.plus(amount).toFixed() }], note: rule.name }, `receipt_${id}`, id);
        receipt.postingId = posting.id;
        stockEffect(target.id, material.id, before, before.plus(amount));
      }
      receipt.before = before.toFixed(); receipt.after = before.plus(amount).toFixed();
      save(id, receipt);
      return { receiptId: id, targetFormId: target.id, recordIds: [material.id], outcome: matches.length ? "updated" : "created", quantity: amount.toNumber(), before: receipt.before, after: receipt.after };
    });
  }
  function reverse(id, note) {
    return store.transaction(() => {
      const receipt = get(id);
      try {
        if (receipt.reversed) return { receipt, alreadyReversed: true };
        if (typeof note !== "string" || !note.trim() || note.length > 1000) fail("Enter a reason for reversing the receipt.");
        const target = store.getForm(receipt.targetFormId), material = store.getRecord(receipt.materialId);
        const before = receipt.postingId ? balance(material.id) : new D(material.values[receipt.stockField] ?? 0);
        const after = before.minus(receipt.quantity);
        if (after.lt(0)) fail("This receipt cannot be reversed because its stock has already been consumed.", 409);
        if (!receipt.postingId && (!after.isFinite() || after.gt(1e15) || !new D(after.toNumber()).eq(after))) fail("The resulting stock balance cannot be stored exactly within the supported numeric range.");
        receipt.reversed = true; receipt.reversedAt = new Date().toISOString(); receipt.reversalNote = note.trim();
        save(id, receipt);
        if (receipt.postingId) {
          const original = store.inventory.posting(receipt.postingId);
          store.inventory.savePosting({ kind: "reversal", source: original.source, reverses: original.id, note: note.trim(),
            lines: original.lines.map((line) => ({ ...line, direction: "Out", before: before.toFixed(), after: after.toFixed() })) }, `receipt_reversal_${id}`, id);
          stockEffect(target.id, material.id, before, after);
        } else {
          store.updateRecord(material.id, { schemaVersion: target.version, version: material.version, values: { [receipt.stockField]: after.toNumber() } });
        }
        return { receipt: get(id), alreadyReversed: false };
      } catch (error) {
        error.operationContext ??= { operation: "reverse_stock_receipt", spaceId: receipt.spaceId, formId: receipt.sourceFormId, recordId: receipt.sourceRecordId, receiptId: id };
        throw error;
      }
    });
  }
  function assertWrite(form, previous, values) {
    if (!previous) return;
    for (const receipt of list(form.spaceId).filter((item) => !item.reversed)) {
      if (receipt.sourceRecordId === previous.id && Object.entries(receipt.sourceValues).some(([id, value]) => JSON.stringify(values[id] ?? null) !== JSON.stringify(value))) fail("Reverse the stock receipt before changing its material, quantity or unit.", 409);
      if (receipt.materialId === previous.id && Object.entries(receipt.materialValues ?? {}).some(([id, value]) => comparable(values[id]) !== comparable(value))) fail("Reverse active stock receipts before changing the material identity or unit.", 409);
    }
  }
  function assertDelete(record) {
    if (list(store.getForm(record.formId).spaceId).some((item) => !item.reversed && [item.sourceRecordId, item.materialId].includes(record.id))) fail("Reverse active stock receipts before deleting this record.", 409);
  }
  function assertSchema(form, fields) {
    for (const receipt of list(form.spaceId).filter((item) => !item.reversed)) {
      const contracts = receipt.sourceFormId === form.id ? receipt.sourceFields : receipt.targetFormId === form.id ? receipt.targetFields : [];
      for (const contract of contracts) {
        const field = fields.find((item) => item.id === contract.id);
        if (!field || JSON.stringify(fieldContract(field)) !== JSON.stringify(contract) || contract.id === receipt.stockField && field.unique) fail("Reverse active stock receipts before removing or changing mapped field types or formulas.", 409);
      }
    }
  }
  return { validate, execute, get, list, reverse, assertWrite, assertDelete, assertSchema };
}
