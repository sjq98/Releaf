import { FIELD_DEFINITIONS as TYPES, inputValue } from "/field-types.js";
import { fieldDisplay, renderFieldInput, renderFieldCell } from "/field-ui.js";
import { initAISettings } from "/ai-settings.js";
import { initAssistant } from "/assistant.js";
import { initTableImport } from "/table-import.js";
import { initSupplier } from "/supplier.js";
const KIND_LABELS = { created: "Record created", updated: "Record updated", deleted: "Record deleted" };
const state = {
  form: null, forms: [], records: [], changes: [], view: "records", search: "", historySearch: "", historyKind: "all",
  draft: null, editing: null, deleting: null, busy: false, builderBusy: false, pendingAction: null, loadNumber: 0,
  modules: [], references: [], meetings: [], ai: {}, extraction: null, extracting: false, committing: false, meetingTableId: null,
  supplierTables: {},
};
const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const clone = (value) => structuredClone(value);
const icon = (name) => `<i data-lucide="${esc(name)}" aria-hidden="true"></i>`;
const icons = () => window.lucide?.createIcons?.({ attrs: { "stroke-width": 1.8 } });
const count = (n, singular, plural = singular + "s") => `${n} ${n === 1 ? singular : plural}`;
const dirty = () => state.draft && JSON.stringify({ name: state.draft.name, fields: state.draft.fields }) !== JSON.stringify({ name: state.form.name, fields: state.form.fields });

function toast(message, error = false) {
  const node = document.createElement("div");
  node.className = `toast${error ? " toast-error" : ""}`;
  node.setAttribute("role", error ? "alert" : "status");
  node.innerHTML = `${icon(error ? "circle-alert" : "circle-check")}<span>${esc(message)}</span><button class="toast-close" aria-label="Dismiss notification">${icon("x")}</button>`;
  node.querySelector("button").onclick = () => node.remove();
  $("toast-region").append(node);
  icons();
  setTimeout(() => node.remove(), 6000);
}

function notice(message) {
  $("notice").innerHTML = `${icon("circle-alert")}<span>${esc(message)}</span><button class="toast-close" aria-label="Dismiss notification">${icon("x")}</button>`;
  $("notice").hidden = false;
  $("notice").querySelector("button").onclick = () => { $("notice").hidden = true; };
  $("connection-label").textContent = "Connection issue";
  $("connection-state").classList.add("is-offline");
  icons();
}

async function api(path, options = {}) {
  let response;
  try { response = await fetch(path, { ...options, headers: options.body ? { "Content-Type": "application/json" } : {} }); }
  catch { throw new Error("Could not reach the local server. Check that it is running."); }
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.error || `Request failed (${response.status}).`);
    error.status = response.status;
    error.fields = payload.fields || {};
    throw error;
  }
  return payload;
}

function renderAIStatus() {
  $("ai-status").textContent = state.ai.configured ? `${state.ai.providerName || "AI configured"} · ${state.ai.model}` : "AI not configured";
  $("ai-status").classList.toggle("configured", Boolean(state.ai.configured));
}

const aiSettings = initAISettings({ api, icons, onSaved(settings) {
  state.ai = settings;
  renderAIStatus();
  toast("AI settings saved. Ready for extraction.");
} });
initAssistant({ api, icons, onChanged: refresh });
const spreadsheetImport = initTableImport({ api, icons, toast, getState: () => state, onImported: (id) => navigateTable(id) });
const supplier = initSupplier({ api, icons, toast, getState: () => state, refresh, openAISettings: () => aiSettings.open() });

function formatTimestamp(value) {
  return new Intl.DateTimeFormat("en-GB", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(value));
}

function displayValue(field, value) {
  return fieldDisplay(field, value, state.references);
}

