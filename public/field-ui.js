import { displayValue as scalarDisplay } from "/field-types.js";

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const icon = (name) => `<i data-lucide="${esc(name)}" aria-hidden="true"></i>`;

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
  if (field.type === "longtext") input = `<textarea ${attr} rows="3" maxlength="5000">${esc(value ?? "")}</textarea>`;
  else if (field.type === "select") input = `<select ${attr}><option value="">Select an option</option>${field.options.map((option) => `<option value="${esc(option)}"${value === option ? " selected" : ""}>${esc(option)}</option>`).join("")}</select>`;
  else if (field.type === "reference") {
    const table = catalog.find((table) => table.id === field.reference?.formId);
    const key = table?.fields.find((key) => key.id === field.reference.fieldId);
    input = `<select ${attr}><option value="">Select a record</option>${(table?.records || []).filter((record) => record.values[key?.id] != null && record.values[key?.id] !== "").map((record) => `<option value="${record.id}"${value === record.id ? " selected" : ""}>${esc(scalarDisplay(key, record.values[key.id]))}</option>`).join("")}</select>`;
  } else if (field.type === "checkbox") input = `<label class="record-checkbox"><input type="checkbox" ${attr} aria-label="${esc(field.name)}" ${value === true ? "checked" : ""}><span>${esc(field.name)}</span></label>`;
  else input = `<input ${attr} type="${field.type === "datetime" ? "datetime-local" : field.type}" value="${esc(value ?? "")}" ${field.type === "number" ? 'step="any" min="-1000000000000000" max="1000000000000000"' : field.type === "text" ? 'maxlength="1000"' : field.type === "datetime" ? 'min="1900-01-01T00:00" max="9999-12-31T23:59"' : 'min="1900-01-01" max="9999-12-31"'} autocomplete="off">`;
  return `<div class="input-field"><div class="label-row"><label for="${id}">${esc(field.name)}${field.required ? '<span class="required-dot">*</span>' : ""}</label>${field.unique ? `<span class="label-note">${icon("key-round")} Unique</span>` : ""}</div><div class="input-wrap">${input}</div><small class="field-error" id="${prefix}-error-${field.id}" hidden></small></div>`;
}

export function renderFieldCell(field, value, { catalog, primary, recordId }) {
  const text = fieldDisplay(field, value, catalog);
  const empty = value === null || value === undefined || value === "";
  if (field.type === "reference" && !empty) {
    return `<a class="reference-link" href="?formId=${encodeURIComponent(field.reference.formId)}&recordId=${encodeURIComponent(value)}#records" data-reference title="Open ${esc(text)}">${icon("link-2")}<span>${esc(text)}</span></a>`;
  }
  if (primary) return `<button class="record-title" data-edit="${recordId}" title="${esc(text)}">${esc(text)}</button>`;
  if (field.type === "select" && !empty) return `<span class="option-pill" title="${esc(text)}">${esc(text)}</span>`;
  if (field.type === "checkbox" && !empty) return `<span class="boolean-value ${value ? "is-true" : ""}">${icon(value ? "circle-check" : "circle-minus")}${esc(text)}</span>`;
  return `<span class="cell-value${empty ? " muted" : ""}${field.type === "number" ? " numeric" : ""}" title="${esc(text)}">${esc(text)}</span>`;
}
