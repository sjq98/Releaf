import Decimal from "decimal.js";
import { AppError } from "./errors.js";

const D = Decimal.clone({ precision: 40 });
const singaporeDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Singapore", year: "numeric", month: "2-digit", day: "2-digit",
});
const fail = message => { throw new AppError(400, message); };
const value = input => input === undefined || input === null || input === "" ? null : input;
const number = input => new D(input ?? 0);
const output = input => input.toNumber();

function dateKey(input) {
  const date = new Date(input);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = Object.fromEntries(singaporeDate.formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function monthIndex(input, name) {
  if (typeof input !== "string" || !/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(input)) fail(`${name} must use YYYY-MM format.`);
  const [year, month] = input.split("-").map(Number);
  return year * 12 + month - 1;
}

function monthKey(index) {
  return `${String(Math.floor(index / 12)).padStart(4, "0")}-${String(index % 12 + 1).padStart(2, "0")}`;
}

function selection(input, name) {
  const selected = value(input);
  if (selected !== null && (typeof selected !== "string" || selected.length > 200)) fail(`Choose a valid ${name}.`);
  return selected;
}

export function createWarehouseDashboard({ db, store, now = () => new Date() }) {
  function report(query = {}) {
    if (!query || typeof query !== "object" || Array.isArray(query)) fail("Dashboard filters must be an object.");
    const instant = now(), currentDate = dateKey(instant);
    const spaceId = selection(query.spaceId, "Space") ?? "default";
    store.spaces.get(spaceId);
    const to = value(query.to) ?? currentDate.slice(0, 7), end = monthIndex(to, "To month");
    const from = value(query.from) ?? monthKey(end - 5), start = monthIndex(from, "From month");
    if (start > end) fail("From month must not be later than to month.");
    if (end - start >= 24) fail("Choose a date range of no more than 24 months.");
    const warehouseId = selection(query.warehouseId, "warehouse"), productId = selection(query.productId, "product");
    const tables = store.warehouse.tableIds(spaceId);
    const records = role => tables[role] ? store.listRecords(tables[role]) : [];
    const warehouses = records("warehouses"), products = records("products"), stock = records("stock");
    const warehouseById = new Map(warehouses.map(record => [record.id, record]));
    const productById = new Map(products.map(record => [record.id, record]));
    if (warehouseId && !warehouseById.has(warehouseId)) fail("Choose a warehouse in this Space.");
    if (productId && !productById.has(productId)) fail("Choose a product in this Space.");
    const units = [...new Set([...products, ...stock].map(record => record.values.unit).filter(unit => typeof unit === "string" && unit))].sort();
    const selectedUnit = selection(query.unit, "unit"), productUnit = productById.get(productId)?.values.unit;
    if (selectedUnit && !units.includes(selectedUnit)) fail("Choose an available inventory unit.");
    if (selectedUnit && productUnit && selectedUnit !== productUnit) fail(`This product uses ${productUnit}. Choose that unit or clear the product filter.`);
    const unit = selectedUnit ?? productUnit ?? (units.includes("kg") ? "kg" : units[0] ?? null);
    const filters = { from, to, warehouseId, productId, unit };
    const available = {
      warehouses: warehouses.map(record => ({ id: record.id, code: record.values.code, name: record.values.name })).sort((a, b) => a.code.localeCompare(b.code)),
      products: products.map(record => ({ id: record.id, code: record.values.code, name: record.values.name, unit: record.values.unit })).sort((a, b) => a.code.localeCompare(b.code)),
      units,
    };
    const stocks = stock.filter(record => (!warehouseId || record.values.warehouse === warehouseId)
      && (!productId || record.values.product === productId) && (!unit || record.values.unit === unit));
    const stockById = new Map(stocks.map(record => [record.id, record]));
    const metadata = record => ({
      stockId: record.id, productId: record.values.product, code: record.values.code, name: record.values.name,
      warehouseId: record.values.warehouse, warehouseName: warehouseById.get(record.values.warehouse)?.values.name ?? "",
      unit: record.values.unit,
    });
    const warnings = stocks.map(record => {
      const quantity = number(record.values.currentQuantity), minimum = number(record.values.minimum);
      return {
        ...metadata(record), currentQuantity: output(quantity), minimum: output(minimum),
        shortage: output(D.max(minimum.minus(quantity), 0)), isLow: quantity.lt(minimum),
      };
    }).sort((a, b) => Number(b.isLow) - Number(a.isLow) || b.shortage - a.shortage
      || a.code.localeCompare(b.code) || a.warehouseName.localeCompare(b.warehouseName));
    const documents = ["inbound", "outbound"].flatMap(kind => records(kind).map(record => ({ ...record, kind })));
    const documentById = new Map(documents.map(record => [record.id, record]));
    const months = Array.from({ length: end - start + 1 }, (_, index) => monthKey(start + index));
    const totals = new Map(months.map(month => [month, { inbound: new D(0), outbound: new D(0) }]));
    const movementsByStock = new Map(stocks.map(record => [record.id, []]));
    const inboundDocuments = new Set(), outboundDocuments = new Set();
    // Read the full immutable ledger; the activity view intentionally keeps only its latest 1,000 rows.
    for (const movement of db.prepare("SELECT * FROM warehouse_movements WHERE space_id = ? ORDER BY rowid").all(spaceId)) {
      if (!stockById.has(movement.stock_id)) continue;
      const document = documentById.get(movement.document_id);
      if (!document || !["Posted", "Reversed"].includes(document.values.status)) continue;
      const effectiveDate = movement.reversal ? dateKey(movement.created_at) : document.values.postedDate;
      if (typeof effectiveDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) continue;
      const month = effectiveDate.slice(0, 7), quantity = number(movement.quantity);
      const signed = movement.direction === "In" ? quantity : quantity.negated();
      movementsByStock.get(movement.stock_id).push({ month, signed, quantity, reversal: Boolean(movement.reversal), kind: document.kind });
      if (month < from || month > to || movement.reversal) continue;
      const point = totals.get(month);
      if (!point) continue;
      if (document.kind === "inbound") {
        point.inbound = point.inbound.plus(quantity); inboundDocuments.add(document.id);
      } else {
        point.outbound = point.outbound.plus(quantity); outboundDocuments.add(document.id);
      }
    }
    const reportRows = [];
    for (const record of stocks) {
      const history = movementsByStock.get(record.id), monthly = new Map();
      let opening = number(record.values.openingQuantity);
      for (const movement of history) {
        if (movement.month < from) opening = opening.plus(movement.signed);
        if (movement.month < from || movement.month > to) continue;
        const bucket = monthly.get(movement.month) ?? { inbound: new D(0), outbound: new D(0), adjustment: new D(0) };
        if (movement.reversal) bucket.adjustment = bucket.adjustment.plus(movement.signed);
        else if (movement.kind === "inbound") bucket.inbound = bucket.inbound.plus(movement.quantity);
        else bucket.outbound = bucket.outbound.plus(movement.quantity);
        monthly.set(movement.month, bucket);
      }
      for (const month of months) {
        const bucket = monthly.get(month) ?? { inbound: new D(0), outbound: new D(0), adjustment: new D(0) };
        const netChange = bucket.inbound.minus(bucket.outbound).plus(bucket.adjustment), closing = opening.plus(netChange);
        const average = opening.plus(closing).dividedBy(2);
        const rate = bucket.outbound.isZero() ? new D(0) : average.gt(0) ? bucket.outbound.dividedBy(average) : null;
        const [year, monthNumber] = month.split("-").map(Number), days = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
        reportRows.push({
          ...metadata(record), month, openingQuantity: output(opening), closingQuantity: output(closing),
          inboundQuantity: output(bucket.inbound), outboundQuantity: output(bucket.outbound), adjustmentQuantity: output(bucket.adjustment),
          netChange: output(netChange), turnoverRate: rate === null ? null : output(rate),
          turnoverDays: rate?.gt(0) ? output(new D(days).dividedBy(rate)) : null, days,
        });
        opening = closing;
      }
    }
    reportRows.sort((a, b) => b.month.localeCompare(a.month) || a.code.localeCompare(b.code) || a.warehouseName.localeCompare(b.warehouseName));
    const pendingProductIds = new Set(products.filter(record => (!productId || record.id === productId) && (!unit || record.values.unit === unit)).map(record => record.id));
    const pendingDocumentIds = new Set(["inboundLines", "outboundLines"].flatMap(role => records(role))
      .filter(record => pendingProductIds.has(record.values.product)).map(record => record.values.document));
    const pendingDocuments = documents.filter(record => ["Pending approval", "Approved"].includes(record.values.status)
      && (!warehouseId || record.values.warehouse === warehouseId) && pendingDocumentIds.has(record.id)
      && typeof record.values.applicationDate === "string" && record.values.applicationDate.slice(0, 7) >= from && record.values.applicationDate.slice(0, 7) <= to).length;
    const inventory = new Map();
    for (const record of stocks) inventory.set(record.values.unit, (inventory.get(record.values.unit) ?? new D(0)).plus(record.values.currentQuantity ?? 0));
    return {
      setupRequired: !tables.stock, filters, available, tables,
      summary: {
        stockItems: stocks.length, lowStockItems: warnings.filter(row => row.isLow).length,
        inboundDocuments: inboundDocuments.size, outboundDocuments: outboundDocuments.size, pendingDocuments,
        inventory: [...inventory].map(([unit, quantity]) => ({ unit, quantity: output(quantity) })),
      },
      trends: { unit, points: months.map(month => ({ month, inbound: output(totals.get(month).inbound), outbound: output(totals.get(month).outbound) })) },
      warnings, reportRows, updatedAt: new Date(instant).toISOString(),
      computation: { turnoverBasis: "quantity", reversalBasis: "signed-adjustment-at-reversal-date", currentBalanceBasis: "stock-record" },
    };
  }
  return { report };
}