function renderSidebar() {
  $("module-navigation").innerHTML = state.modules.map((module) => {
    const active = state.form?.moduleId === module.id;
    const forms = state.forms.filter((form) => form.moduleId === module.id);
    return `<div class="module-group"><div class="module-heading">${icon(module.icon)}<span>${esc(module.name)}</span><button class="icon-button" data-new-table="${module.id}" title="New table" aria-label="New table in ${esc(module.name)}">${icon("plus")}</button></div>
      ${module.id === "meetings" ? `<button class="nav-item subnav ${state.view === "meeting" ? "is-active" : ""}" data-meeting>${icon("file-input")}<span>Import meeting</span></button>` : ""}
      ${module.id === "suppliers" ? `<button class="nav-item subnav ${state.view === "document" ? "is-active" : ""}" data-supplier-view="document">${icon("scan-text")}<span>Document recognition</span></button>` : ""}
      ${forms.map((form) => `<button class="nav-item subnav ${active && form.id === state.form.id && state.view === "records" ? "is-active" : ""}" data-table="${form.id}">${icon("table-2")}<span>${esc(form.name)}</span><span class="nav-count">${form.recordCount}</span></button>`).join("")}
      ${module.id === "suppliers" && !state.supplierTables.receipts ? `<button class="nav-item subnav" data-supplier-view="records">${icon("truck")}<span>Goods Receipts</span><span class="nav-count">0</span></button><button class="nav-item subnav" data-supplier-view="supplier-records">${icon("files")}<span>Supplier Documents</span><span class="nav-count">0</span></button>` : ""}
      ${module.id === "suppliers" ? `<button class="nav-item subnav ${state.view === "reconciliation" ? "is-active" : ""}" data-supplier-view="reconciliation">${icon("git-compare-arrows")}<span>Reconciliation results</span></button>` : ""}
      ${module.id === "meetings" && !state.meetingTableId ? `<button class="nav-item subnav" data-todos>${icon("list-todo")}<span>To-do Items</span><span class="nav-count">0</span></button>` : ""}
      ${active ? `<button class="nav-item subnav ${state.view === "activity" ? "is-active" : ""}" data-view="activity">${icon("history")}<span>Activity</span></button>` : ""}</div>`;
  }).join("");
  icons();
}

function recordTitle(record) {
  const field = state.form.fields.find((f) => f.unique && record.values[f.id] != null) || state.form.fields.find((f) => record.values[f.id] != null);
  return field ? displayValue(field, record.values[field.id]) : record.id.slice(0, 8);
}

function renderRecords() {
  const fields = state.form.fields;
  const query = state.search.trim().toLowerCase();
  const records = state.records.filter((record) => !query || fields.some((field) => displayValue(field, record.values[field.id]).toLowerCase().includes(query)));
  $("metric-total").textContent = state.records.length;
  $("metric-fields").textContent = fields.length;
  $("metric-required").textContent = fields.filter((field) => field.required).length;
  $("metric-changes").textContent = state.changes.length;
  $("records-title").textContent = state.form.name;
  $("visible-record-count").textContent = count(records.length, "record");
  $("record-columns").innerHTML = `<tr>${fields.map((field) => `<th><span class="column-heading">${icon(TYPES[field.type].icon)}<span>${esc(field.name)}</span>${field.unique ? `<span class="column-unique" title="Unique">${icon("key-round")}</span>` : ""}</span></th>`).join("")}<th>Last updated</th><th><span class="sr-only">Actions</span></th></tr>`;
  $("record-rows").innerHTML = records.map((record) => `<tr>${fields.map((field, index) => {
    const value = record.values[field.id];
    const content = renderFieldCell(field, value, { catalog: state.references, primary: index === 0, recordId: record.id });
    return `<td>${content}</td>`;
  }).join("")}<td class="updated-cell">${esc(formatTimestamp(record.updatedAt))}</td><td><div class="row-actions"><button class="icon-button" data-edit="${record.id}" title="Edit record" aria-label="Edit ${esc(recordTitle(record))}">${icon("pencil")}</button><button class="icon-button action-delete" data-delete="${record.id}" title="Delete record" aria-label="Delete ${esc(recordTitle(record))}">${icon("trash-2")}</button></div></td></tr>`).join("");
  $("records-empty").hidden = records.length > 0;
  $("record-table-wrap").classList.toggle("has-empty", !records.length);
  $("empty-title").textContent = state.records.length ? "No matching records" : "No records yet";
  $("empty-create").hidden = state.records.length > 0;
  icons();
}

function renderActivity() {
  const query = state.historySearch.trim().toLowerCase();
  const changes = state.changes.filter((entry) => (state.historyKind === "all" || state.historyKind === entry.kind) &&
    (!query || `${entry.recordTitle} ${entry.diff.map((diff) => `${diff.name} ${diff.before ?? ""} ${diff.after ?? ""}`).join(" ")}`.toLowerCase().includes(query)));
  $("history-count").textContent = count(changes.length, "event");
  $("history-empty").hidden = changes.length > 0;
  $("history-empty").querySelector("h3").textContent = state.changes.length ? "No matching events" : "No activity yet";
  $("history-list").hidden = !changes.length;
  $("history-list").innerHTML = changes.map((entry) => `<article class="history-entry"><div class="event-glyph event-${entry.kind}">${icon(entry.kind === "created" ? "plus" : entry.kind === "updated" ? "pencil" : "trash-2")}</div><div class="history-content"><div class="history-meta"><span class="history-kind">${KIND_LABELS[entry.kind]}</span><time datetime="${entry.createdAt}" title="${esc(new Date(entry.createdAt).toLocaleString("en-GB"))}">${esc(formatTimestamp(entry.createdAt))}</time></div><div class="history-order">${esc(entry.recordTitle)}</div><ul class="diff-list">${entry.diff.map((diff) => `<li class="diff-item"><span class="diff-label">${esc(diff.name)}</span><span class="diff-before">${esc(displayValue(diff, diff.before))}</span><span class="diff-arrow" aria-label="changed to">${icon("arrow-right")}</span><span class="diff-after">${esc(displayValue(diff, diff.after))}</span></li>`).join("")}</ul><button class="history-link" data-open-record="${entry.recordId}">Open record ${icon("arrow-up-right")}</button></div></article>`).join("");
  icons();
}

