import { html, uiText, setUIText, uiAttributes, t } from "/i18n.js";
import { displayValue as scalarDisplay } from "/field-types.js";

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const icon = (name) => html`<i data-lucide="${esc(name)}" aria-hidden="true"></i>`;

export function fieldDisplay(field, value, catalog) {
  if (field.type === "reference" && value != null && field.reference) {
    const table = catalog.find((table) => table.id === field.reference.formId);
    const key = table?.fields.find((key) => key.id === field.reference.fieldId);
    const target = table?.records.find((record) => record.id === value);
    return key && target ? scalarDisplay(key, target.values[key.id]) : "Unavailable record";
  }
  return scalarDisplay(field, value);
}

export function renderFieldInput(field, value, prefix, catalog) {
  const id = `${prefix}-${field.id}`;
  const attr = `id="${id}" data-value-id="${field.id}" ${field.required ? "required" : ""}`;
  let input;
  if (field.formula) input = html`<input ${attr} type="number" value="${esc(value ?? "")}" readonly aria-label="${esc(field.name)} (calculated)">`;
  else if (field.type === "attachment") input = html`<div class="attachment-editor"><input type="hidden" ${attr} data-files="${esc(JSON.stringify(value ?? []))}"><label class="button button-secondary attachment-upload">${icon("paperclip")}<span>Attach file</span><input type="file" data-attachment-upload="${id}" accept=".pdf,.png,.jpg,.jpeg" hidden multiple></label><div class="attachment-list">${(value ?? []).map((file, index) => html`<span class="attachment-item"><a href="/api/attachments/${encodeURIComponent(file)}" target="_blank" rel="noopener">File ${index + 1}</a><button type="button" class="icon-button" data-attachment-remove="${esc(file)}" data-attachment-input="${id}" title="Remove attachment" aria-label="Remove attachment">${icon("x")}</button></span>`).join("")}</div></div>`;
  else if (field.type === "longtext") input = html`<textarea ${attr} rows="3" maxlength="${field.maxLength ?? 5000}">${esc(value ?? "")}</textarea>`;
  else if (field.type === "select") input = html`<select ${attr}><option value="">Select an option</option>${field.options.map((option) => html`<option value="${esc(option)}"${value === option ? " selected" : ""}>${esc(option)}</option>`).join("")}</select>`;
  else if (field.type === "reference") {
    const table = catalog.find((table) => table.id === field.reference?.formId);
    const key = table?.fields.find((key) => key.id === field.reference.fieldId);
    input = html`<select ${attr}><option value="">Select a record</option>${(table?.records || []).filter((record) => record.values[key?.id] != null && record.values[key?.id] !== "").map((record) => html`<option value="${record.id}"${value === record.id ? " selected" : ""}>${esc(scalarDisplay(key, record.values[key.id]))}</option>`).join("")}</select>`;
  } else if (field.type === "checkbox") input = html`<select ${attr}><option value=""${value == null ? " selected" : ""}>Not set</option><option value="true"${value === true ? " selected" : ""}>Yes</option><option value="false"${value === false ? " selected" : ""}>No</option></select>`;
  else input = html`<input ${attr} type="${field.type === "datetime" ? "datetime-local" : field.type}" value="${esc(value ?? "")}" ${field.type === "number" ? 'step="any" min="-1000000000000000" max="1000000000000000"' : field.type === "text" ? `maxlength="${field.maxLength ?? 1000}"` : field.type === "datetime" ? 'min="1900-01-01T00:00" max="9999-12-31T23:59"' : 'min="1900-01-01" max="9999-12-31"'} autocomplete="off">`;
  return html`<div class="input-field"><div class="label-row"><label for="${id}">${esc(field.name)}${field.required ? html`<span class="required-dot">*</span>` : ""}</label>${field.unique ? html`<span class="label-note">${icon("key-round")} Unique</span>` : ""}</div><div class="input-wrap">${input}</div><small class="field-error" id="${prefix}-error-${field.id}" hidden></small></div>`;
}

export function renderFieldCell(field, value, { catalog, primary, recordId }) {
  const text = fieldDisplay(field, value, catalog);
  const empty = value === null || value === undefined || value === "";
  if (field.type === "attachment" && Array.isArray(value)) return html`<span class="attachment-links">${value.map((id, index) => html`<a href="/api/attachments/${encodeURIComponent(id)}" target="_blank" rel="noopener" title="Download attachment ${index + 1}">${icon("paperclip")}<span>${index + 1}</span></a>`).join("") || html`<span class="muted">-</span>`}</span>`;
  if (field.type === "reference" && !empty) {
    const spaceId = catalog.find(table => table.id === field.reference.formId)?.spaceId;
    const params = new URLSearchParams({ formId: field.reference.formId, recordId: value });
    if (spaceId) params.set("spaceId", spaceId);
    return html`<a class="reference-link" href="?${params}#records" data-reference title="Open ${esc(text)}">${icon("link-2")}<span>${esc(text)}</span></a>`;
  }
  if (primary) return html`<button class="record-title" data-edit="${recordId}" title="${esc(text)}">${esc(text)}</button>`;
  if (field.type === "select" && !empty) return html`<span class="option-pill" title="${esc(text)}">${esc(text)}</span>`;
  if (field.type === "checkbox" && !empty) return html`<span class="boolean-value ${value ? "is-true" : ""}">${icon(value ? "circle-check" : "circle-minus")}${uiText(value ? "Yes" : "No")}</span>`;
  if (empty) return html`<span class="cell-value muted" title="Not set">Not set</span>`;
  return html`<span class="cell-value${empty ? " muted" : ""}${field.type === "number" ? " numeric" : ""}" title="${esc(text)}">${esc(text)}</span>`;
}
