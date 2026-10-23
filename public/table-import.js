import { html, uiText, setUIText, uiAttributes, t } from "/i18n.js";
import { FIELD_DEFINITIONS, validDate } from "/field-types.js";

export async function encodeFile(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < data.length; offset += 32768) binary += String.fromCharCode(...data.subarray(offset, offset + 32768));
  return { name: file.name, data: btoa(binary) };
}

export function initTableImport({ api, icons, toast, getState, onImported }) {
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const dialog = document.createElement("dialog");
  dialog.className = "modal import-dialog";
  dialog.setAttribute("aria-labelledby", "spreadsheet-title");
  dialog.innerHTML = html`
    <div class="modal-heading"><div><span class="eyebrow">DATA IMPORT</span><h2 id="spreadsheet-title">Import spreadsheet</h2></div><button class="icon-button" id="spreadsheet-close" title="Close import" aria-label="Close import"><i data-lucide="x"></i></button></div>
    <div id="spreadsheet-setup">
      <div class="workflow-grid import-top">
        <label class="input-field"><span class="builder-label">File</span><span class="file-picker"><i data-lucide="file-up"></i><span id="spreadsheet-filename">Choose XLSX or CSV</span><input type="file" id="spreadsheet-file" accept=".xlsx,.csv" class="sr-only"></span></label>
        <label class="input-field"><span class="builder-label">Worksheet</span><select id="spreadsheet-sheet" class="standalone-input" disabled></select></label>
        <label class="input-field"><span class="builder-label">Header row</span><input type="number" id="spreadsheet-header" class="standalone-input" min="1" max="100" value="1" disabled></label>
      </div>
      <div class="workflow-segment" role="group" aria-label="Import destination"><button data-import-mode="existing" aria-pressed="true">Existing table</button><button data-import-mode="new" aria-pressed="false">New table</button></div>
      <div id="spreadsheet-existing"><label class="input-field"><span class="builder-label">Destination table</span><select id="spreadsheet-target" class="standalone-input"></select></label></div>
      <div id="spreadsheet-new" class="workflow-grid" hidden><label class="input-field"><span class="builder-label">Table name</span><input id="spreadsheet-name" class="standalone-input" maxlength="80"></label><label class="input-field"><span class="builder-label">Parent node</span><select id="spreadsheet-module" class="standalone-input"></select></label></div>
      <div class="section-heading"><h3>Column mapping</h3><span id="spreadsheet-count" class="section-count"></span></div><div id="spreadsheet-mapping" class="mapping-list"></div>
    </div>
    <div id="spreadsheet-preview" hidden></div><div id="spreadsheet-error" class="form-error" role="alert" hidden></div>
    <div class="modal-actions"><button class="button button-secondary" id="spreadsheet-back" hidden><i data-lucide="arrow-left"></i><span>Back</span></button><button class="button button-primary" id="spreadsheet-preview-button" disabled><i data-lucide="eye"></i><span>Preview import</span></button><button class="button button-primary" id="spreadsheet-commit" hidden><i data-lucide="check"></i><span>Confirm import</span></button></div>`;
  document.body.append(dialog);
  const $ = (id) => dialog.querySelector(`#spreadsheet-${id}`);
  let parsed, mode = "existing", busy = false, preview, newFields = [], generation = 0;
  const error = (message = "") => { $("error").hidden = !message; setUIText($("error"), message); };
  const source = () => parsed?.sheets[Number($("sheet").value || 0)];
  const headerIndex = () => Number($("header").value) - 1;
  const headers = () => (source()?.rows[headerIndex()] || []).map((value, index) => String(value ?? "").trim() || `Column ${index + 1}`);
  const rows = () => (source()?.rows.slice(headerIndex() + 1) || []).filter((row) => row.some((value) => value !== null && value !== ""));
  const inferredType = (values) => {
    const present = values.filter((value) => value !== null && value !== "");
    if (!present.length) return "text";
    if (present.every((value) => typeof value === "boolean")) return "checkbox";
    if (present.every((value) => typeof value === "number")) return "number";
    if (present.every((value) => typeof value === "string" && validDate(value))) return "date";
    if (present.every((value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value))) return "datetime";
    return "text";
  };
  function rebuildFields() {
    const names = new Set();
    newFields = headers().map((name, index) => {
      let uniqueName = name.slice(0, 64), number = 2;
      while (names.has(uniqueName.toLowerCase())) uniqueName = `${name.slice(0, 58)} ${number++}`;
      names.add(uniqueName.toLowerCase());
      return { id: `fld_${crypto.randomUUID()}`, name: uniqueName, type: inferredType(rows().map((row) => row[index])), required: false, unique: false, options: [], column: index, included: true };
    });
  }
  function referenceOptions() {
    return getState().references.flatMap((table) => table.fields.map((field) =>
      html`<option value="${table.id}|${field.id}">${esc(table.name)} / ${esc(field.name)}</option>`)).join("");
  }
  function renderMapping() {
    const data = getState();
    $("new").hidden = mode !== "new"; $("existing").hidden = mode !== "existing";
    dialog.querySelectorAll("[data-import-mode]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.importMode === mode)));
    setUIText($("count"), parsed ? `${rows().length} rows` : "");
    if (!parsed) { $("mapping").innerHTML = ""; return; }
    const columns = headers();
    if (mode === "existing") {
      const form = data.forms.find((form) => form.id === $("target").value);
      $("mapping").innerHTML = (form?.fields || []).filter((field) => !field.formula && field.type !== "attachment").map((field) => {
        const match = columns.findIndex((header) => header.toLowerCase().replace(/[\s_-]/g, "") === field.name.toLowerCase().replace(/[\s_-]/g, "") ||
          header.toLowerCase() === field.id.toLowerCase());
        return html`<label class="mapping-row"><span><strong>${esc(field.name)}${field.required ? " *" : ""}</strong><small>${uiText(FIELD_DEFINITIONS[field.type].label)}</small></span><select class="standalone-input" data-map="${field.id}" aria-label="Source column for ${esc(field.name)}"><option value="">Not mapped</option>${columns.map((header, index) => html`<option value="${index}"${index === match ? " selected" : ""}>${esc(header)}</option>`).join("")}</select></label>`;
      }).join("");
    } else {
      $("mapping").innerHTML = newFields.map((field, index) => html`<div class="import-field" data-import-field="${index}">
        <div class="import-field-main"><input type="checkbox" data-prop="included" ${field.included ? "checked" : ""} aria-label="Include column ${index + 1}"><input class="standalone-input" data-prop="name" value="${esc(field.name)}" maxlength="64" aria-label="Column ${index + 1} field name"><select class="standalone-input" data-prop="type" aria-label="Column ${index + 1} field type">${Object.entries(FIELD_DEFINITIONS).map(([type, info]) => html`<option value="${type}"${type === field.type ? " selected" : ""}>${uiText(info.label)}</option>`).join("")}</select><label class="rule-control"><input type="checkbox" data-prop="required"${field.required ? " checked" : ""}>Required</label><label class="rule-control"><input type="checkbox" data-prop="unique"${field.unique ? " checked" : ""}>Unique</label></div>
        ${field.type === "reference" ? html`<select class="standalone-input import-extra" data-prop="reference" aria-label="Reference target for column ${index + 1}"><option value="">Choose unique target field</option>${referenceOptions()}</select>` : ""}
        ${field.type === "select" ? html`<textarea class="meeting-text import-extra" data-prop="options" rows="3" aria-label="Dropdown options for column ${index + 1}">${esc(field.options.join("\n"))}</textarea>` : ""}
      </div>`).join("");
      newFields.forEach((field, index) => {
        const select = dialog.querySelector(`[data-import-field="${index}"] [data-prop="reference"]`);
        if (select && field.reference) select.value = `${field.reference.formId}|${field.reference.fieldId}`;
      });
    }
    icons();
  }
  function lock(value) {
    busy = value;
    dialog.querySelectorAll("button,input,select,textarea").forEach((node) => { node.disabled = value; });
    if (!value && !parsed) { $("preview-button").disabled = true; $("sheet").disabled = true; $("header").disabled = true; }
  }
  function editMode() {
    preview = null;
    $("setup").hidden = false; $("preview").hidden = true; $("preview-button").hidden = false;
    $("commit").hidden = true; $("back").hidden = true;
  }
  $("close").onclick = () => { if (!busy) dialog.close(); };
  dialog.addEventListener("cancel", (event) => { if (busy) event.preventDefault(); });
  $("file").onchange = async () => {
    const request = generation;
    const file = $("file").files[0];
    parsed = null; editMode(); error(); renderMapping();
    if (!file) return;
    delete $("filename").dataset.i18nText;
    $("filename").textContent = file.name;
    if (file.size > 5 * 1024 * 1024) return error("Choose an XLSX or CSV file up to 5 MB.");
    lock(true);
    try {
      const encoded = await encodeFile(file);
      if (request !== generation) return;
      const result = await api("/api/imports/parse", { method: "POST", body: JSON.stringify({ file: encoded }) });
      if (request !== generation) return;
      parsed = result;
      $("sheet").innerHTML = parsed.sheets.map((sheet, index) => html`<option value="${index}">${esc(sheet.name)}</option>`).join("");
      $("header").value = "1";
      if (!$("name").value) $("name").value = file.name.replace(/\.[^.]+$/, "").slice(0, 80);
      rebuildFields(); renderMapping();
    } catch (err) { if (request === generation) error(err.message); }
    finally { if (request === generation) lock(false); }
  };
  for (const id of ["sheet", "header"]) $(id).addEventListener("change", () => {
    if (!Number.isInteger(headerIndex()) || headerIndex() < 0 || headerIndex() >= (source()?.rows.length || 0) || headerIndex() > 99) {
      $("preview-button").disabled = true; return error("Choose an existing header row from 1-100.");
    }
    $("preview-button").disabled = false; error(); rebuildFields(); renderMapping();
  });
  $("target").onchange = renderMapping;
  dialog.querySelectorAll("[data-import-mode]").forEach((button) => { button.onclick = () => { mode = button.dataset.importMode; renderMapping(); }; });
  $("mapping").addEventListener("input", (event) => {
    const node = event.target.closest("[data-prop]"), row = node?.closest("[data-import-field]");
    if (!row) return;
    const field = newFields[Number(row.dataset.importField)], prop = node.dataset.prop;
    if (["included", "required", "unique"].includes(prop)) field[prop] = node.checked;
    else if (prop === "options") field.options = node.value.split(/\r?\n/).filter((value) => value.trim());
    else if (prop === "reference") { const [formId, fieldId] = node.value.split("|"); field.reference = { formId, fieldId }; }
    else field[prop] = node.value;
    if (prop === "type") {
      field.options = field.type === "select" ? [...new Set(rows().map((row) => row[field.column]).filter((value) => value != null && value !== "").map(String))].slice(0, 50) : [];
      if (field.type !== "reference") delete field.reference;
      renderMapping();
    }
  });
  $("preview-button").onclick = async () => {
    if (busy || !parsed) return;
    const request = generation;
    lock(true); error();
    try {
      const data = getState(), mapping = {};
      let target;
      if (mode === "existing") {
        const form = data.forms.find((form) => form.id === $("target").value);
        if (!form) throw new Error("Choose a destination table.");
        dialog.querySelectorAll("[data-map]").forEach((select) => { if (select.value !== "") mapping[select.dataset.map] = Number(select.value); });
        target = { formId: form.id, schemaVersion: form.version };
      } else {
        const fields = newFields.filter((field) => field.included).map(({ included, column, ...field }) => { mapping[field.id] = column; return field; });
        target = { name: $("name").value, spaceId: data.space.id, parentId: $("module").value || null, fields };
      }
      const result = await api("/api/imports/preview", { method: "POST", body: JSON.stringify({ ...target, rows: rows(), mapping, fileName: parsed.name, sheetName: source().name }) });
      if (request !== generation) return;
      preview = result;
      $("setup").hidden = true; $("preview").hidden = false; $("preview-button").hidden = true; $("back").hidden = false;
      $("commit").hidden = false;
      const errors = new Map(preview.errors.map((entry) => [entry.row, entry]));
      $("preview").innerHTML = html`<div class="import-summary"><strong>${esc(preview.form.name)}</strong><span class="status-badge ${preview.errors.length ? "status-warning" : "status-success"}">${preview.validCount} ready / ${preview.rows.length} rows</span></div>
        ${preview.errors.length ? html`<div class="form-error" role="alert"><strong>${preview.errors.length} rows need correction</strong><ul>${preview.errors.slice(0, 50).map((entry) => html`<li>Row ${entry.row + headerIndex() + 1}: ${esc(entry.message || Object.entries(entry.fields).map(([id, message]) => `${preview.form.fields.find((field) => field.id === id)?.name || id}: ${message}`).join(" "))}</li>`).join("")}</ul>${preview.errors.length > 50 ? html`<p>First 50 errors shown.</p>` : ""}</div>` : ""}
        <div class="table-clip import-preview-table"><table class="data-table"><thead><tr><th>Row</th>${preview.form.fields.map((field) => html`<th>${esc(field.name)}</th>`).join("")}</tr></thead><tbody>${preview.rows.slice(0, 25).map((row, index) => html`<tr${errors.has(index + 1) ? ' class="import-row-error"' : ""}><td>${index + headerIndex() + 2}</td>${preview.form.fields.map((field) => {
          const value = row[field.id];
          const table = field.reference && data.references.find((table) => table.id === field.reference.formId);
          const display = table?.records.find((record) => record.id === value)?.values[field.reference.fieldId] ?? value;
          return html`<td><span class="cell-value">${esc(display ?? "")}</span></td>`;
        }).join("")}</tr>`).join("")}</tbody></table></div>${preview.rows.length > 25 ? html`<p class="workflow-footnote">First 25 rows shown.</p>` : ""}${preview.effects?.length ? html`<details class="assistant-schema"><summary>All changes, including automations (${preview.effects.length})</summary><pre>${esc(JSON.stringify(preview.effects, null, 2))}</pre></details>` : ""}`;
    } catch (err) { if (request === generation) error(err.message); }
    finally { if (request === generation) { lock(false); if (preview) $("commit").disabled = preview.errors.length > 0; icons(); } }
  };
  $("back").onclick = () => { editMode(); error(); };
  $("commit").onclick = async () => {
    if (!preview || busy || preview.errors.length) return;
    const request = generation;
    lock(true); error();
    try {
      const result = await api(`/api/imports/${preview.id}/commit`, { method: "POST", body: "{}" });
      if (request !== generation) return;
      dialog.close();
      await onImported(result.formId);
      if (request !== generation) return;
      toast(`${result.recordIds.length} records imported.`);
    } catch (err) { if (request === generation) error(err.message); }
    finally { if (request === generation) lock(false); }
  };
  return {
    open() {
      if (busy) return;
      const data = getState();
      if (!data.user || !data.permissions?.manageForms) return;
      generation++;
      parsed = null; preview = null; mode = "existing"; newFields = []; $("file").value = ""; $("name").value = "";
      setUIText($("filename"), "Choose XLSX or CSV");
      $("target").innerHTML = data.forms.map((form) => html`<option value="${form.id}">${esc(form.name)}</option>`).join("");
      $("target").value = data.form.id;
      $("module").innerHTML = html`<option value="">Space root</option>` + (data.navigation ?? []).filter((node) => node.kind === "node").map((node) => html`<option value="${node.id}">${esc(node.name)}</option>`).join("");
      $("module").value = data.navigation?.find((node) => node.formId === data.form.id)?.parentId ?? "";
      $("sheet").innerHTML = ""; $("header").value = "1";
      editMode(); error(); renderMapping(); lock(false); dialog.showModal(); icons();
    },
    reset() {
      generation++;
      parsed = null; preview = null; newFields = []; mode = "existing";
      if (dialog.open) dialog.close();
      $("file").value = ""; $("name").value = ""; $("header").value = "1";
      for (const id of ["sheet", "target", "module", "mapping", "preview"]) $(id).replaceChildren();
      setUIText($("filename"), "Choose XLSX or CSV");
      editMode(); error(); lock(false);
    },
  };
}
