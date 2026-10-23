import { html, uiText, setUIText, uiAttributes, t, initI18n } from "/i18n.js";
import { FIELD_DEFINITIONS as TYPES, inputValue } from "/field-types.js";
import { fieldDisplay, renderFieldInput, renderFieldCell } from "/field-ui.js";
import { initAISettings } from "/ai-settings.js";
import { initAssistant } from "/assistant.js";
import { initTableImport } from "/table-import.js";
import { initFormDeletion } from "/form-deletion.js";
import { initWarehouse } from "/warehouse.js";
import { initWorkspace, initAttachments } from "/workspace.js";
import { initAuth } from "/auth.js";
const KIND_LABELS = { created: "Record created", updated: "Record updated", deleted: "Record deleted" };
initI18n();
const state = {
  form: null, forms: [], records: [], changes: [], view: "records", search: "", historySearch: "", historyKind: "all",
  draft: null, editing: null, deleting: null, busy: false, builderBusy: false, pendingAction: null, loadNumber: 0,
  modules: [], references: [], ai: {}, user: null, permissions: {},
  warehouse: { tables: {}, managedFields: {} }, spaces: [], space: null, navigation: [], errorCount: 0, notifications: [],
};
const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const clone = (value) => structuredClone(value);
const icon = (name) => html`<i data-lucide="${esc(name)}" aria-hidden="true"></i>`;
const icons = () => window.lucide?.createIcons?.({ attrs: { "stroke-width": 1.8 } });
const count = (n, singular, plural = singular + "s") => `${n} ${n === 1 ? singular : plural}`;
const dirty = () => state.draft && state.form && JSON.stringify({ name: state.draft.name, fields: state.draft.fields }) !== JSON.stringify({ name: state.form.name, fields: state.form.fields });
let auth, authGeneration = 0;
const can = permission => Boolean(state.user && state.permissions[permission]);
const coreField = id => (state.warehouse.coreFields?.[warehouse.roleOf(state.form?.id)] ?? []).includes(id);

function toast(message, error = false) {
  const node = document.createElement("div");
  node.className = `toast${error ? " toast-error" : ""}`;
  node.setAttribute("role", error ? "alert" : "status");
  node.innerHTML = html`${icon(error ? "circle-alert" : "circle-check")}<span>${uiText(message)}</span><button class="toast-close" aria-label="Dismiss notification">${icon("x")}</button>`;
  node.querySelector("button").onclick = () => node.remove();
  $("toast-region").append(node);
  icons();
  setTimeout(() => node.remove(), 6000);
}

function notice(message) {
  if (!state.user) return;
  $("notice").innerHTML = html`${icon("circle-alert")}<span>${uiText(message)}</span><button class="toast-close" aria-label="Dismiss notification">${icon("x")}</button>`;
  $("notice").hidden = false;
  $("notice").querySelector("button").onclick = () => { $("notice").hidden = true; };
  setUIText($("connection-label"), "Connection issue");
  $("connection-state").classList.add("is-offline");
  icons();
}

async function api(path, options = {}) {
  const session = authGeneration;
  let response;
  const headers = { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers };
  if (options.method && options.method !== "GET") headers["Idempotency-Key"] ??= crypto.randomUUID();
  try { response = await fetch(path, { ...options, headers }); }
  catch { throw new Error("Could not reach the local server. Check that it is running."); }
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.error || `Request failed (${response.status}).`);
    error.status = response.status;
    error.fields = payload.fields || {};
    if (response.status === 401 && session === authGeneration && !path.startsWith("/api/auth/")) auth?.expire();
    throw error;
  }
  return payload;
}

const warehouse = initWarehouse({ api, icons, toast, getState: () => state, refresh, navigate: navigateTable, showView: renderView });

const aiSettings = initAISettings({ api, icons, canManage: () => can("manageSettings"), onSaved(settings) {
  state.ai = settings;
  toast("AI settings saved.");
} });
const assistant = initAssistant({ api, icons, onChanged: refresh, getState: () => state });
const spreadsheetImport = initTableImport({ api, icons, toast, getState: () => state, onImported: (id) => navigateTable(id) });
const formDeletion = initFormDeletion({ api, icons, toast, async onDeleted(id) {
  if (state.form?.id === id) {
    $("builder-dialog").close(); $("record-dialog").close();
    state.draft = null;
    await load(null);
    renderView("records");
  } else await refresh();
} });
const workspace = initWorkspace({ api, icons, toast, getState: () => state, refresh, navigate: navigateTable, showView: renderView, getDraft: () => state.draft, onDraftChanged: renderBuilder,
  deleteForm: id => { if (can("manageForms")) guardDraft(() => formDeletion.open(id)); } });
