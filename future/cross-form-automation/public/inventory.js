import { html, uiText, setUIText, uiAttributes, t } from "/i18n.js";
export function initInventory({ api, icons, toast, getState, refresh }) {
  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const icon = (name) => html`<i data-lucide="${name}" aria-hidden="true"></i>`;
  const link = (formId, id, title) => html`<a class="reference-link" data-reference href="?formId=${encodeURIComponent(formId)}&recordId=${encodeURIComponent(id)}#records">${icon("external-link")}<span>${esc(title)}</span></a>`;
  const data = () => getState().inventory || { summary: [], movements: [], activeSources: {}, mappings: [] };
  const badge = (direction) => html`<span class="status-badge ${direction === "In" ? "stock-in" : "stock-out"}">${icon(direction === "In" ? "arrow-down-left" : "arrow-up-right")}${uiText(direction)}</span>`;
  const error = (id, message = "") => { setUIText($(id), message); $(id).hidden = !message; };
  const filter = (id, label, options) => html`<label class="filter-select">${icon("list-filter")}<select id="${id}" aria-label="${label}">${options.map(([value, name]) => html`<option value="${value}">${uiText(name)}</option>`).join("")}</select>${icon("chevron-down")}</label>`;
  for (const [view, heading] of [["stock", "Stock summary"], ["movements", "Stock movements"]]) {
    $(`view-${view}`).innerHTML = html`
      <div class="page-heading"><div><div class="eyebrow">INVENTORY MANAGEMENT</div><h1>${uiText(heading)}</h1></div><div class="heading-actions"><button class="icon-button toolbar-icon" data-inventory-settings title="Order field mapping" aria-label="Order field mapping">${icon("settings-2")}</button><button class="button button-primary" data-stock-adjust>${icon("plus")}<span>Stock adjustment</span></button></div></div>
      ${view === "stock" ? html`<div class="metrics stock-metrics" aria-label="Inventory overview">${[["materials", "Materials", "boxes"], ["low", "Low stock", "triangle-alert"], ["postings", "Posted operations", "clipboard-check"], ["movements", "Stock movements", "arrow-right-left"]].map(([id, name, glyph]) => html`<div class="metric"><span class="metric-label">${uiText(name)}</span><strong class="metric-value" id="stock-metric-${id}">0</strong><span class="metric-foot">${icon(glyph)}</span></div>`).join("")}</div>` : ""}
      <div class="section-heading"><div><h2>${uiText(view === "stock" ? "Material balances" : "Movement ledger")}</h2><span class="section-count" id="${view}-count"></span></div></div>
      <div class="toolbar stock-toolbar"><label class="search-box">${icon("search")}<input id="${view}-search" type="search" placeholder="Search materials or sources..." aria-label="Search ${heading.toLowerCase()}"></label><div class="toolbar-spacer"></div>${view === "stock" ? filter("stock-filter", "Filter stock status", [["all", "All materials"], ["low", "Low stock"]]) : filter("movement-filter", "Filter stock direction", [["all", "All movements"], ["In", "In"], ["Out", "Out"]])}<button class="icon-button toolbar-icon" data-stock-export="${view}" title="Export CSV" aria-label="Export ${heading.toLowerCase()}">${icon("download")}</button><button class="icon-button toolbar-icon" data-stock-refresh title="Refresh inventory" aria-label="Refresh inventory">${icon("refresh-cw")}</button></div>
      <div class="table-clip"><table class="data-table stock-table" aria-label="${heading}"><thead><tr>${(view === "stock" ? ["Material", "On hand", "Unit", "Total in", "Total out", "Reorder level", "Status"] : ["Posted", "Material", "Direction", "Quantity", "Unit", "Source", "Reason", ""]).map((name) => html`<th>${name ? uiText(name) : html`<span class="sr-only">Actions</span>`}</th>`).join("")}</tr></thead><tbody id="${view}-rows"></tbody></table><div class="empty-state" id="${view}-empty" hidden><span class="empty-mark">${icon(view === "stock" ? "boxes" : "arrow-right-left")}</span><h3>${uiText(view === "stock" ? "No matching materials" : "No stock movements")}</h3></div></div>
      <div class="list-footer"><span id="${view}-sync"></span><span>${icon("database")}Local workspace</span></div>`;
  }
  const postDialog = document.createElement("dialog");
  postDialog.className = "modal stock-post-dialog";
  postDialog.id = "stock-post-dialog";
  postDialog.setAttribute("aria-labelledby", "stock-post-title");
  postDialog.innerHTML = html`<form id="stock-post-form"><div class="modal-heading"><div><span class="eyebrow">INVENTORY</span><h2 id="stock-post-title">Stock posting</h2></div><button type="button" class="icon-button" data-stock-close title="Close stock posting" aria-label="Close stock posting">${icon("x")}</button></div>
    <div id="stock-source" class="stock-source"></div>
    <div id="stock-adjust-fields" class="workflow-grid" hidden><label class="input-field"><span class="builder-label">Material</span><select id="stock-material" class="standalone-input"></select></label><label class="input-field"><span class="builder-label">Direction</span><select id="stock-direction" class="standalone-input"><option>In</option><option>Out</option></select></label><label class="input-field"><span class="builder-label">Quantity</span><input id="stock-quantity" class="standalone-input" type="number" min="0.000001" max="1000000000000" step="any"></label></div>
    <label class="input-field stock-note-field"><span class="builder-label" id="stock-note-label">Note</span><textarea class="standalone-input" id="stock-note" rows="2" maxlength="1000"></textarea></label>
    <div class="stock-preview-heading"><h3>Stock change preview</h3><button class="button button-secondary" id="stock-preview-button">${icon("eye")}<span>Preview</span></button></div>
    <div id="stock-preview" hidden></div><div id="stock-post-error" class="form-error" role="alert" hidden></div>
    <div class="modal-actions"><button type="button" class="button button-secondary" data-stock-close>Cancel</button><button type="button" class="button button-primary" id="stock-confirm" disabled>${icon("check")}<span>Confirm posting</span></button></div></form>`;
  const mappingDialog = document.createElement("dialog");
  mappingDialog.className = "modal";
  mappingDialog.id = "stock-mapping-dialog";
  mappingDialog.setAttribute("aria-labelledby", "stock-mapping-title");
  mappingDialog.innerHTML = html`<form id="stock-mapping-form"><div class="modal-heading"><div><span class="eyebrow">INVENTORY SETTINGS</span><h2 id="stock-mapping-title">Order field mapping</h2></div><button type="button" class="icon-button" data-mapping-close title="Close order mapping" aria-label="Close order mapping">${icon("x")}</button></div><div class="form-fields">
    <label class="input-field"><span class="builder-label">Order table</span><select id="stock-order-table" class="standalone-input" required></select></label>
    <label class="input-field"><span class="builder-label">Product code / name / reference</span><select id="stock-item-field" class="standalone-input" required></select></label>
    <label class="input-field"><span class="builder-label">Order quantity</span><select id="stock-quantity-field" class="standalone-input" required></select></label></div>
    <div id="stock-mapping-error" class="form-error" role="alert" hidden></div><div class="modal-actions"><button type="button" class="button button-secondary" data-mapping-close>Cancel</button><button class="button button-primary" id="stock-mapping-save">${icon("check")}<span>Save mapping</span></button></div></form>`;
  document.body.append(postDialog, mappingDialog);
  let current, preview, requestKey, busy = false;
  const kinds = { order: "Issue order stock", purchase: "Receive purchase", receipt: "Receive stock", adjustment: "Stock adjustment", reversal: "Reverse stock posting" };

  function summaryRows() {
    const q = $("stock-search").value.toLowerCase().trim();
    return data().summary.filter((row) => (!$("stock-filter").value || $("stock-filter").value === "all" || row.lowStock) &&
      `${row.sku} ${row.name} ${row.unit}`.toLowerCase().includes(q));
  }
  function movementRows() {
    const q = $("movements-search").value.toLowerCase().trim(), direction = $("movement-filter").value;
    return data().movements.filter((row) => (direction === "all" || row.direction === direction) &&
      `${row.sku} ${row.name} ${row.source?.title || ""} ${row.note} ${row.kind}`.toLowerCase().includes(q));
  }
  function render() {
    const state = getState(), value = data(), summaries = summaryRows(), movements = movementRows();
    for (const [id, count] of Object.entries({ materials: value.summary.length, low: value.summary.filter((row) => row.lowStock).length,
      postings: new Set(value.movements.map((row) => row.postingId)).size, movements: value.movements.length })) {
      $(`stock-metric-${id}`).textContent = count;
    }
    $("stock-rows").innerHTML = summaries.map((row) => html`<tr><td>${link(state.inventoryTables.materials, row.materialId, row.sku)}<span class="cell-subtitle">${esc(row.name)}</span></td><td class="stock-number"><strong>${esc(row.onHand)}</strong></td><td>${esc(row.unit)}</td><td class="stock-number">${esc(row.incoming)}</td><td class="stock-number">${esc(row.outgoing)}</td><td class="stock-number">${esc(row.reorderLevel)}</td><td><span class="status-badge ${row.lowStock ? "status-warning" : "status-success"}">${uiText(row.lowStock ? "Low stock" : "In stock")}</span></td></tr>`).join("");
    const rendered = new Set();
    $("movements-rows").innerHTML = movements.map((row) => {
      const actionable = !row.reversedBy && row.kind !== "reversal" && !rendered.has(row.postingId);
      rendered.add(row.postingId);
      return html`<tr><td class="updated-cell">${esc(new Date(row.createdAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }))}</td><td>${link(state.inventoryTables.materials, row.materialId, row.sku)}<span class="cell-subtitle">${esc(row.name)}</span></td><td>${badge(row.direction)}</td><td class="stock-number">${esc(row.quantity)}</td><td>${esc(row.unit)}</td><td>${row.source ? link(row.source.formId, row.source.recordId, row.source.title) : html`<span class="muted">Adjustment</span>`}<span class="cell-subtitle">${uiText({ order: "Order issue", purchase: "Purchase receipt", receipt: "Receive stock", adjustment: "Adjustment", reversal: "Reversal" }[row.kind])}${row.reversedBy ? " · Reversed" : ""}</span></td><td><span class="stock-reason">${esc(row.note || "-")}</span></td><td>${actionable ? html`<button class="icon-button" data-stock-reverse="${row.postingId}" title="Reverse entire stock posting" aria-label="Reverse posting ${esc(row.source?.title || row.sku)}">${icon("undo-2")}</button>` : ""}</td></tr>`;
    }).join("");
    for (const [view, rows] of [["stock", summaries], ["movements", movements]]) {
      setUIText($(`${view}-count`), `${rows.length} ${view === "stock" ? "materials" : "movements"}`);
      $(`${view}-empty`).hidden = rows.length > 0;
      setUIText($(`${view}-sync`), `Last synced ${new Date().toLocaleTimeString("en-GB", { hour12: false })}`);
    }
    icons();
  }
  function lock(value) {
    busy = value;
    postDialog.querySelectorAll("input,select,textarea,button").forEach((node) => { node.disabled = value; });
    $("stock-confirm").disabled = value || !preview?.canPost;
  }
  function invalidate() {
    preview = null; requestKey = null;
    $("stock-preview").hidden = true;
    $("stock-confirm").disabled = true;
    error("stock-post-error");
  }
  function body() {
    return { ...current, note: $("stock-note").value,
      ...(current.kind === "adjustment" ? { materialId: $("stock-material").value, direction: $("stock-direction").value, quantity: Number($("stock-quantity").value) } : {}) };
  }
  async function loadPreview() {
    if (busy) return;
    invalidate(); lock(true);
    try {
      preview = await api("/api/inventory/preview", { method: "POST", body: JSON.stringify(body()) });
      requestKey = crypto.randomUUID();
      if (preview.source) $("stock-source").innerHTML = html`<strong>${esc(preview.source.title)}</strong>${preview.source.product ? html`<span>${esc(preview.source.product.quantity)} × ${esc(preview.source.product.name)}</span>` : ""}`;
      $("stock-preview").innerHTML = html`<div class="table-clip stock-preview-table"><table class="data-table" aria-label="Stock change preview"><thead><tr>${["Material", "Direction", "Quantity", "Unit", "Before", "After"].map((name) => html`<th>${uiText(name)}</th>`).join("")}</tr></thead><tbody>${preview.lines.map((line) => html`<tr${line.after.startsWith("-") ? ' class="import-row-error"' : ""}><td><strong>${esc(line.sku)}</strong><span class="cell-subtitle">${esc(line.name)}${line.perProduct ? ` · ${esc(line.perProduct)} / product` : ""}</span></td><td>${badge(line.direction)}</td><td class="stock-number">${esc(line.quantity)}</td><td>${esc(line.unit)}</td><td class="stock-number">${esc(line.before)}</td><td class="stock-number"><strong>${esc(line.after)}</strong></td></tr>`).join("")}</tbody></table></div>`;
      $("stock-preview").hidden = false;
      if (!preview.canPost) error("stock-post-error", `Insufficient stock. ${preview.shortages.join("; ")}`);
    } catch (cause) { error("stock-post-error", cause.message); }
    finally { lock(false); icons(); }
  }
  async function open(kind, sourceId) {
    if (busy) return;
    current = { kind, ...(sourceId ? { sourceId } : {}) };
    $("stock-post-form").reset();
    invalidate();
    setUIText($("stock-post-title"), kinds[kind]);
    setUIText($("stock-confirm").querySelector("span"), { order: "Confirm issue", purchase: "Confirm receipt", adjustment: "Confirm adjustment", reversal: "Confirm reversal" }[kind]);
    $("stock-adjust-fields").hidden = kind !== "adjustment";
    $("stock-material").innerHTML = data().summary.map((row) => html`<option value="${row.materialId}">${esc(row.sku)} · ${esc(row.name)} (${esc(row.unit)})</option>`).join("");
    $("stock-quantity").required = kind === "adjustment";
    $("stock-material").required = kind === "adjustment";
    $("stock-note").required = ["adjustment", "reversal"].includes(kind);
    setUIText($("stock-note-label"), $("stock-note").required ? "Reason *" : "Note");
    const record = getState().records.find((row) => row.id === sourceId);
    $("stock-source").textContent = record ? String(Object.values(record.values).find((value) => typeof value === "string") || "") : "";
    lock(false);
    postDialog.showModal(); icons();
    if (["order", "purchase"].includes(kind)) await loadPreview();
    else $(kind === "adjustment" ? "stock-material" : "stock-note").focus();
  }
  function renderMapping() {
    const state = getState(), form = state.forms.find((item) => item.id === $("stock-order-table").value);
    const saved = data().mappings.find((item) => item.formId === form?.id);
    const itemFields = (form?.fields || []).filter((field) => ["text", "select"].includes(field.type) || field.type === "reference" && field.reference.formId === state.inventoryTables.products);
    const quantityFields = (form?.fields || []).filter((field) => field.type === "number");
    const options = (fields) => html`<option value="">Choose field</option>${fields.map((field) => html`<option value="${field.id}">${esc(field.name)}</option>`).join("")}`;
    $("stock-item-field").innerHTML = options(itemFields);
    $("stock-quantity-field").innerHTML = options(quantityFields);
    $("stock-item-field").value = saved?.itemField || "";
    $("stock-quantity-field").value = saved?.quantityField || "";
    error("stock-mapping-error");
  }
  function openMapping() {
    const state = getState(), tables = state.forms.filter((form) => form.moduleId === "orders");
    $("stock-order-table").innerHTML = tables.map((form) => html`<option value="${form.id}">${esc(form.name)}</option>`).join("");
    if (state.form?.moduleId === "orders") $("stock-order-table").value = state.form.id;
    renderMapping(); mappingDialog.showModal(); icons();
  }
  $("stock-order-table").onchange = renderMapping;
  $("stock-mapping-form").onsubmit = async (event) => {
    event.preventDefault();
    $("stock-mapping-save").disabled = true;
    try {
      await api("/api/inventory/mappings", { method: "PUT", body: JSON.stringify({
        formId: $("stock-order-table").value, itemField: $("stock-item-field").value, quantityField: $("stock-quantity-field").value,
      }) });
      mappingDialog.close(); await refresh(); toast("Order mapping saved.");
    } catch (cause) { error("stock-mapping-error", cause.message); }
    finally { $("stock-mapping-save").disabled = false; }
  };
  mappingDialog.querySelectorAll("[data-mapping-close]").forEach((button) => { button.onclick = () => mappingDialog.close(); });
  postDialog.querySelectorAll("[data-stock-close]").forEach((button) => { button.onclick = () => { if (!busy) postDialog.close(); }; });
  postDialog.addEventListener("cancel", (event) => { if (busy) event.preventDefault(); });
  $("stock-post-form").addEventListener("input", invalidate);
  $("stock-post-form").onsubmit = (event) => { event.preventDefault(); loadPreview(); };
  $("stock-confirm").onclick = async () => {
    if (busy || !preview?.canPost) return;
    lock(true); error("stock-post-error");
    try {
      const result = await api("/api/inventory/post", { method: "POST", body: JSON.stringify({ ...body(), previewToken: preview.previewToken, idempotencyKey: requestKey }) });
      postDialog.close(); await refresh();
      toast(result.alreadyPosted ? "This stock operation was already posted." : "Stock posted. Inventory balances updated.");
    } catch (cause) {
      error("stock-post-error", cause.message);
      if (cause.status === 409) { preview = null; requestKey = null; }
    } finally { lock(false); }
  };
  function exportRows(view) {
    const rows = view === "stock" ?
      [["SKU", "Material", "Unit", "Total in", "Total out", "On hand", "Reorder level"], ...summaryRows().map((row) => [row.sku, row.name, row.unit, row.incoming, row.outgoing, row.onHand, row.reorderLevel])] :
      [["Posted", "SKU", "Direction", "Quantity", "Unit", "Source", "Reason"], ...movementRows().map((row) => [row.createdAt, row.sku, row.direction, row.quantity, row.unit, row.source?.title || "Adjustment", row.note])];
    const cell = (value) => `"${(/^[=+\-@\t\r]/.test(String(value)) ? "'" : "") + String(value ?? "").replaceAll('"', '""')}"`;
    const blob = new Blob(["\uFEFF", rows.map((row) => row.map(cell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob), anchor = document.createElement("a");
    anchor.href = url; anchor.download = `inventory-${view}.csv`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  for (const id of ["stock-search", "movements-search", "stock-filter", "movement-filter"]) $(id).addEventListener("input", render);
  document.addEventListener("click", (event) => {
    if (event.target.closest("[data-stock-adjust]")) open("adjustment");
    if (event.target.closest("[data-inventory-settings]")) openMapping();
    if (event.target.closest("[data-stock-refresh]")) refresh();
    const reverse = event.target.closest("[data-stock-reverse]");
    if (reverse) open("reversal", reverse.dataset.stockReverse);
    const action = event.target.closest("[data-stock-source]");
    if (action) open(action.dataset.stockKind, action.dataset.stockSource);
    const exported = event.target.closest("[data-stock-export]");
    if (exported) exportRows(exported.dataset.stockExport);
  });
  return {
    enter(view) { if (["stock", "movements"].includes(view)) render(); },
    update() { render(); },
    isBusy: () => busy,
    recordAction(record) {
      const state = getState(), active = data().activeSources[record.id];
      if (!state.inventoryTables.materials || state.form.moduleId !== "orders" && state.form.id !== state.inventoryTables.purchases) return "";
      const kind = state.form.moduleId === "orders" ? "order" : "purchase";
      return active ? html`<span class="stock-posted" title="Stock posted" aria-label="Stock posted">${icon("circle-check")}</span>` :
        html`<button class="icon-button" data-stock-source="${record.id}" data-stock-kind="${kind}" ${uiAttributes(kinds[kind])}>${icon(kind === "order" ? "package-minus" : "package-plus")}</button>`;
    },
  };
}
