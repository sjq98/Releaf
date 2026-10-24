import { html, uiText, uiAttributes, setUIText, t } from "/i18n.js";
import { renderFieldInput, renderFieldCell } from "/field-ui.js";
import { inputValue } from "/field-types.js";
import { initWarehouseImport } from "/warehouse-import.js";

const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const icon = name => `<i data-lucide="${name}" aria-hidden="true"></i>`;
const button = (attr, glyph, label, primary = false) => html`<button type="button" class="button ${primary ? "button-primary" : "button-secondary"}" ${attr}>${icon(glyph)}<span>${uiText(label)}</span></button>`;
const statuses = ["Draft", "Pending approval", "Approved", "Posted", "Rejected", "Cancelled", "Reversed"];
const actions = { submit: ["send", "Submit for approval"], approve: ["check", "Approve"], reject: ["undo-2", "Reject"], cancel: ["x", "Cancel request"], post: ["package-check", "Confirm stock movement"], reverse: ["rotate-ccw", "Reverse stock movement"] };
const actionStates = { Draft: ["submit", "cancel"], Rejected: ["submit", "cancel"], "Pending approval": ["approve", "reject", "cancel"], Approved: ["post", "cancel"], Posted: ["reverse"] };
const canEdit = doc => !doc || ["Draft", "Rejected"].includes(doc.record.values.status);