function renderBuilder() {
  if (!state.draft) return;
  $("form-name").value = state.draft.name;
  $("builder-fields").innerHTML = state.draft.fields.map((field, index) => `<div class="builder-field" data-field-id="${field.id}">
    <div class="builder-field-main">
      <div class="builder-name"><span class="field-type-icon">${icon(TYPES[field.type].icon)}</span><input data-prop="name" value="${esc(field.name)}" maxlength="64" aria-label="Field ${index + 1} name" placeholder="Field name"></div>
      <select data-prop="type" aria-label="Field ${index + 1} type">${Object.entries(TYPES).map(([type, info]) => `<option value="${type}"${type === field.type ? " selected" : ""}>${info.label}</option>`).join("")}</select>
      <label class="rule-control"><span>Required</span><input type="checkbox" class="toggle-input" data-prop="required" ${field.required ? "checked" : ""} aria-label="${esc(field.name || `Field ${index + 1}`)} required"></label>
      <label class="rule-control"><span>Unique</span><input type="checkbox" class="toggle-input" data-prop="unique" ${field.unique ? "checked" : ""} aria-label="${esc(field.name || `Field ${index + 1}`)} unique"></label>
      <div class="field-actions"><button class="icon-button" data-move="-1" title="Move field up" aria-label="Move field ${index + 1} up"${index === 0 ? " disabled" : ""}>${icon("arrow-up")}</button><button class="icon-button" data-move="1" title="Move field down" aria-label="Move field ${index + 1} down"${index === state.draft.fields.length - 1 ? " disabled" : ""}>${icon("arrow-down")}</button><button class="icon-button action-delete" data-remove-field title="Remove field" aria-label="Remove field ${index + 1}"${state.draft.fields.length === 1 ? " disabled" : ""}>${icon("trash-2")}</button></div>
    </div>
    ${field.type === "select" ? `<div class="dropdown-options"><label for="options-${field.id}">Options</label><textarea id="options-${field.id}" data-prop="options" rows="${Math.min(5, Math.max(2, field.options.length))}" aria-label="${esc(field.name)} options" placeholder="One option per line">${esc(field.options.join("\n"))}</textarea><span class="option-count">${count(field.options.filter((v) => v.trim()).length, "option")}</span></div>` : ""}
    ${field.type === "reference" ? referenceSettings(field) : ""}
    </div>`).join("");
  $("builder-fields").querySelectorAll("input,select,textarea").forEach((input) => { input.disabled = state.builderBusy; });
  $("form-name").disabled = state.builderBusy;
  $("preview-form").disabled = state.builderBusy;
  builderStatus();
  icons();
}

function referenceSettings(field) {
  const tables = state.references.filter((table) => table.id !== state.form.id && table.fields.length);
  const selected = tables.find((table) => table.id === field.reference?.formId);
  return `<div class="reference-settings"><label>Target table<select data-prop="referenceTable" aria-label="${esc(field.name)} target table"><option value="">Choose table</option>${tables.map((table) => `<option value="${table.id}"${table.id === selected?.id ? " selected" : ""}>${esc(table.name)}</option>`).join("")}</select></label><label>Unique field<select data-prop="referenceField" aria-label="${esc(field.name)} unique field"><option value="">Choose unique field</option>${(selected?.fields || []).map((key) => `<option value="${key.id}"${key.id === field.reference?.fieldId ? " selected" : ""}>${esc(key.name)}</option>`).join("")}</select></label></div>`;
}

function builderStatus() {
  if (!state.form) return;
  const changed = dirty();
  $("schema-version").textContent = `Version ${state.form.version}`;
  $("builder-field-count").textContent = count(state.draft.fields.length, "field");
  $("builder-save-state").textContent = state.builderBusy ? "Saving..." : changed ? "Unsaved changes" : "All changes saved";
  $("builder-save-state").classList.toggle("unsaved", Boolean(changed));
  $("save-builder").disabled = !changed || state.builderBusy;
  $("reset-builder").disabled = !changed || state.builderBusy;
  $("add-field").disabled = state.builderBusy || state.draft.fields.length >= 40;
}