initAttachments({ api, getState: () => state, toast, icons });
const initial = new URLSearchParams(location.search);
const initialView = ["records", "activity", "warehouse-flows", "notifications-rules", "ai-tasks", "errors"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "records";
auth = initAuth({ api, icons,
  async onAuthenticated(session) {
    state.user = session.user; state.permissions = session.permissions || {};
    await load(initial.get("formId"));
    if (!state.user) return;
    renderView(initialView);
    if (initial.get("recordId")) openRecord(initial.get("recordId"));
  },
  onSignedOut() {
    authGeneration++;
    ++state.loadNumber; ++formulaPreviewVersion; clearTimeout(formulaPreviewTimer);
    state.user = null; state.permissions = {}; state.form = null; state.forms = []; state.records = []; state.changes = [];
    state.draft = null; state.editing = null; state.deleting = null; state.pendingAction = null;
    state.busy = false; state.builderBusy = false;
    state.spaces = []; state.space = null; state.navigation = []; state.references = []; state.notifications = []; state.modules = [];
    state.ai = {}; state.warehouse = { tables: {}, managedFields: {} }; state.search = ""; state.historySearch = "";
    $("submit-new-form").disabled = false; $("confirm-delete").disabled = false;
    aiSettings.reset(); assistant.reset(); spreadsheetImport.reset(); formDeletion.reset(); workspace.reset?.(); warehouse.reset?.();
    for (const id of ["record-rows", "record-columns", "history-list", "module-navigation", "builder-fields", "record-fields", "preview-fields", "toast-region", "view-warehouse-flows", "view-notifications-rules", "view-ai-tasks", "view-errors"]) $(id).replaceChildren();
    $("record-search").value = ""; $("history-search").value = ""; $("notice").hidden = true;
  },
});

function formatTimestamp(value) {
  return new Intl.DateTimeFormat("en-GB", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(value));
}

function displayValue(field, value) {
  return fieldDisplay(field, value, state.references);
}

function renderSidebar() {
  if (state.space) workspace.renderNavigation();
}

function recordTitle(record) {
  const field = state.form.fields.find((f) => f.unique && record.values[f.id] != null) || state.form.fields.find((f) => record.values[f.id] != null);
  return field ? displayValue(field, record.values[field.id]) : record.id.slice(0, 8);
}

function renderRecords() {
  $("record-content").hidden = !state.form;
  $("workspace-empty").hidden = Boolean(state.form);
  if (!state.form) return;
  const role = warehouse.roleOf(state.form.id);
  const fields = state.form.fields.filter(field => !(role === "stock" && field.id === "stockKey"));
  warehouse.renderToolbar();
  const query = state.search.trim().toLowerCase();
  const records = warehouse.filter(state.records).filter((record) => !query || fields.some((field) => displayValue(field, record.values[field.id]).toLowerCase().includes(query)));
  $("metric-total").textContent = state.records.length;
  $("metric-fields").textContent = fields.length;
  $("metric-required").textContent = fields.filter((field) => field.required).length;
  $("metric-changes").textContent = state.changes.length;
  $("records-title").textContent = state.form.name;
  setUIText($("visible-record-count"), count(records.length, "record"));
  $("record-columns").innerHTML = html`<tr>${fields.map((field) => html`<th><span class="column-heading">${icon(TYPES[field.type].icon)}<span>${esc(field.name)}</span>${field.unique ? html`<span class="column-unique" title="Unique">${icon("key-round")}</span>` : ""}</span></th>`).join("")}<th>Last updated</th><th><span class="sr-only">Actions</span></th></tr>`;
  $("record-rows").innerHTML = records.map((record) => html`<tr>${fields.map((field, index) => {
    const value = record.values[field.id];
    const content = warehouse.cell(field, value, record) ?? renderFieldCell(field, value, { catalog: state.references, primary: index === 0, recordId: record.id });
    return html`<td>${content}</td>`;
  }).join("")}<td class="updated-cell">${esc(formatTimestamp(record.updatedAt))}</td><td><div class="row-actions"><button class="icon-button" data-edit="${record.id}" title="${warehouse.canEditRecord(record) ? "Edit record" : "View record"}" aria-label="${warehouse.canEditRecord(record) ? "Edit" : "View"} ${esc(recordTitle(record))}">${icon(warehouse.canEditRecord(record) ? "pencil" : "eye")}</button><button ${can("editRecords") && warehouse.canDelete(record) ? "" : "hidden"} class="icon-button action-delete" data-delete="${record.id}" title="Delete record" aria-label="Delete ${esc(recordTitle(record))}">${icon("trash-2")}</button></div></td></tr>`).join("");
  $("records-empty").hidden = records.length > 0;
  $("record-table-wrap").classList.toggle("has-empty", !records.length);
  setUIText($("empty-title"), state.records.length ? "No matching records" : "No records yet");
  $("empty-create").hidden = !can("editRecords") || Boolean(role) || state.records.length > 0;
  $("empty-new-form").hidden = !can("manageForms");
  icons();
}

function renderActivity() {
  const query = state.historySearch.trim().toLowerCase();
  const changes = state.changes.filter((entry) => (state.historyKind === "all" || state.historyKind === entry.kind) &&
    (!query || `${entry.recordTitle} ${entry.diff.map((diff) => `${diff.name} ${diff.before ?? ""} ${diff.after ?? ""}`).join(" ")}`.toLowerCase().includes(query)));
  setUIText($("history-count"), count(changes.length, "event"));
  $("history-empty").hidden = changes.length > 0;
  setUIText($("history-empty").querySelector("h3"), state.changes.length ? "No matching events" : "No activity yet");
  $("history-list").hidden = !changes.length;
  $("history-list").innerHTML = changes.map((entry) => html`<article class="history-entry"><div class="event-glyph event-${entry.kind}">${icon(entry.kind === "created" ? "plus" : entry.kind === "updated" ? "pencil" : "trash-2")}</div><div class="history-content"><div class="history-meta"><span class="history-kind">${uiText(KIND_LABELS[entry.kind])}</span><time datetime="${entry.createdAt}" title="${esc(new Date(entry.createdAt).toLocaleString("en-GB"))}">${esc(formatTimestamp(entry.createdAt))}</time></div><div class="history-order">${esc(entry.recordTitle)}</div><ul class="diff-list">${entry.diff.map((diff) => html`<li class="diff-item"><span class="diff-label">${esc(diff.name)}</span><span class="diff-before">${esc(displayValue(diff, diff.before))}</span><span class="diff-arrow" aria-label="changed to">${icon("arrow-right")}</span><span class="diff-after">${esc(displayValue(diff, diff.after))}</span></li>`).join("")}</ul><button class="history-link" data-open-record="${entry.recordId}">Open record ${icon("arrow-up-right")}</button></div></article>`).join("");
  icons();
}

function renderBuilder() {
  if (!state.draft) return;
  $("form-name").value = state.draft.name;
  $("builder-fields").innerHTML = `${state.draft.fields.some(field => coreField(field.id)) ? html`<p class="builder-core-note">Warehouse core fields keep their types and validation rules. You can rename and reorder them, and add custom fields.</p>` : ""}` + state.draft.fields.map((field, index) => html`<div class="builder-field" data-field-id="${field.id}">
    <div class="builder-field-main">
      <div class="builder-name"><span class="field-type-icon">${icon(TYPES[field.type].icon)}</span><input data-prop="name" value="${esc(field.name)}" maxlength="64" aria-label="Field ${index + 1} name" placeholder="Field name"></div>
      <select data-prop="type" ${coreField(field.id) ? "data-core-lock" : ""} aria-label="Field ${index + 1} type">${Object.entries(TYPES).map(([type, info]) => html`<option value="${type}"${type === field.type ? " selected" : ""}>${uiText(info.label)}</option>`).join("")}</select>
      <label class="rule-control"><span>Required</span><input type="checkbox" class="toggle-input" data-prop="required" ${coreField(field.id) ? "data-core-lock" : ""} ${field.required ? "checked" : ""} aria-label="${esc(field.name || `Field ${index + 1}`)} required"></label>
      <label class="rule-control"><span>Unique</span><input type="checkbox" class="toggle-input" data-prop="unique" ${coreField(field.id) ? "data-core-lock" : ""} ${field.unique ? "checked" : ""} aria-label="${esc(field.name || `Field ${index + 1}`)} unique"></label>
      <div class="field-actions">${field.type === "number" ? html`<button class="icon-button${field.formula ? " is-active" : ""}" ${coreField(field.id) ? "data-core-lock" : ""} data-edit-field-formula="${field.id}" title="Edit field formula" aria-label="${esc(field.name)} formula">${icon("square-function")}</button>` : ""}<button class="icon-button" data-move="-1" title="Move field up" aria-label="Move field ${index + 1} up"${index === 0 ? " disabled" : ""}>${icon("arrow-up")}</button><button class="icon-button" data-move="1" title="Move field down" aria-label="Move field ${index + 1} down"${index === state.draft.fields.length - 1 ? " disabled" : ""}>${icon("arrow-down")}</button><button class="icon-button action-delete" ${coreField(field.id) ? "data-core-lock" : ""} data-remove-field title="Remove field" aria-label="Remove field ${index + 1}"${state.draft.fields.length === 1 ? " disabled" : ""}>${icon("trash-2")}</button></div>
    </div>
    ${field.type === "select" ? html`<div class="dropdown-options"><label for="options-${field.id}">Options</label><textarea id="options-${field.id}" data-prop="options" ${coreField(field.id) ? "data-core-lock" : ""} rows="${Math.min(5, Math.max(2, field.options.length))}" aria-label="${esc(field.name)} options" placeholder="One option per line">${esc(field.options.join("\n"))}</textarea><span class="option-count">${uiText(count(field.options.filter((v) => v.trim()).length, "option"))}</span></div>` : ""}
    ${field.type === "reference" ? referenceSettings(field) : ""}
    ${field.formula ? html`<div class="field-formula-summary">${icon("square-function")}<code>${esc(field.formula.expression)}</code></div>` : ""}
    </div>`).join("");
  $("builder-fields").querySelectorAll("input,select,textarea,[data-core-lock]").forEach((input) => { input.disabled = state.builderBusy || !can("manageForms") || input.hasAttribute("data-core-lock"); });
  $("form-name").disabled = state.builderBusy;
  $("preview-form").disabled = state.builderBusy;
  builderStatus();
  icons();
}

function referenceSettings(field) {
  const tables = state.references.filter((table) => table.id !== state.form.id && table.fields.length);
  const selected = tables.find((table) => table.id === field.reference?.formId);
  return html`<div class="reference-settings"><label>Target table<select data-prop="referenceTable" ${coreField(field.id) ? "data-core-lock" : ""} aria-label="${esc(field.name)} target table"><option value="">Choose table</option>${tables.map((table) => html`<option value="${table.id}"${table.id === selected?.id ? " selected" : ""}>${esc(table.name)}</option>`).join("")}</select></label><label>Unique field<select data-prop="referenceField" ${coreField(field.id) ? "data-core-lock" : ""} aria-label="${esc(field.name)} unique field"><option value="">Choose unique field</option>${(selected?.fields || []).map((key) => html`<option value="${key.id}"${key.id === field.reference?.fieldId ? " selected" : ""}>${esc(key.name)}</option>`).join("")}</select></label></div>`;
}

function builderStatus() {
  if (!state.form) return;
  const changed = dirty();
  setUIText($("schema-version"), `Version ${state.form.version}`);
  setUIText($("builder-field-count"), count(state.draft.fields.length, "field"));
  setUIText($("builder-save-state"), state.builderBusy ? "Saving..." : changed ? "Unsaved changes" : "All changes saved");
  $("builder-save-state").classList.toggle("unsaved", Boolean(changed));
  $("save-builder").disabled = !can("manageForms") || !changed || state.builderBusy;
  $("reset-builder").disabled = !changed || state.builderBusy;
  $("add-field").disabled = !can("manageForms") || state.builderBusy || state.draft.fields.length >= 40;
}

function renderView(view) {
  if (!state.user) return;
  if (view === "automations") view = "warehouse-flows";
  if (view === "notifications-rules" && !can("manageForms")) view = "records";
  if (!state.form && ["activity", "notifications-rules"].includes(view)) view = "records";
  state.view = view;
  document.querySelectorAll(".page-view").forEach((section) => { section.hidden = section.id !== `view-${view}`; });
  document.querySelectorAll("[data-view]").forEach((button) => {
    const current = button.dataset.view === view;
    button.classList.toggle("is-active", current);
    if (current) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  setUIText($("breadcrumb-current"), { records: "Records", activity: "Activity", "notifications-rules": "Notification rules", "warehouse-flows": "Warehouse workflows", "ai-tasks": "AI tasks", errors: "Error Center" }[view]);
  history.replaceState(null, "", `#${view}`);
  renderSidebar();
  warehouse.enter(view);
  if (state.space) workspace.enter(view);
}

async function load(formId = state.form?.id, preserveDraft = false, spaceId = state.space?.id ?? new URLSearchParams(location.search).get("spaceId") ?? "default") {
  const requestNumber = ++state.loadNumber;
  const params = new URLSearchParams({ spaceId });
  if (formId) params.set("formId", formId);
  let data;
  try { data = await api(`/api/bootstrap?${params}`); }
  catch (error) {
    if (requestNumber !== state.loadNumber) return;
    if (error.status !== 404 || !formId) throw error;
    params.delete("formId");
    data = await api(`/api/bootstrap?${params}`);
    preserveDraft = false;
  }
  if (requestNumber !== state.loadNumber) return;
  state.user = data.user; state.permissions = data.permissions || {};
  auth?.setSession(data);
  state.form = data.form;
  state.forms = data.forms;
  state.spaces = data.spaces; state.space = data.space; state.navigation = data.navigation;
  state.errorCount = data.errorCount; state.notifications = data.notifications;
  state.records = data.records;
  state.changes = data.changes;
  state.modules = data.modules; state.references = data.references; state.ai = data.ai;
  state.warehouse = data.warehouse || { tables: {}, managedFields: {} };
  if (!preserveDraft) state.draft = clone(state.form);
  const url = new URL(location.href);
  if (state.form) url.searchParams.set("formId", state.form.id);
  else { url.searchParams.delete("formId"); url.searchParams.delete("recordId"); }
  url.searchParams.set("spaceId", state.space.id);
  history.replaceState(null, "", url);
  $("create-record").disabled = !state.form || !can("editRecords");
  $("empty-new-form").hidden = !can("manageForms");
  $("breadcrumb-form").textContent = state.form?.name ?? state.space.name;
  setUIText($("sidebar-form-count"), count(state.forms.length, "table"));
  $("notice").hidden = true;
  setUIText($("connection-label"), "Connected");
  $("connection-state").classList.remove("is-offline");
  setUIText($("sync-timestamp"), `Last synced ${new Date().toLocaleTimeString("en-GB", { hour12: false })}`);
  renderRecords();
  renderActivity();
  renderBuilder();
  renderSidebar();
  if (!state.form && ["activity", "notifications-rules"].includes(state.view)) renderView("records");
  if (state.view === "warehouse-flows") warehouse.enter(state.view);
  if (["notifications-rules", "ai-tasks", "errors"].includes(state.view)) workspace.enter(state.view);
}

async function refresh() {
  if (!state.user) return;
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
  if (!recordId && !can("editRecords")) return;
  if (warehouse.openRecord(recordId)) return;
  const record = recordId ? state.records.find((item) => item.id === recordId) : null;
  if (recordId && !record) return toast("This record has been deleted. Its history is still available.", true);
  state.editing = { record: record ? clone(record) : null, form: clone(state.form) };
  const readOnly = !can("editRecords"), role = warehouse.roleOf(state.form.id);
  const managed = [...(state.warehouse.managedFields[role] ?? []), ...(["inboundLines", "outboundLines"].includes(role) ? ["document"] : [])];
  setUIText($("record-dialog-title"), readOnly ? "View record" : record ? "Edit record" : "New record");
  $("record-form-label").textContent = state.form.name;
  $("record-fields").innerHTML = state.form.fields.filter(field => !(role === "stock" && field.id === "stockKey")).map(field => readOnly || managed.includes(field.id)
    ? html`<div class="input-field"><span class="builder-label">${esc(field.name)}</span><div class="managed-field-value">${warehouse.cell(field, record?.values[field.id], record ?? { formId: state.form.id, values: {} }) ?? renderFieldCell(field, record?.values[field.id], { catalog: state.references })}</div>${!readOnly && managed.includes(field.id) ? html`<span class="managed-field-note">Managed by the warehouse workflow.</span>` : ""}</div>`
    : makeInput(field, record?.values[field.id])).join("");
  $("record-error").hidden = true;
  $("submit-record").innerHTML = html`${icon("check")}<span>${record ? "Save changes" : "Save record"}</span>`;
  $("submit-record").hidden = readOnly;
  $("record-dialog").showModal();
  if (record) {
    const url = new URL(location.href); url.searchParams.set("recordId", record.id); history.replaceState(null, "", url);
  }
  $("record-fields").querySelector("input,select,textarea")?.focus();
  icons();
}

async function saveRecord(event) {
  event.preventDefault();
  if (state.busy || !state.editing || !can("editRecords")) return;
  const editor = state.editing;
  const session = authGeneration;
  const values = Object.create(null);
  for (const field of editor.form.fields) {
    if (field.formula) continue;
    const input = $(`record-${field.id}`);
    if (!input || input.disabled) continue;
    if (input.closest(".attachment-editor")?.querySelector("[data-attachment-upload]")?.disabled) return toast("Wait for attachments to finish uploading.", true);
    values[field.id] = inputValue(field, input);
    input.removeAttribute("aria-invalid");
    if ($(`record-error-${field.id}`)) $(`record-error-${field.id}`).hidden = true;
  }
  state.busy = true;
  $("submit-record").disabled = true;
  $("record-error").hidden = true;
  const body = { schemaVersion: editor.form.version, values, ...(editor.record ? { version: editor.record.version } : {}) };
  try {
    const result = await api(editor.record ? `/api/records/${editor.record.id}` : `/api/forms/${editor.form.id}/records`, {
      method: editor.record ? "PATCH" : "POST", body: JSON.stringify(body),
    });
    if (session !== authGeneration) return;
    $("record-dialog").close();
    await refresh();
    toast(result.changed ? editor.record ? "Record updated. Changes added to activity." : "Record created." : "No changes to save.");
  } catch (error) {
    if (session !== authGeneration) return;
    setUIText($("record-error"), error.message);
    $("record-error").hidden = false;
    let firstInput;
    for (const [id, message] of Object.entries(error.fields || {})) {
      const input = $(`record-${id}`);
      const label = $(`record-error-${id}`);
      if (!input || !label) continue;
      input.setAttribute("aria-invalid", "true");
      input.setAttribute("aria-describedby", label.id);
      setUIText(label, message);
      label.hidden = false;
      firstInput ??= input;
    }
    firstInput?.focus();
  } finally { if (session === authGeneration) { state.busy = false; $("submit-record").disabled = false; } }
}

async function saveBuilder() {
  if (!can("manageForms") || !dirty() || state.builderBusy) return;
  state.builderBusy = true;
  const session = authGeneration;
  $("builder-error").hidden = true;
  renderBuilder();
  try {
    const saved = await api(`/api/forms/${state.form.id}`, {
      method: "PUT", body: JSON.stringify({ version: state.draft.version, name: state.draft.name, fields: state.draft.fields }),
    });
    if (session !== authGeneration) return;
    state.form = saved;
    state.draft = clone(saved);
    await load(saved.id);
    toast("Table saved.");
  } catch (error) {
    if (session !== authGeneration) return;
    setUIText($("builder-error"), error.message);
    $("builder-error").hidden = false;
    $("builder-error").scrollIntoView({ block: "nearest", behavior: "smooth" });
  } finally { if (session === authGeneration) { state.builderBusy = false; renderBuilder(); } }
}

function handleBuilderInput(event) {
  const input = event.target.closest("[data-prop]");
  if (!input || !can("manageForms")) return;
  const row = input.closest("[data-field-id]");
  const field = state.draft.fields.find((item) => item.id === row.dataset.fieldId);
  const prop = input.dataset.prop;
  if (coreField(field.id) && prop !== "name") return;
  $("builder-error").hidden = true;
  if (prop === "referenceTable") {
    const table = state.references.find((table) => table.id === input.value);
    field.reference = { formId: input.value, fieldId: table?.fields[0]?.id || "" };
    renderBuilder(); return;
  }
  if (prop === "referenceField") { field.reference.fieldId = input.value; builderStatus(); return; }
  field[prop] = prop === "required" || prop === "unique" ? input.checked : prop === "options" ? input.value.split(/\r?\n/) : input.value;
  if (prop === "type") {
    if (field.type !== "number") delete field.formula;
    if (field.type === "attachment") field.unique = false;
    if (field.type === "select" && !field.options.length) field.options = ["Option 1", "Option 2"];
    if (field.type !== "select") field.options = [];
    if (field.type === "reference") field.reference = { formId: "", fieldId: "" };
    else delete field.reference;
    renderBuilder();
  } else {
    if (prop === "options") setUIText(row.querySelector(".option-count"), count(field.options.filter((option) => option.trim()).length, "option"));
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
  if (!state.form || !can("manageForms")) return;
  renderBuilder();
  $("builder-dialog").showModal();
}

async function navigateTable(id, view = "records", recordId = null, spaceId = state.space?.id) {
  try {
    if (!id) { state.draft = null; await load(null, false, spaceId); }
    else if (state.form?.id !== id) await switchForm(id);
    renderView(view);
    if (recordId) openRecord(recordId);
  } catch { /* switchForm already displays the connection error. */ }
}

$("edit-table").addEventListener("click", openBuilder);
$("delete-table").addEventListener("click", () => { if (can("manageForms") && !warehouse.roleOf(state.form?.id)) guardDraft(() => formDeletion.open(state.form.id)); });
$("empty-new-form").addEventListener("click", () => newTable("custom"));
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
  if (!can("manageForms")) return;
  const formula = event.target.closest("[data-edit-field-formula]");
  if (formula && !state.builderBusy && !coreField(formula.dataset.editFieldFormula)) return workspace.editFieldFormula(formula.dataset.editFieldFormula);
  const button = event.target.closest("[data-remove-field],[data-move]");
  if (!button || state.builderBusy) return;
  const row = button.closest("[data-field-id]");
  const index = state.draft.fields.findIndex((field) => field.id === row.dataset.fieldId);
  $("builder-error").hidden = true;
  if (button.hasAttribute("data-remove-field") && state.draft.fields.length > 1 && !coreField(row.dataset.fieldId)) state.draft.fields.splice(index, 1);
  else if (button.dataset.move) {
    const target = index + Number(button.dataset.move);
    if (target < 0 || target >= state.draft.fields.length) return;
    [state.draft.fields[index], state.draft.fields[target]] = [state.draft.fields[target], state.draft.fields[index]];
  }
  renderBuilder();
});
$("form-name").addEventListener("input", (event) => { if (!can("manageForms")) return; state.draft.name = event.target.value; $("builder-error").hidden = true; builderStatus(); });
$("add-field").addEventListener("click", () => {
  if (!can("manageForms") || !state.draft || state.builderBusy) return;
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
let formulaPreviewTimer = null, formulaPreviewVersion = 0;
$("record-form").addEventListener("input", () => {
  if (!can("editRecords")) return;
  const editor = state.editing;
  if (!editor?.form.fields.some((field) => field.formula)) return;
  clearTimeout(formulaPreviewTimer);
  const version = ++formulaPreviewVersion;
  formulaPreviewTimer = setTimeout(async () => {
    const values = Object.fromEntries(editor.form.fields.filter((field) => !field.formula && $(`record-${field.id}`)).map((field) => [field.id, inputValue(field, $(`record-${field.id}`))]));
    try {
      const result = await api("/api/formulas/preview", { method: "POST", body: JSON.stringify({ formId: editor.form.id, recordId: editor.record?.id, values }) });
      if (state.editing !== editor || formulaPreviewVersion !== version) return;
      for (const field of editor.form.fields.filter((field) => field.formula)) $(`record-${field.id}`).value = result.values[field.id] ?? "";
    } catch {
      if (state.editing === editor && formulaPreviewVersion === version) for (const field of editor.form.fields.filter((field) => field.formula)) $(`record-${field.id}`).value = "";
    }
  }, 200);
});
$("record-search").addEventListener("input", (event) => { state.search = event.target.value; if (state.form) renderRecords(); });
$("history-search").addEventListener("input", (event) => { state.historySearch = event.target.value; if (state.form) renderActivity(); });
$("history-kind").addEventListener("change", (event) => { state.historyKind = event.target.value; if (state.form) renderActivity(); });
$("refresh-records").addEventListener("click", refresh);
$("import-spreadsheet").addEventListener("click", () => { if (can("editRecords")) guardDraft(() => spreadsheetImport.open()); });
$("refresh-activity").addEventListener("click", refresh);
$("confirm-discard").addEventListener("click", () => {
  const action = state.pendingAction;
  resetBuilder();
  $("discard-dialog").close();
  state.pendingAction = null;
  action?.();
});
function newTable(moduleId) {
  if (!can("manageForms")) return;
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
  if (!can("manageForms")) return;
  const session = authGeneration;
  $("submit-new-form").disabled = true;
  try {
    const form = await api("/api/forms", { method: "POST", body: JSON.stringify({ name: $("new-form-name").value, moduleId: $("new-form-dialog").dataset.moduleId, spaceId: state.space?.id }) });
    if (session !== authGeneration) return;
    await switchForm(form.id);
    if (session !== authGeneration) return;
    renderView("records");
    $("new-form-dialog").close();
    openBuilder();
    toast("Table created.");
  } catch (error) { if (session === authGeneration) { setUIText($("new-form-error"), error.message); $("new-form-error").hidden = false; } }
  finally { if (session === authGeneration) $("submit-new-form").disabled = false; }
});
$("confirm-delete").addEventListener("click", async () => {
  if (!state.deleting || !can("editRecords")) return;
  const session = authGeneration;
  $("confirm-delete").disabled = true;
  try {
    await api(`/api/records/${state.deleting.id}`, { method: "DELETE", body: JSON.stringify({ version: state.deleting.version }) });
    if (session !== authGeneration) return;
    $("delete-dialog").close();
    await refresh();
    if (session !== authGeneration) return;
    toast("Record deleted. Activity history retained.");
  } catch (error) { if (session === authGeneration) { $("delete-dialog").close(); toast(error.message, true); } }
  finally { if (session === authGeneration) $("confirm-delete").disabled = false; }
});
document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => { if (!state.busy) $(button.dataset.close).close(); }));
document.querySelectorAll("[data-shortcut]").forEach((link) => link.addEventListener("click", (event) => { event.preventDefault(); renderView(link.dataset.shortcut); }));
$("toggle-navigation").addEventListener("click", () => {
  const open = $("module-navigation").classList.toggle("is-mobile-open");
  $("toggle-navigation").setAttribute("aria-expanded", String(open));
});
document.addEventListener("click", (event) => {
  if (event.target.closest("#module-navigation button,#space-tools button") && window.matchMedia("(max-width: 650px)").matches) {
    $("module-navigation").classList.remove("is-mobile-open");
    $("toggle-navigation").setAttribute("aria-expanded", "false");
  }
  const reference = event.target.closest("[data-reference]");
  if (reference && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.button === 0) {
    event.preventDefault();
    const url = new URL(reference.href);
    guardDraft(() => navigateTable(url.searchParams.get("formId"), "records", url.searchParams.get("recordId")));
  }
  const table = event.target.closest("[data-table]");
  if (table) guardDraft(() => navigateTable(table.dataset.table));
  const createTable = event.target.closest("[data-new-table]");
  if (createTable) newTable(createTable.dataset.newTable);
  const view = event.target.closest("[data-view]");
  if (view) renderView(view.dataset.view);
  const edit = event.target.closest("[data-edit]");
  const remove = event.target.closest("[data-delete]");
  const historyLink = event.target.closest("[data-open-record]");
  if (edit) openRecord(edit.dataset.edit);
  if (historyLink) openRecord(historyLink.dataset.openRecord);
  if (remove && can("editRecords")) { const record = state.records.find(record => record.id === remove.dataset.delete); if (record && warehouse.canDelete(record)) { state.deleting = clone(record); $("delete-dialog").showModal(); } }
});
window.addEventListener("beforeunload", (event) => { if (dirty()) { event.preventDefault(); event.returnValue = ""; } });
window.addEventListener("hashchange", () => {
  const view = location.hash.slice(1);
  if (!["records", "activity", "warehouse-flows", "notifications-rules", "ai-tasks", "errors"].includes(view)) return;
  guardDraft(() => renderView(view));
});
$("record-dialog").addEventListener("cancel", (event) => { if (state.busy) event.preventDefault(); });
window.addEventListener("warehouse-filter", () => { if (state.form) renderRecords(); });
icons();
auth.start();