export function initWarehouse({ api, icons, toast, getState, refresh, navigate, showView }) {
  const $ = id => document.getElementById(id);
  const current = () => getState();
  const data = () => current().warehouse;
  const allowed = permission => Boolean(current().user && current().permissions?.[permission]);
  const username = () => current().user?.username ?? "";
  const roleOf = id => Object.entries(data()?.tables ?? {}).find(([, value]) => value === id)?.[0];
  const canEditRecord = record => {
    if (!allowed("editRecords")) return false;
    const role = roleOf(record.formId);
    if (["inbound", "outbound"].includes(role)) return canEdit({ record });
    if (["inboundLines", "outboundLines"].includes(role)) {
      const parent = data().requests?.find(row => row.id === record.values.document);
      return Boolean(parent && canEdit({ record: parent }));
    }
    return true;
  };
  const formFor = role => current().forms.find(f => f.id === data().tables[role]);
  const editableFields = form => form.fields.filter(f => !(data().managedFields[roleOf(form.id)] ?? []).includes(f.id));
  const filters = new Map();
  const filterState = () => filters.get(current().form.id) ?? { status: "all", warehouse: "", low: false };
  let editor = null, busy = false, pending = null, loadSequence = 0, formulaTimer, formulaSequence = 0, sessionVersion = 0;
  const dialog = document.createElement("dialog");
  dialog.id = "warehouse-document-dialog"; dialog.className = "modal warehouse-dialog";
  const actionDialog = document.createElement("dialog");
  actionDialog.id = "warehouse-action-dialog"; actionDialog.className = "modal warehouse-action-dialog";
  document.body.append(dialog, actionDialog);
  const catalogDialog = document.createElement("dialog");
  catalogDialog.id = "warehouse-catalog-dialog"; catalogDialog.className = "modal warehouse-dialog";
  document.body.append(catalogDialog);
  let catalogEditor;
  const importer = initWarehouseImport({ api, icons, toast, getState, onCompleted: refresh });
  const available = (product, warehouse) => data().stockItems.find(row => row.values.product === product && row.values.warehouse === warehouse)?.values.currentQuantity ?? 0;
  const badge = value => html`<span class="warehouse-status status-${esc(value.toLowerCase().replaceAll(" ", "-"))}">${uiText(value)}</span>`;
  const reference = (formId, recordId, label) => html`<a class="reference-link" data-reference href="?formId=${esc(formId)}&recordId=${esc(recordId)}#records">${icon("link-2")}<span>${esc(label)}</span></a>`;

  function renderToolbar() {
    let bar = $("warehouse-toolbar");
    if (!bar) { bar = document.createElement("div"); bar.id = "warehouse-toolbar"; $("record-table-wrap").before(bar); }
    const role = roleOf(current().form.id), selected = filterState();
    const catalogRole = ["products", "warehouses"].includes(role);
    $("view-records").classList.toggle("warehouse-records", Boolean(role));
    $("edit-table").hidden = !allowed("manageForms");
    $("delete-table").hidden = Boolean(role) || !allowed("manageForms");
    $("create-record").hidden = role ? !catalogRole || !allowed("editRecords") : !allowed("editRecords");
    $("import-spreadsheet").hidden = Boolean(role) || !allowed("manageForms");
    bar.hidden = !role;
    if (!role) return;
    bar.innerHTML = html`<div class="warehouse-tabs" role="tablist" aria-label="Document status"><button role="tab" data-wh-status="all" aria-selected="${selected.status === "all"}">All records</button>${role.includes("bound") ? statuses.map(value => html`<button role="tab" data-wh-status="${value}" aria-selected="${selected.status === value}">${uiText(value)} <span>${current().records.filter(r => r.values.status === value).length}</span></button>`).join("") : ""}</div><div class="warehouse-filters">${!["warehouses", "products"].includes(role) ? html`<label><span>Warehouse</span><select id="warehouse-filter" aria-label="Warehouse"><option value="">All warehouses</option>${data().warehouses.map(r => html`<option value="${r.id}" ${r.id === selected.warehouse ? "selected" : ""}>${esc(r.values.name)}</option>`).join("")}</select></label>` : ""}${role === "stock" ? html`<label class="warehouse-low-filter"><input type="checkbox" id="warehouse-low" ${selected.low ? "checked" : ""}> Low stock</label>` : ""}<button type="button" class="button button-secondary" data-wh-flows>${icon("workflow")}<span>Warehouse workflows</span></button></div>`;
    bar.querySelectorAll("[data-wh-status]").forEach(b => b.onclick = () => { filters.set(current().form.id, { ...selected, status: b.dataset.whStatus }); window.dispatchEvent(new Event("warehouse-filter")); });
    for (const [id, key] of [["warehouse-filter", "warehouse"], ["warehouse-low", "low"]]) if ($(id)) $(id).onchange = event => { filters.set(current().form.id, { ...selected, [key]: key === "low" ? event.target.checked : event.target.value }); window.dispatchEvent(new Event("warehouse-filter")); };
  }
  function filter(records) {
    const role = roleOf(current().form.id), selected = filterState();
    if (!role) return records;
    return records.filter(r => (selected.status === "all" || r.values.status === selected.status) && (!selected.warehouse || (r.values.warehouse ?? data().documentWarehouses[r.values.document]) === selected.warehouse) && (!selected.low || r.values.currentQuantity < r.values.minimum));
  }
  function cell(field, value, record) {
    if (!roleOf(record.formId)) return null;
    if (["status", "workflowStatus", "progress", "type"].includes(field.id) && value) return field.id === "status" ? badge(value) : uiText(value);
    if (field.id === "currentQuantity") return html`<span class="warehouse-quantity ${value < record.values.minimum ? "is-low" : ""}">${esc(value)}${value < record.values.minimum ? icon("triangle-alert") : ""}</span>`;
    if (field.id === "image" && value?.length) return html`<div class="warehouse-pictures">${value.map(id => html`<a href="/api/attachments/${esc(id)}" target="_blank" rel="noopener"><img src="/api/attachments/${esc(id)}" alt="${esc(record.values.name)}" loading="lazy"></a>`).join("")}</div>`;
    if (["warehouse", "product"].includes(field.id) && value) {
      const target = (field.id === "warehouse" ? data().warehouses : data().products).find(r => r.id === value);
      if (target) return reference(field.reference.formId, value, `${target.values.name} (${target.values.code})`);
    }
    return null;
  }
  async function enter(view) {
    if (view !== "warehouse-flows" || !current().space) return;
    const target = $("view-warehouse-flows");
    target.innerHTML = html`<div class="page-heading"><div><div class="eyebrow">${esc(current().space.name)}</div><h1>Warehouse workflows</h1></div>${!data().tables.stock ? button("data-wh-setup", "plus", "Set up warehouse", true) : ""}</div>${data().tables.stock ? html`<div class="warehouse-flow-list">${data().workflows.map(flow => html`<article class="warehouse-flow"><span class="warehouse-flow-icon">${icon(flow.kind === "inbound" ? "package-plus" : "package-minus")}</span><div><h2>${uiText(flow.name)}</h2><ol class="warehouse-steps">${flow.steps.map(step => html`<li>${uiText(step)}</li>`).join("")}</ol></div><div class="warehouse-flow-actions">${button(`data-wh-new="${flow.kind}"`, "plus", "Start request", true)}${button(`data-table="${flow.formId}"`, "table-2", "View documents")}</div></article>`).join("")}</div><div class="section-heading"><h2>Recent stock movements</h2>${button(`data-table="${data().tables.stock}"`, "boxes", "View stock")}</div><div class="table-clip"><table class="data-table"><thead><tr><th>Product</th><th>Direction</th><th>Quantity</th><th>Document</th><th>Operator</th><th>Date</th></tr></thead><tbody>${data().movements.map(m => { const stock = data().stockItems.find(r => r.id === m.stock_id); return html`<tr><td>${reference(data().tables.stock, m.stock_id, stock?.values.name ?? "")}</td><td>${uiText(m.direction)}${m.reversal ? html` · ${uiText("Reversal")}` : ""}</td><td>${esc(m.quantity)} ${esc(stock?.values.unit)}</td><td><button class="record-title" data-wh-document="${m.document_id}">${esc(m.documentNumber)}</button></td><td>${esc(m.actor)}</td><td>${esc(new Date(m.created_at).toLocaleString())}</td></tr>`; }).join("")}</tbody></table>${data().movements.length ? "" : html`<div class="workflow-empty">No stock movements</div>`}</div>` : ""}`;
    if (data().tables.stock) {
      if (allowed("editRecords")) target.querySelector(".warehouse-flow-list").insertAdjacentHTML("beforebegin", html`<div class="warehouse-catalog-actions">${button('data-wh-catalog="products"', "package-plus", "Product registration")}${button('data-wh-catalog="warehouses"', "warehouse", "Warehouse registration")}${button('data-wh-catalog="stock"', "sliders-horizontal", "Stock settings")}</div>`);
      target.querySelector(".warehouse-flow-list").insertAdjacentHTML("afterend", html`<div class="section-heading"><h2>Requests</h2></div><div class="table-clip warehouse-request-list"><table class="data-table"><thead><tr><th>Document</th><th>Direction</th><th>Status</th><th>Applicant</th><th>Approver</th><th></th></tr></thead><tbody>${(data().requests ?? []).map(r => html`<tr><td>${esc(r.values.number)}</td><td>${uiText(roleOf(r.formId) === "inbound" ? "In" : "Out")}</td><td>${badge(r.values.status)}</td><td>${esc(r.values.applicant)}</td><td>${esc(r.values.approver)}</td><td>${button(`data-wh-document="${r.id}"`, "workflow", "Open workflow")}</td></tr>`).join("")}</tbody></table>${data().requests?.length ? "" : html`<div class="workflow-empty">No requests yet</div>`}</div>`);
    }
    const setup = target.querySelector("[data-wh-setup]");
    if (setup) setup.hidden = !allowed("manageForms");
    icons();
  }
  function openCatalog(role, id) {
    if (!allowed("editRecords")) { toast("Administrator access is required.", true); return; }
    const form = formFor(role);
    const rows = role === "products" ? data().products : role === "warehouses" ? data().warehouses : data().stockItems;
    const record = rows.find(row => row.id === id);
    catalogEditor = { role, record };
    catalogDialog.innerHTML = html`<div class="modal-heading"><h2>${uiText({ products: "Product registration", warehouses: "Warehouse registration", stock: "Stock settings" }[role])}</h2><button type="button" class="icon-button" data-wh-catalog-close ${uiAttributes("Close")}>${icon("x")}</button></div><label class="input-field"><span>Record</span><select id="wh-catalog-record"><option value="">New record</option>${rows.map(row => html`<option value="${row.id}" ${row.id === record?.id ? "selected" : ""}>${esc(role === "stock" ? `${row.values.name} · ${data().warehouses.find(w => w.id === row.values.warehouse)?.values.name}` : `${row.values.name} (${row.values.code})`)}</option>`).join("")}</select></label><form id="warehouse-catalog-form"><div class="warehouse-header-fields">${editableFields(form).map(field => renderFieldInput(field, record?.values[field.id] ?? (field.id === "active" ? true : null), "wh-catalog", current().references)).join("")}</div><div id="wh-catalog-error" class="form-error" hidden role="alert"></div><div class="modal-actions">${button("data-wh-catalog-save", "check", "Submit", true)}</div></form>`;
    $("wh-catalog-record").onchange = event => openCatalog(role, event.target.value);
    if (!catalogDialog.open) catalogDialog.showModal(); icons();
  }
  catalogDialog.addEventListener("submit", event => event.preventDefault());
  catalogDialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
  function readValues(form, prefix) {
    const values = {};
    for (const field of editableFields(form).filter(f => !f.formula)) {
      const input = $(`${prefix}-${field.id}`);
      if (!input) continue;
      if (input.closest(".attachment-editor")?.querySelector("[data-attachment-upload]")?.disabled) throw new Error("Wait for attachments to finish uploading.");
      values[field.id] = inputValue(field, input);
    }
    return values;
  }
  function capture() {
    if (!editor || editor.readOnly || !canEdit(editor.doc)) return;
    editor.values = readValues(formFor(editor.kind), "wh");
    editor.lines = editor.lines.map((line, index) => ({ ...line, values: readValues(formFor(`${editor.kind}Lines`), `wh-line-${index}`) }));
  }
  function renderDocument() {
    const { doc, kind, values, lines } = editor, form = formFor(kind), detail = formFor(`${kind}Lines`), editing = !editor.readOnly && canEdit(doc);
    const products = data().products.filter(r => r.values.active || lines.some(line => line.values.product === r.id));
    const viewField = (field, value) => html`<div class="input-field"><span class="builder-label">${esc(field.name)}</span><div>${cell(field, value, doc.record) ?? renderFieldCell(field, value, { catalog: current().references })}</div></div>`;
    dialog.innerHTML = html`<div class="modal-heading"><div><span class="eyebrow">${esc(form.name)}</span><h2>${doc ? esc(doc.record.values.number) : uiText(kind === "inbound" ? "New inbound request" : "New outbound request")}</h2></div><button type="button" class="icon-button" data-wh-close ${uiAttributes("Close")}>${icon("x")}</button></div><div class="warehouse-document-state">${badge(doc?.record.values.status ?? "Draft")}<span>${uiText(doc?.record.values.progress ?? "Draft")}</span></div><form id="warehouse-document-form"><div class="warehouse-header-fields">${(editing ? editableFields(form) : form.fields).filter(f => !["initiator", "startedAt", "endedAt", "workflowStatus", "progress"].includes(f.id)).map(field => editing ? renderFieldInput(field, values[field.id], "wh", current().references) : viewField(field, values[field.id])).join("")}</div><div class="section-heading"><h3>Product lines</h3>${editing ? `<div class="warehouse-line-tools">${button("data-wh-import-lines", "file-spreadsheet", "Import product lines")}${button("data-wh-add-line", "plus", "Add line")}</div>` : ""}</div><div class="table-clip warehouse-lines"><table class="data-table"><thead><tr>${detail.fields.filter(f => !["document", "status", "postedDate"].includes(f.id)).map(f => html`<th>${esc(f.name)}</th>`).join("")}<th>Available stock</th>${editing ? "<th></th>" : ""}</tr></thead><tbody>${lines.map((line, index) => html`<tr>${detail.fields.filter(f => !["document", "status", "postedDate"].includes(f.id)).map(field => html`<td>${editing ? field.id === "product" ? html`<select id="wh-line-${index}-product" data-value-id="product" aria-label="${esc(field.name)}" required><option value="">Select a record</option>${products.map(p => html`<option value="${p.id}" ${p.id === line.values.product ? "selected" : ""}>${esc(p.values.name)} · ${esc(p.values.code)} (${esc(p.values.unit)})</option>`).join("")}</select>` : renderFieldInput(field, line.values[field.id], `wh-line-${index}`, current().references) : cell(field, line.values[field.id], line) ?? renderFieldCell(field, line.values[field.id], { catalog: current().references })}</td>`).join("")}<td data-wh-available="${index}">${esc(available(line.values.product, values.warehouse))}</td>${editing ? html`<td><button type="button" class="icon-button" data-wh-remove-line="${index}" ${uiAttributes("Remove line")}>${icon("trash-2")}</button></td>` : ""}</tr>`).join("")}</tbody></table></div><div class="warehouse-total"><span>Total quantity</span><strong id="wh-total">${esc(lines.reduce((sum, l) => sum + (Number(l.values.quantity) || 0), 0))}</strong></div><div id="warehouse-document-error" class="form-error" role="alert" hidden></div><div class="modal-actions">${editing ? button("data-wh-save", "save", "Save draft", true) : ""}${(editor.readOnly ? [] : actionStates[doc?.record.values.status ?? "Draft"] ?? []).filter(a => doc || a === "submit").map(a => button(`data-wh-action="${a}"`, ...actions[a], a === "submit" || a === "post")).join("")}${editor.readOnly ? button("data-wh-continue", "workflow", "Open workflow", true) : ""}</div></form>${doc ? html`<details class="warehouse-history" open><summary>Workflow history</summary><ol>${doc.events.map(event => html`<li><strong>${uiText(actions[event.action]?.[1] ?? event.action)}</strong><span>${esc(event.actor)} · ${esc(new Date(event.created_at).toLocaleString())}</span>${event.note ? html`<p>${esc(event.note)}</p>` : ""}</li>`).join("")}</ol></details>` : ""}`;
    if (editing) {
      const applicant = $("wh-applicant");
      if (applicant) { applicant.readOnly = true; applicant.value = values.applicant || username(); }
      const approver = $("wh-approver");
      if (approver) {
        const assignees = data().assignees ?? [];
        const selected = assignees.find(user => user.username === values.approver || user.id === values.approver) ??
          assignees.filter(user => user.displayName === values.approver).find((user, index, matches) => matches.length === 1);
        approver.outerHTML = html`<select id="wh-approver" aria-label="${esc(form.fields.find(field => field.id === "approver")?.name ?? "Approver")}"><option value="">Select an approver</option>${assignees.map(user => html`<option value="${esc(user.username)}" ${selected?.id === user.id ? "selected" : ""}>${esc(user.displayName)} (${esc(user.username)})</option>`).join("")}</select>`;
      }
    }
    dialog.querySelectorAll("[data-wh-action]").forEach(control => { control.hidden = !actionAllowed(control.dataset.whAction); });
    icons();
  }
  function actionAllowed(action) {
    if (!current().user || !editor || editor.readOnly) return false;
    const doc = editor.doc;
    if (!(actionStates[doc?.record.values.status ?? "Draft"] ?? []).includes(action)) return false;
    if (!["approve", "reject"].includes(action)) return true;
    const approver = doc?.record.values.approver;
    const matches = (data().assignees ?? []).filter(user => user.displayName === approver);
    return [username(), current().user.id].includes(approver) || (matches.length === 1 && matches[0].id === current().user.id);
  }
  async function open(kind, id, fromWorkflow = true) {
    const sequence = ++loadSequence;
    try {
      const doc = id ? await api(`/api/warehouse/documents/${id}`) : null;
      if (sequence !== loadSequence) return;
      kind = doc?.kind ?? kind;
      editor = { kind, doc, readOnly: !fromWorkflow, values: structuredClone(doc?.record.values ?? { warehouse: data().warehouses[0]?.id ?? "", applicant: username(), approver: "", type: kind === "inbound" ? "Direct receipt" : "Direct issue", applicationDate: new Date().toISOString().slice(0, 10) }), lines: structuredClone(doc?.lines ?? [{ values: { product: "", quantity: 1, notes: "" } }]) };
      renderDocument(); if (!dialog.open) dialog.showModal();
    } catch (error) { if (sequence === loadSequence) toast(error.message, true); }
  }
  function openRecord(id) {
    const role = roleOf(current().form.id);
    const record = current().records.find(r => r.id === id);
    if (!role || (record && canEditRecord(record))) return false;
    if (!id) {
      if (["products", "warehouses"].includes(role) && allowed("editRecords")) {
        openCatalog(role);
        return true;
      }
      showView("warehouse-flows");
      return true;
    }
    if (["inbound", "outbound"].includes(role)) { open(role, id, false); return true; }
    if (["inboundLines", "outboundLines"].includes(role)) { const line = current().records.find(r => r.id === id); if (line) { open(null, line.values.document, false); return true; } }
    if (record) {
      editor = null;
      dialog.innerHTML = html`<div class="modal-heading"><h2>${esc(record.values.name || current().form.name)}</h2><button type="button" class="icon-button" data-wh-close ${uiAttributes("Close")}>${icon("x")}</button></div><div class="warehouse-header-fields">${current().form.fields.filter(f => f.id !== "stockKey").map(f => html`<div class="input-field"><span>${esc(f.name)}</span><div>${cell(f, record.values[f.id], record) ?? renderFieldCell(f, record.values[f.id], { catalog: current().references })}</div></div>`).join("")}</div>`;
      dialog.showModal(); icons();
    }
    return true;
  }
  async function save(submit = false) {
    const active = editor, session = sessionVersion;
    capture();
    if (!$("warehouse-document-form").reportValidity()) return false;
    const { doc, kind, values, lines } = editor;
    const body = { values, lines: lines.map(l => ({ ...l.values, ...(l.id ? { id: l.id, version: l.version } : {}) })), ...(doc ? { version: doc.record.version } : { kind, spaceId: current().space.id, submit, actor: values.applicant }) };
    let result = await api(doc ? `/api/warehouse/documents/${doc.record.id}` : "/api/warehouse/documents", { method: doc ? "PUT" : "POST", body: JSON.stringify(body) });
    if (session !== sessionVersion || editor !== active) return false;
    // Preserve the saved version even if submission validation fails.
    editor.doc = result; editor.values = structuredClone(result.record.values); editor.lines = structuredClone(result.lines);
    if (doc && submit) result = await api(`/api/warehouse/documents/${result.record.id}/transition`, { method: "POST", body: JSON.stringify({ version: result.record.version, action: "submit", actor: values.applicant }) });
    if (session !== sessionVersion) return false;
    await refresh();
    if (session !== sessionVersion) return false;
    await open(kind, result.record.id); toast(submit ? "Request submitted." : "Draft saved."); return true;
  }
  function startAction(action) {
    if (!actionAllowed(action) || !editor.doc) return;
    pending = { action, version: editor.doc.record.version, recordId: editor.doc.record.id, requestKey: crypto.randomUUID() };
    const needsReason = ["reject", "cancel", "reverse"].includes(action);
    actionDialog.innerHTML = html`<form id="warehouse-action-form"><div class="modal-heading"><h2>${uiText(actions[action][1])}</h2><button type="button" class="icon-button" data-wh-action-close ${uiAttributes("Close")}>${icon("x")}</button></div><div class="form-fields"><label class="input-field"><span>Operator</span><input id="wh-actor" maxlength="100" required value="${esc(["approve", "reject"].includes(action) ? editor.doc.record.values.approver : editor.doc.record.values.applicant)}"></label><label class="input-field"><span>Reason</span><textarea id="wh-reason" maxlength="1000" ${needsReason ? "required" : ""}></textarea></label>${action === "post" ? html`<label class="input-field"><span>Posting date</span><input id="wh-date" type="date" required value="${new Date().toISOString().slice(0, 10)}"></label>` : ""}</div><div id="wh-action-preview"></div><div id="wh-action-error" class="form-error" hidden role="alert"></div><div class="modal-actions"><button type="submit" class="button button-primary" id="wh-confirm">${icon("check")}<span>${uiText(["post", "reverse"].includes(action) ? "Preview changes" : "Confirm")}</span></button></div></form>`;
    $("wh-actor").value = username(); $("wh-actor").readOnly = true;
    actionDialog.showModal(); icons();
  }
  async function executeAction(event) {
    event.preventDefault(); if (busy) return;
    const operation = pending, session = sessionVersion;
    busy = true; $("wh-confirm").disabled = true; $("wh-action-error").hidden = true;
    try {
      const body = { action: pending.action, version: pending.version, actor: $("wh-actor").value.trim(), note: $("wh-reason").value.trim(), ...($("wh-date") ? { date: $("wh-date").value } : {}) };
      const isStock = ["post", "reverse"].includes(body.action);
      if (isStock && !pending.fingerprint) {
        const result = await api(`/api/warehouse/documents/${pending.recordId}/preview`, { method: "POST", body: JSON.stringify(body) });
        if (session !== sessionVersion || pending !== operation) return;
        pending.fingerprint = result.fingerprint;
        const balances = new Map();
        for (const change of result.changes.filter(c => c.formId === data().tables.stock)) {
          const prior = balances.get(change.recordId);
          balances.set(change.recordId, { name: change.after?.name ?? change.before?.name, before: prior?.before ?? change.before?.currentQuantity ?? 0, after: change.after?.currentQuantity ?? 0 });
        }
        $("wh-action-preview").innerHTML = html`<div class="table-clip"><table class="data-table"><thead><tr><th>Product</th><th>Before</th><th>After</th></tr></thead><tbody>${[...balances.values()].filter(c => c.before !== c.after).map(c => html`<tr><td>${esc(c.name)}</td><td>${esc(c.before)}</td><td>${esc(c.after)}</td></tr>`).join("")}</tbody></table></div>`;
        setUIText($("wh-confirm").querySelector("span"), "Confirm");
      } else {
        await api(`/api/warehouse/documents/${pending.recordId}/transition`, { method: "POST", headers: { "Idempotency-Key": pending.requestKey }, body: JSON.stringify({ ...body, ...(isStock ? { fingerprint: pending.fingerprint } : {}) }) });
        if (session !== sessionVersion || pending !== operation) return;
        actionDialog.close(); await refresh();
        if (session !== sessionVersion) return;
        await open(null, operation.recordId); toast("Workflow updated.");
      }
    } catch (error) {
      if (session !== sessionVersion || pending !== operation) return;
      setUIText($("wh-action-error"), error.message); $("wh-action-error").hidden = false; pending.fingerprint = null; setUIText($("wh-confirm").querySelector("span"), ["post", "reverse"].includes(pending.action) ? "Preview changes" : "Confirm");
    } finally { if (session === sessionVersion) { busy = false; if ($("wh-confirm")) $("wh-confirm").disabled = false; } }
  }
  actionDialog.addEventListener("submit", executeAction);
  actionDialog.addEventListener("input", () => { if (pending) { pending.fingerprint = null; pending.requestKey = crypto.randomUUID(); $("wh-action-preview").replaceChildren(); if (["post", "reverse"].includes(pending.action)) setUIText($("wh-confirm").querySelector("span"), "Preview changes"); } });
  dialog.addEventListener("submit", event => event.preventDefault());
  dialog.addEventListener("click", event => {
    if (event.target.closest("[data-reference]") && !event.ctrlKey && !event.metaKey && !event.shiftKey) dialog.close();
  });
  for (const modal of [dialog, actionDialog]) modal.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
  dialog.addEventListener("input", event => {
    if (event.target.id === "wh-warehouse") { capture(); renderDocument(); return; }
    if (event.target.closest(".warehouse-lines")) {
      capture(); $("wh-total").textContent = Number(editor.lines.reduce((n, l) => n + (Number(l.values.quantity) || 0), 0).toFixed(6));
      editor.lines.forEach((line, index) => { const cell = dialog.querySelector(`[data-wh-available="${index}"]`); if (cell) cell.textContent = available(line.values.product, editor.values.warehouse); });
    }
    if (!editor || !canEdit(editor.doc)) return;
    const active = editor, sequence = ++formulaSequence;
    clearTimeout(formulaTimer);
    formulaTimer = setTimeout(async () => {
      capture();
      const parts = [{ form: formFor(active.kind), prefix: "wh", recordId: active.doc?.record.id, values: active.values }, ...active.lines.map((line, i) => ({ form: formFor(`${active.kind}Lines`), prefix: `wh-line-${i}`, recordId: line.id, values: line.values }))];
      for (const part of parts.filter(p => p.form.fields.some(f => f.formula))) {
        try {
          const result = await api("/api/formulas/preview", { method: "POST", body: JSON.stringify({ formId: part.form.id, recordId: part.recordId, values: { ...part.values, ...(part.prefix === "wh" ? { totalQuantity: Number(active.lines.reduce((n, l) => n + (Number(l.values.quantity) || 0), 0).toFixed(6)) } : {}) } }) });
          if (editor !== active || sequence !== formulaSequence) return;
          for (const field of part.form.fields.filter(f => f.formula)) if ($(`${part.prefix}-${field.id}`)) $(`${part.prefix}-${field.id}`).value = result.values[field.id] ?? "";
        } catch {
          if (editor !== active || sequence !== formulaSequence) return;
          for (const field of part.form.fields.filter(f => f.formula)) if ($(`${part.prefix}-${field.id}`)) $(`${part.prefix}-${field.id}`).value = "";
        }
      }
    }, 200);
  });
  document.addEventListener("click", async event => {
    const control = event.target.closest("button"); if (!control) return;
    const session = sessionVersion;
    try {
      if (control.hasAttribute("data-wh-flows")) showView("warehouse-flows");
      if (control.dataset.whCatalog) openCatalog(control.dataset.whCatalog);
      if (control.hasAttribute("data-wh-catalog-close") && !busy) catalogDialog.close();
      if (control.hasAttribute("data-wh-continue")) { const id = editor.doc.record.id; dialog.close(); showView("warehouse-flows"); await open(null, id); }
      if (control.hasAttribute("data-wh-import-lines")) {
        capture();
        importer.open({ kind: editor.kind, values: { warehouse: editor.values.warehouse }, onLines: lines => {
          editor.lines = lines.map(values => { const previous = editor.lines.find(line => line.values.product === values.product); return { ...(previous?.id ? { id: previous.id, version: previous.version } : {}), values }; });
          renderDocument();
        } });
      }
      if (control.hasAttribute("data-wh-setup")) { control.disabled = true; const result = await api("/api/warehouse/setup", { method: "POST", body: JSON.stringify({ spaceId: current().space.id }) }); await navigate(result.tables.stock); }
      if (control.dataset.whNew) await open(control.dataset.whNew);
      if (control.dataset.whDocument) await open(null, control.dataset.whDocument);
      if (busy) return;
      if (control.hasAttribute("data-wh-catalog-save")) {
        if (!allowed("editRecords")) { toast("Administrator access is required.", true); return; }
        if (!$("warehouse-catalog-form").reportValidity()) return;
        busy = true; control.disabled = true;
        try {
          const { role, record } = catalogEditor;
          await api("/api/warehouse/catalog", { method: "POST", body: JSON.stringify({ spaceId: current().space.id, role, values: readValues(formFor(role), "wh-catalog"), ...(record ? { recordId: record.id, version: record.version } : {}) }) });
          if (session !== sessionVersion) return;
          await refresh();
          if (session !== sessionVersion) return;
          catalogDialog.close(); toast("Catalog saved.");
        } catch (error) { if (session === sessionVersion) { setUIText($("wh-catalog-error"), error.message); $("wh-catalog-error").hidden = false; } }
        finally { if (session === sessionVersion) { busy = false; control.disabled = false; } }
      }
      if (control.hasAttribute("data-wh-close")) dialog.close();
      if (control.hasAttribute("data-wh-action-close")) actionDialog.close();
      if (control.hasAttribute("data-wh-add-line")) { capture(); if (editor.lines.length >= 100) throw new Error("A warehouse document supports up to 100 product lines."); editor.lines.push({ values: { quantity: 1 } }); renderDocument(); }
      if (control.hasAttribute("data-wh-remove-line")) { capture(); editor.lines.splice(Number(control.dataset.whRemoveLine), 1); renderDocument(); }
      if (control.hasAttribute("data-wh-save") || control.dataset.whAction === "submit") {
        busy = true; control.disabled = true;
        try { await save(control.dataset.whAction === "submit"); }
        catch (error) { if (session === sessionVersion) { setUIText($("warehouse-document-error"), error.message); $("warehouse-document-error").hidden = false; } }
        finally { if (session === sessionVersion) { busy = false; control.disabled = false; } }
      } else if (control.dataset.whAction) startAction(control.dataset.whAction);
    } catch (error) { if (session === sessionVersion) { control.disabled = false; toast(error.message, true); } }
  });
  function reset() {
    sessionVersion++; loadSequence++; formulaSequence++; clearTimeout(formulaTimer);
    editor = null; pending = null; catalogEditor = null; busy = false; filters.clear();
    for (const modal of [dialog, actionDialog, catalogDialog]) {
      if (modal.open) modal.close();
      modal.replaceChildren();
    }
    importer.reset?.();
  }
  return { roleOf, editableFields, renderToolbar, filter, cell, enter, openRecord, reset, canEditRecord,
    canDelete(record) {
      const role = roleOf(record.formId);
      if (!role) return true;
      if (!allowed("editRecords")) return false;
      if (["inbound", "outbound"].includes(role)) return record.values.status === "Draft";
      if (["inboundLines", "outboundLines"].includes(role)) return canEditRecord(record);
      if (role === "stock" && data().movements?.some(movement => movement.stock_id === record.id)) return false;
      return true;
    } };
}