function renderView(view) {
  state.view = view;
  document.querySelectorAll(".page-view").forEach((section) => { section.hidden = section.id !== `view-${view}`; });
  document.querySelectorAll("[data-view]").forEach((button) => {
    const current = button.dataset.view === view;
    button.classList.toggle("is-active", current);
    if (current) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  $("breadcrumb-current").textContent = { records: "Records", meeting: "Import meeting", activity: "Activity", document: "Document recognition", reconciliation: "Reconciliation" }[view];
  history.replaceState(null, "", `#${view}`);
  renderSidebar();
  supplier.enter(view);
}

async function load(formId = state.form?.id, preserveDraft = false) {
  const requestNumber = ++state.loadNumber;
  const data = await api(`/api/bootstrap${formId ? `?formId=${encodeURIComponent(formId)}` : ""}`);
  if (requestNumber !== state.loadNumber) return;
  state.form = data.form;
  state.forms = data.forms;
  state.records = data.records;
  state.changes = data.changes;
  state.modules = data.modules; state.references = data.references; state.meetings = data.meetings; state.ai = data.ai;
  state.meetingTableId = data.meetingTableId;
  state.supplierTables = data.supplierTables || {};
  if (!preserveDraft) state.draft = clone(state.form);
  const url = new URL(location.href);
  url.searchParams.set("formId", state.form.id);
  history.replaceState(null, "", url);
  $("create-record").disabled = false;
  $("breadcrumb-form").textContent = state.form.name;
  $("sidebar-form-count").textContent = count(state.forms.length, "table");
  $("notice").hidden = true;
  $("connection-label").textContent = "Connected";
  $("connection-state").classList.remove("is-offline");
  $("sync-timestamp").textContent = `Last synced ${new Date().toLocaleTimeString("en-GB", { hour12: false })}`;
  renderRecords();
  renderActivity();
  renderBuilder();
  renderSidebar();
  renderMeetingHistory();
  renderAIStatus();
}

async function refresh() {
  try { await load(state.form?.id, Boolean(dirty())); }
  catch (error) { notice(error.message); }
}

function guardDraft(action) {
  if (dirty()) { state.pendingAction = action; $("discard-dialog").showModal(); }
  else action();
}

function makeInput(field, value = null, prefix = "record") {
  return renderFieldInput(field, value, prefix, state.references);
}

function openRecord(recordId = null) {
  if (!state.form) return;
  const record = recordId ? state.records.find((item) => item.id === recordId) : null;
  if (recordId && !record) return toast("This record has been deleted. Its history is still available.", true);
  state.editing = { record: record ? clone(record) : null, form: clone(state.form) };
  $("record-dialog-title").textContent = record ? "Edit record" : "New record";
  $("record-form-label").textContent = state.form.name;
  $("record-fields").innerHTML = state.form.fields.map((field) => makeInput(field, record?.values[field.id])).join("");
  $("record-source").hidden = !record?.source && !record?.documentSource;
  $("record-source").innerHTML = record?.documentSource
    ? `<a class="reference-link" href="/api/suppliers/files/${record.documentSource.fileId}" download>${icon("file-down")}<span>${esc(record.documentSource.name)}</span></a><strong> · Page ${record.documentSource.page}</strong><blockquote>${esc(record.documentSource.evidence)}</blockquote>`
    : record?.source ? `<strong>${esc(record.source.title)} · ${esc(record.source.date)}</strong><blockquote>${esc(record.source.evidence)}</blockquote>` : "";
  $("record-error").hidden = true;
  $("submit-record").innerHTML = `${icon("check")}<span>${record ? "Save changes" : "Save record"}</span>`;
  $("record-dialog").showModal();
  if (record) {
    const url = new URL(location.href); url.searchParams.set("recordId", record.id); history.replaceState(null, "", url);
  }
  $("record-fields").querySelector("input,select,textarea")?.focus();
  icons();
}

async function saveRecord(event) {
  event.preventDefault();
  if (state.busy || !state.editing) return;
  const editor = state.editing;
  const values = {};
  for (const field of editor.form.fields) {
    const input = $(`record-${field.id}`);
    values[field.id] = inputValue(field, input);
    input.removeAttribute("aria-invalid");
    $(`record-error-${field.id}`).hidden = true;
  }
  state.busy = true;
  $("submit-record").disabled = true;
  $("record-error").hidden = true;
  const body = { schemaVersion: editor.form.version, values, ...(editor.record ? { version: editor.record.version } : {}) };
  try {
    const result = await api(editor.record ? `/api/records/${editor.record.id}` : `/api/forms/${editor.form.id}/records`, {
      method: editor.record ? "PATCH" : "POST", body: JSON.stringify(body),
    });
    $("record-dialog").close();
    await refresh();
    toast(result.changed ? editor.record ? "Record updated. Changes added to activity." : "Record created." : "No changes to save.");
  } catch (error) {
    $("record-error").textContent = error.message;
    $("record-error").hidden = false;
    let firstInput;
    for (const [id, message] of Object.entries(error.fields || {})) {
      const input = $(`record-${id}`);
      const label = $(`record-error-${id}`);
      if (!input || !label) continue;
      input.setAttribute("aria-invalid", "true");
      input.setAttribute("aria-describedby", label.id);
      label.textContent = message;
      label.hidden = false;
      firstInput ??= input;
    }
    firstInput?.focus();
  } finally { state.busy = false; $("submit-record").disabled = false; }
}

async function saveBuilder() {
  if (!dirty() || state.builderBusy) return;
  state.builderBusy = true;
  $("builder-error").hidden = true;
  renderBuilder();
  try {
    const saved = await api(`/api/forms/${state.form.id}`, {
      method: "PUT", body: JSON.stringify({ version: state.draft.version, name: state.draft.name, fields: state.draft.fields }),
    });
    state.form = saved;
    state.draft = clone(saved);
    await load(saved.id);
    toast("Table saved.");
  } catch (error) {
    $("builder-error").textContent = error.message;
    $("builder-error").hidden = false;
    $("builder-error").scrollIntoView({ block: "nearest", behavior: "smooth" });
  } finally { state.builderBusy = false; renderBuilder(); }
}

function handleBuilderInput(event) {
  const input = event.target.closest("[data-prop]");
  if (!input) return;
  const row = input.closest("[data-field-id]");
  const field = state.draft.fields.find((item) => item.id === row.dataset.fieldId);
  const prop = input.dataset.prop;
  $("builder-error").hidden = true;
  if (prop === "referenceTable") {
    const table = state.references.find((table) => table.id === input.value);
    field.reference = { formId: input.value, fieldId: table?.fields[0]?.id || "" };
    renderBuilder(); return;
  }
  if (prop === "referenceField") { field.reference.fieldId = input.value; builderStatus(); return; }
  field[prop] = prop === "required" || prop === "unique" ? input.checked : prop === "options" ? input.value.split(/\r?\n/) : input.value;
  if (prop === "type") {
    if (field.type === "select" && !field.options.length) field.options = ["Option 1", "Option 2"];
    if (field.type !== "select") field.options = [];
    if (field.type === "reference") field.reference = { formId: "", fieldId: "" };
    else delete field.reference;
    renderBuilder();
  } else {
    if (prop === "options") row.querySelector(".option-count").textContent = count(field.options.filter((option) => option.trim()).length, "option");
    builderStatus();
  }
}

function resetBuilder() {
  state.draft = clone(state.form);
  $("builder-error").hidden = true;
  renderBuilder();
}

async function switchForm(id) {
  const url = new URL(location.href); url.searchParams.delete("recordId"); history.replaceState(null, "", url);
  state.search = ""; state.historySearch = ""; state.historyKind = "all";
  $("record-search").value = ""; $("history-search").value = ""; $("history-kind").value = "all";
  try { await load(id); }
  catch (error) { notice(error.message); throw error; }
}

function openBuilder() {
  if (!state.form) return;
  renderBuilder();
  $("builder-dialog").showModal();
}

async function navigateTable(id, view = "records", recordId = null) {
  if (state.extracting || state.committing || supplier.isBusy()) return toast("Wait for the current import operation to finish.", true);
  try {
    if (state.form?.id !== id) await switchForm(id);
    renderView(view);
    if (recordId) openRecord(recordId);
  } catch { /* switchForm already displays the connection error. */ }
}

async function openMeeting(view = "meeting") {
  if (state.extracting || state.committing) return;
  try {
    const formId = state.meetingTableId || (await api("/api/meetings/table", { method: "POST", body: "{}" })).id;
    await navigateTable(formId, view);
  } catch (error) { toast(error.message, true); }
}

async function openSupplier(view) {
  if (supplier.isBusy()) return;
  try {
    if (!state.supplierTables.receipts || !state.supplierTables.documents) {
      await api("/api/suppliers/tables", { method: "POST", body: "{}" });
      await refresh();
    }
    const id = view === "supplier-records" || view === "document" ? state.supplierTables.documents : state.supplierTables.receipts;
    await navigateTable(id, view === "supplier-records" ? "records" : view);
  } catch (error) { toast(error.message, true); }
}

function renderMeetingHistory() {
  $("meeting-imports").innerHTML = state.meetings.length ? state.meetings.map((meeting) => `<button class="import-row" data-import="${meeting.id}"><span>${icon(meeting.committed ? "circle-check" : "file-clock")}<strong>${esc(meeting.title)}</strong><small>${esc(meeting.date)}</small></span><span>${count(meeting.itemCount, "item")}<small>${meeting.committed ? "Saved" : "Draft"}</small>${icon("chevron-right")}</span></button>`).join("") : `<p class="muted import-empty">No meeting imports yet.</p>`;
  icons();
}

function renderReview() {
  const draft = state.extraction;
  $("meeting-review").hidden = !draft;
  if (!draft) return;
  $("review-count").textContent = count(draft.items.length, "candidate");
  $("save-items").disabled = state.committing || !draft.items.some((item) => item.selected);
  $("save-items").hidden = Boolean(draft.recordIds);
  $("review-items").innerHTML = draft.recordIds
    ? `<div class="source-evidence"><strong>Saved to ${esc(draft.form.name)}</strong><div class="saved-links">${draft.recordIds.map((id, index) => `<a class="reference-link" data-reference href="?formId=${draft.formId}&recordId=${id}#records">${icon("external-link")}<span>Item ${index + 1}</span></a>`).join("")}</div></div>`
    : !draft.items.length ? `<p class="import-empty muted">No action items found. You can add records manually in To-do Items.</p>`
      : draft.items.map((item, index) => `<article class="review-item"><div class="review-item-heading"><label><input type="checkbox" data-include="${index}"${item.selected ? " checked" : ""}><strong>Action item ${index + 1}</strong></label><span class="section-count">${esc(draft.form.name)}</span></div><blockquote>${esc(item.evidence)}</blockquote><div class="review-fields" data-review-index="${index}">${draft.form.fields.map((field) => makeInput(field, item.values[field.id], `review-${index}`)).join("")}</div></article>`).join("");
  icons();
}

function syncReview() {
  const draft = state.extraction;
  if (!draft || draft.recordIds) return;
  draft.items.forEach((item, index) => {
    item.selected = Boolean(document.querySelector(`[data-include="${index}"]`)?.checked);
    for (const field of draft.form.fields) {
      const input = $(`review-${index}-${field.id}`);
      if (input) item.values[field.id] = inputValue(field, input);
    }
  });
}

function setMeetingError(message) {
  $("meeting-error").textContent = message;
  $("meeting-error").hidden = !message;
}

function clearMeetingReview() {
  state.extraction = null;
  renderReview();
  setMeetingError("");
}

$("meeting-form").addEventListener("input", clearMeetingReview);
$("meeting-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.extracting || state.committing) return;
  if (!state.ai.configured) { setMeetingError("AI is not configured. Connect a provider in AI settings. Manual records are available in To-do Items."); return aiSettings.open(); }
  state.extracting = true;
  $("meeting-form").querySelectorAll("input,textarea").forEach((input) => { input.disabled = true; });
  $("extract-meeting").disabled = true;
  $("extract-meeting").querySelector("span").textContent = "Extracting...";
  setMeetingError("");
  try {
    const draft = await api("/api/meetings/extract", { method: "POST", body: JSON.stringify({
      formId: state.form.id, title: $("meeting-title").value, date: $("meeting-date").value, text: $("meeting-text").value,
    }) });
    state.extraction = { ...draft, form: clone(state.form), items: draft.items.map((item) => ({ ...item, selected: true })) };
    await refresh();
    renderReview();
    $("meeting-review").scrollIntoView({ behavior: "smooth", block: "start" });
    toast("Extraction ready for review. No records saved yet.");
  } catch (error) { setMeetingError(error.message); }
  finally {
    state.extracting = false;
    $("meeting-form").querySelectorAll("input,textarea").forEach((input) => { input.disabled = false; });
    $("extract-meeting").disabled = false;
    $("extract-meeting").querySelector("span").textContent = "Extract action items";
  }
});
$("meeting-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  if (!/\.txt$/i.test(file.name) || file.size > 160000) { setMeetingError("Choose a UTF-8 .txt file up to 160 KB and 40,000 characters."); event.target.value = ""; return; }
  try {
    const text = await file.text();
    if (text.length > 40000) throw new Error("Meeting text must not exceed 40,000 characters.");
    $("meeting-text").value = text;
    if (!$("meeting-title").value) $("meeting-title").value = file.name.replace(/\.txt$/i, "").slice(0, 120);
    clearMeetingReview();
  } catch (error) { setMeetingError(error.message); }
  event.target.value = "";
});
$("review-items").addEventListener("input", () => {
  syncReview();
  $("save-items").disabled = state.committing || !state.extraction?.items.some((item) => item.selected);
});
$("save-items").addEventListener("click", async () => {
  if (!state.extraction || state.committing || state.extracting) return;
  syncReview();
  const draft = state.extraction;
  state.committing = true; $("save-items").disabled = true; setMeetingError("");
  try {
    const result = await api(`/api/meetings/${draft.id}/commit`, {
      method: "POST", body: JSON.stringify({ items: draft.items.flatMap((item, index) => item.selected ? [{ index, values: item.values }] : []) }),
    });
    draft.recordIds = result.recordIds;
    await refresh(); renderReview();
    toast(`${count(result.recordIds.length, "action item")} saved.`);
  } catch (error) {
    const fields = Object.entries(error.fields || {}).map(([id, message]) => `${draft.form.fields.find((field) => field.id === id)?.name || id}: ${message}`).join(" ");
    setMeetingError(`${error.message}${fields ? ` ${fields}` : ""}`);
  } finally { state.committing = false; $("save-items").disabled = false; }
});
$("meeting-date").value = new Date().toLocaleDateString("en-CA");
$("edit-table").addEventListener("click", openBuilder);
$("close-builder").addEventListener("click", () => {
  if (!state.builderBusy) guardDraft(() => $("builder-dialog").close());
});
$("builder-dialog").addEventListener("cancel", (event) => {
  event.preventDefault();
  if (!state.builderBusy) guardDraft(() => $("builder-dialog").close());
});
$("record-dialog").addEventListener("close", () => {
  const url = new URL(location.href); url.searchParams.delete("recordId"); history.replaceState(null, "", url);
});
$("builder-fields").addEventListener("input", handleBuilderInput);
$("builder-fields").addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove-field],[data-move]");
  if (!button || state.builderBusy) return;
  const row = button.closest("[data-field-id]");
  const index = state.draft.fields.findIndex((field) => field.id === row.dataset.fieldId);
  $("builder-error").hidden = true;
  if (button.hasAttribute("data-remove-field") && state.draft.fields.length > 1) state.draft.fields.splice(index, 1);
  else if (button.dataset.move) {
    const target = index + Number(button.dataset.move);
    if (target < 0 || target >= state.draft.fields.length) return;
    [state.draft.fields[index], state.draft.fields[target]] = [state.draft.fields[target], state.draft.fields[index]];
  }
  renderBuilder();
});
$("form-name").addEventListener("input", (event) => { state.draft.name = event.target.value; $("builder-error").hidden = true; builderStatus(); });
$("add-field").addEventListener("click", () => {
  $("builder-error").hidden = true;
  let number = state.draft.fields.length + 1;
  while (state.draft.fields.some((field) => field.name === `Field ${number}`)) number++;
  state.draft.fields.push({ id: `fld_${crypto.randomUUID()}`, name: `Field ${number}`, type: "text", required: false, unique: false, options: [] });
  renderBuilder();
  $("builder-fields").lastElementChild.querySelector("input").focus();
});
$("save-builder").addEventListener("click", saveBuilder);
$("reset-builder").addEventListener("click", () => guardDraft(resetBuilder));
$("preview-form").addEventListener("click", () => {
  if (!state.draft) return;
  $("preview-title").textContent = state.draft.name || "Untitled form";
  $("preview-fields").innerHTML = state.draft.fields.map((field) => makeInput(field, null, "preview")).join("");
  $("preview-dialog").showModal();
  icons();
});
$("create-record").addEventListener("click", () => openRecord());
$("empty-create").addEventListener("click", () => openRecord());
$("record-form").addEventListener("submit", saveRecord);
$("record-search").addEventListener("input", (event) => { state.search = event.target.value; if (state.form) renderRecords(); });
$("history-search").addEventListener("input", (event) => { state.historySearch = event.target.value; if (state.form) renderActivity(); });
$("history-kind").addEventListener("change", (event) => { state.historyKind = event.target.value; if (state.form) renderActivity(); });
$("refresh-records").addEventListener("click", refresh);
$("import-spreadsheet").addEventListener("click", () => guardDraft(() => spreadsheetImport.open()));
$("refresh-activity").addEventListener("click", refresh);
$("confirm-discard").addEventListener("click", () => {
  const action = state.pendingAction;
  resetBuilder();
  $("discard-dialog").close();
  state.pendingAction = null;
  action?.();
});
function newTable(moduleId) {
  if (state.extracting || state.committing) return;
  guardDraft(() => {
  $("new-form-form").reset();
  $("new-form-dialog").dataset.moduleId = moduleId;
  $("new-form-error").hidden = true;
  $("new-form-dialog").showModal();
  $("new-form-name").focus();
  });
}
$("new-form-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("submit-new-form").disabled = true;
  try {
    const form = await api("/api/forms", { method: "POST", body: JSON.stringify({ name: $("new-form-name").value, moduleId: $("new-form-dialog").dataset.moduleId }) });
    await switchForm(form.id);
    renderView("records");
    $("new-form-dialog").close();
    openBuilder();
    toast("Table created.");
  } catch (error) { $("new-form-error").textContent = error.message; $("new-form-error").hidden = false; }
  finally { $("submit-new-form").disabled = false; }
});
$("confirm-delete").addEventListener("click", async () => {
  if (!state.deleting) return;
  $("confirm-delete").disabled = true;
  try {
    await api(`/api/records/${state.deleting.id}`, { method: "DELETE", body: JSON.stringify({ version: state.deleting.version }) });
    $("delete-dialog").close();
    await refresh();
    toast("Record deleted. Activity history retained.");
  } catch (error) { $("delete-dialog").close(); toast(error.message, true); }
  finally { $("confirm-delete").disabled = false; }
});
document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => { if (!state.busy) $(button.dataset.close).close(); }));
document.querySelectorAll("[data-shortcut]").forEach((link) => link.addEventListener("click", (event) => { event.preventDefault(); renderView(link.dataset.shortcut); }));
document.addEventListener("click", (event) => {
  const reference = event.target.closest("[data-reference]");
  if (reference && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.button === 0) {
    event.preventDefault();
    const url = new URL(reference.href);
    guardDraft(() => navigateTable(url.searchParams.get("formId"), "records", url.searchParams.get("recordId")));
  }
  const table = event.target.closest("[data-table]");
  if (table) guardDraft(() => navigateTable(table.dataset.table));
  if (event.target.closest("[data-meeting]")) guardDraft(() => openMeeting());
  if (event.target.closest("[data-todos]")) guardDraft(() => openMeeting("records"));
  const supplierView = event.target.closest("[data-supplier-view]");
  if (supplierView) guardDraft(() => openSupplier(supplierView.dataset.supplierView));
  const createTable = event.target.closest("[data-new-table]");
  if (createTable) newTable(createTable.dataset.newTable);
  const view = event.target.closest("[data-view]");
  if (view) renderView(view.dataset.view);
  const meeting = event.target.closest("[data-import]");
  if (meeting && !state.extracting && !state.committing) {
    (async () => {
      try {
        const draft = await api(`/api/meetings/${meeting.dataset.import}`);
        await navigateTable(draft.formId, "meeting");
        const form = clone(state.form);
        if (!draft.recordIds && draft.schemaVersion !== form.version) return setMeetingError("This draft uses an older table schema. Import its text again using the current fields.");
        state.extraction = { ...draft, form, items: draft.items.map((item) => ({ ...item, selected: true })) };
        $("meeting-title").value = draft.title; $("meeting-date").value = draft.date; $("meeting-text").value = draft.text;
        setMeetingError(""); renderReview();
      } catch (error) { setMeetingError(error.message); }
    })();
  }
  const edit = event.target.closest("[data-edit]");
  const remove = event.target.closest("[data-delete]");
  const historyLink = event.target.closest("[data-open-record]");
  if (edit) openRecord(edit.dataset.edit);
  if (historyLink) openRecord(historyLink.dataset.openRecord);
  if (remove) { state.deleting = clone(state.records.find((record) => record.id === remove.dataset.delete)); $("delete-dialog").showModal(); }
});
window.addEventListener("beforeunload", (event) => { if (dirty()) { event.preventDefault(); event.returnValue = ""; } });
window.addEventListener("hashchange", () => {
  const view = location.hash.slice(1);
  if (!["records", "meeting", "activity", "document", "reconciliation"].includes(view)) return;
  if (state.extracting || state.committing || supplier.isBusy()) { renderView(state.view); return; }
  guardDraft(() => {
    if (view === "meeting" && state.form?.moduleId !== "meetings") openMeeting();
    else if (["document", "reconciliation"].includes(view)) openSupplier(view);
    else renderView(view);
  });
});
$("record-dialog").addEventListener("cancel", (event) => { if (state.busy) event.preventDefault(); });
renderView(["records", "meeting", "activity", "document", "reconciliation"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "records");
icons();
const initial = new URLSearchParams(location.search);
load(initial.get("formId")).then(async () => {
  if (state.view === "meeting" && state.form.moduleId !== "meetings") await openMeeting();
  if (["document", "reconciliation"].includes(state.view)) await openSupplier(state.view);
  if (initial.get("recordId")) openRecord(initial.get("recordId"));
}).catch((error) => notice(error.message));
