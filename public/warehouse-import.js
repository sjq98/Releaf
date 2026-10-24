import { html, uiText, uiAttributes, setUIText } from "/i18n.js";
import { fieldDisplay } from "/field-ui.js";

const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const readSpreadsheet = file => new Promise((resolve, reject) => {
  if (!file || file.size > 5 * 1024 * 1024 || !/\.(xlsx|csv)$/i.test(file.name)) return reject(new Error("Choose an XLSX or UTF-8 CSV file up to 5 MB."));
  const reader = new FileReader();
  reader.onload = () => resolve({ name: file.name, data: String(reader.result).split(",")[1] });
  reader.onerror = () => reject(new Error("Could not read the file."));
  reader.readAsDataURL(file);
});

export function initWarehouseImport({ api, icons, toast, getState, onCompleted }) {
  const dialog = document.createElement("dialog");
  dialog.id = "warehouse-import-dialog"; dialog.className = "modal warehouse-dialog";
  document.body.append(dialog);
  let state, busy = false, generation = 0;
  const $ = id => dialog.querySelector(`#wi-${id}`);
  const input = (name, label, value = "") => html`<label class="input-field"><span>${uiText(label)}</span><input id="wi-${name}" value="${esc(value)}"></label>`;
  function payload() {
    if (state.linesOnly) return { fileId: state.file.id, sheetIndex: state.sheetIndex, mapping: state.mapping, kind: state.kind, values: state.values, linesOnly: true };
    const values = {};
    for (const key of ["warehouse", "applicant", "approver"]) if ($(key).value.trim()) values[key] = $(key).value.trim();
    return { fileId: state.file.id, sheetIndex: state.sheetIndex, mapping: state.mapping,
      ...($("kind").value ? { kind: $("kind").value } : {}), values, stage: $("stage").value,
      ...($("actor").value.trim() ? { actor: $("actor").value.trim() } : {}),
      ...($("approvalActor").value.trim() ? { approvalActor: $("approvalActor").value.trim() } : {}) };
  }
  function invalidate() {
    state.preview = null; $("apply").hidden = true; $("result").replaceChildren();
  }
  function renderMapping() {
    const headers = state.file?.sheets[state.sheetIndex]?.headers ?? [];
    const sections = [["lines", "Detail fields"], ["request", "Request fields"], ["matching", "Product and warehouse matching"]];
    $("mapping").innerHTML = headers.length ? html`<details open><summary>Column matching</summary>${sections.map(([section, label]) => {
      const fields = state.mappingFields.filter(field => field.section === section);
      return html`<fieldset class="warehouse-mapping-section"><legend>${uiText(label)}</legend><div class="warehouse-import-mapping">${fields.map(field => {
        const { key, managed } = field;
        const hint = key === "group" ? "External number for grouping only; the workflow creates its own request number."
          : key === "applicant" ? "The signed-in account remains the applicant."
              : field.reason === "Upload separately" ? "Upload attachments in the request."
                : managed ? "Automatically maintained by the workflow." : null;
        return html`<label class="input-field${managed ? " warehouse-mapping-managed" : ""}" data-wi-field="${esc(key)}"><span class="warehouse-mapping-label">${field.uiLabel ? uiText(field.name) : esc(field.name)}${field.reason ? html`<small class="warehouse-mapping-tag" ${uiAttributes(hint ?? field.reason)}>${uiText(field.reason)}</small>` : ""}</span><select data-wi-map="${esc(key)}" aria-label="${esc(field.name)}" ${managed ? "disabled" : ""}><option value="">${uiText(managed ? field.reason : "Not mapped")}</option>${headers.map((h, i) => html`<option value="${i}" ${state.mapping?.[key] === i ? "selected" : ""}>${esc(h || `Column ${i + 1}`)}</option>`).join("")}</select></label>`;
      }).join("")}</div></fieldset>`;
    }).join("")}</details>` : "";
  }
  function renderResult(result) {
    const errors = result.errors ?? [];
    const unmapped = result.warnings?.filter(warning => !warning.message) ?? [];
    const notices = result.warnings?.filter(warning => warning.message) ?? [];
    $("result").innerHTML = html`${errors.length ? html`<div class="form-error"><strong>Import errors</strong><ul>${errors.map(e => html`<li>${e.row ? `${uiText("Row")} ${e.row}: ` : ""}${uiText(e.message)}</li>`).join("")}</ul></div>` : ""}${notices.map(warning => html`<p class="warehouse-mapping-hint" role="status">${uiText(warning.message)}</p>`).join("")}${unmapped.length ? html`<details><summary>Unmapped columns</summary><p>${unmapped.map(w => esc(w.header)).join(", ")}</p></details>` : ""}<div class="section-heading"><h3>Matched products</h3><span>${esc(result.rowCount)} ${uiText("rows")} · ${esc(result.documents?.length ?? 0)} ${uiText("requests")}</span></div><div class="table-clip warehouse-import-results"><table class="data-table"><thead><tr><th>Row</th><th>Product code</th><th>Product</th><th>Quantity</th><th>Unit</th></tr></thead><tbody>${result.matchedRows.map(row => html`<tr><td>${row.row}</td><td>${esc(row.code)}</td><td>${esc(row.name)}</td><td>${esc(row.quantity)}</td><td>${esc(row.unit)}</td></tr>`).join("")}</tbody></table></div>${result.alreadySaved ? html`<p>This batch has already been processed.</p>` : ""}`;
    if (state.linesOnly && result.requestValues && Object.keys(result.requestValues).length) {
      const values = result.requestValues, { warehouse, references } = getState();
      const fields = state.mappingFields.filter(field => field.section === "request" && Object.hasOwn(values, field.fieldId) && !field.managed);
      $("result").insertAdjacentHTML("beforeend", html`<div class="section-heading"><h3>Request fields to apply</h3></div><dl class="warehouse-import-header-preview">${fields.map(field => html`<div><dt>${esc(field.name)}</dt><dd>${esc(field.fieldId === "warehouse" ? warehouse.warehouses.find(item => item.id === values.warehouse)?.values.name : fieldDisplay(field, values[field.fieldId], references ?? []))}</dd></div>`).join("")}</dl>`);
    }
    if (!state.linesOnly && result.documents?.length) {
      const warehouse = getState().warehouse;
      $("result").insertAdjacentHTML("beforeend", html`<div class="section-heading"><h3>Requests</h3><span>${uiText({ draft: "Save drafts", submit: "Submit for approval", post: "Approve and post" }[state.args.stage])}</span></div><div class="table-clip"><table class="data-table"><thead><tr><th>Direction</th><th>Warehouse</th><th>Applicant</th><th>Approver</th><th>Product lines</th></tr></thead><tbody>${result.documents.map(doc => html`<tr><td>${uiText(doc.kind === "inbound" ? "In" : "Out")}</td><td>${esc(warehouse.warehouses.find(row => row.id === doc.values.warehouse)?.values.name)}</td><td>${esc(doc.values.applicant)}</td><td>${esc(doc.values.approver)}</td><td>${doc.lines.length}</td></tr>`).join("")}</tbody></table></div>`);
      const balances = new Map();
      for (const change of (result.changes ?? []).filter(c => c.formId === warehouse.tables.stock)) {
        const prior = balances.get(change.recordId);
        balances.set(change.recordId, { name: change.after?.name ?? change.before?.name, warehouse: change.after?.warehouse ?? change.before?.warehouse, before: prior?.before ?? change.before?.currentQuantity ?? 0, after: change.after?.currentQuantity ?? 0 });
      }
      if (balances.size) $("result").insertAdjacentHTML("beforeend", html`<div class="section-heading"><h3>Stock movements</h3></div><div class="table-clip"><table class="data-table"><thead><tr><th>Product</th><th>Warehouse</th><th>Before</th><th>After</th></tr></thead><tbody>${[...balances.values()].map(row => html`<tr><td>${esc(row.name)}</td><td>${esc(warehouse.warehouses.find(w => w.id === row.warehouse)?.values.name)}</td><td>${esc(row.before)}</td><td>${esc(row.after)}</td></tr>`).join("")}</tbody></table></div>`);
    }
    $("apply").hidden = Boolean(errors.length || result.alreadySaved);
    icons();
  }
  async function matchColumns() {
    const request = generation;
    const result = await api("/api/warehouse/imports/match", { method: "POST", body: JSON.stringify({ fileId: state.file.id, sheetIndex: state.sheetIndex, ...(state.kind ? { kind: state.kind } : {}), linesOnly: true }) });
    if (request !== generation) return;
    state.mapping = result.mapping; state.mappingFields = result.mappingFields; renderMapping();
  }
  function open(options = {}) {
    generation++;
    state = { linesOnly: Boolean(options.onLines), onLines: options.onLines, kind: options.kind, values: options.values ?? {}, file: null, sheetIndex: 0, mapping: {}, mappingFields: [], preview: null };
    const warehouses = getState().warehouse.warehouses;
    dialog.innerHTML = html`<div class="modal-heading"><h2>${uiText(state.linesOnly ? "Import product lines" : "Import warehouse requests")}</h2><button type="button" class="icon-button" id="wi-close" ${uiAttributes("Close")}><i data-lucide="x"></i></button></div><div class="warehouse-import-source"><label class="input-field"><span>Spreadsheet</span><span class="file-picker warehouse-file-picker"><i data-lucide="file-up"></i><span>Choose file</span><span id="wi-filename" class="warehouse-file-name" role="status">${uiText("No file selected")}</span><input type="file" id="wi-file" accept=".xlsx,.csv" class="sr-only" aria-label="Choose file"></span></label><label class="input-field"><span>Worksheet</span><select id="wi-sheet" disabled></select></label></div>${state.linesOnly ? "" : html`<div class="warehouse-header-fields"><label class="input-field"><span>Direction</span><select id="wi-kind"><option value="">From spreadsheet</option><option value="inbound">Inbound workflow</option><option value="outbound">Outbound workflow</option></select></label><label class="input-field"><span>Warehouse</span><select id="wi-warehouse"><option value="">From spreadsheet</option>${warehouses.map(w => html`<option value="${w.id}">${esc(w.values.name)}</option>`).join("")}</select></label>${input("applicant", "Applicant")}${input("approver", "Approver")}<label class="input-field"><span>Execution stage</span><select id="wi-stage"><option value="draft">Save drafts</option><option value="submit" selected>Submit for approval</option><option value="post">Approve and post</option></select></label>${input("actor", "Operator")}<div id="wi-approval-field" hidden>${input("approvalActor", "Approval operator")}</div></div>`}<div id="wi-mapping"></div><div id="wi-error" class="form-error" role="alert" hidden></div><div id="wi-result"></div><div class="modal-actions"><button type="button" class="button button-secondary" id="wi-preview" disabled><i data-lucide="scan-line"></i><span>Preview changes</span></button><button type="button" class="button button-primary" id="wi-apply" hidden><i data-lucide="check"></i><span>${uiText(state.linesOnly ? "Replace product lines" : "Run workflows")}</span></button></div>`;
    dialog.showModal(); icons();
  }
  async function working(fn) {
    if (busy) return;
    const request = generation;
    busy = true; dialog.setAttribute("aria-busy", "true"); $("error").hidden = true;
    const nodes = [...dialog.querySelectorAll("button,input,select")].map(node => [node, node.disabled]);
    for (const [node] of nodes) node.disabled = true;
    try { await fn(); }
    catch (error) { if (request === generation) { setUIText($("error"), error.message); $("error").hidden = false; } }
    finally { if (request === generation) { busy = false; dialog.removeAttribute("aria-busy"); for (const [node, disabled] of nodes) if (node.isConnected) node.disabled = disabled; $("preview").disabled = !state.file; $("sheet").disabled = !state.file; } }
  }
  dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
  dialog.addEventListener("input", event => {
    if (busy || event.target.id === "wi-file") return;
    invalidate();
    if (event.target.dataset.wiMap) state.mapping[event.target.dataset.wiMap] = event.target.value === "" ? null : Number(event.target.value);
    if (event.target.id === "wi-stage") $("approval-field").hidden = event.target.value !== "post";
  });
  dialog.addEventListener("change", event => {
    if (event.target.id === "wi-file" && event.target.files[0]) {
      $("filename").textContent = event.target.files[0].name;
      working(async () => {
        const request = generation;
        invalidate(); state.file = null; state.mapping = {}; state.mappingFields = []; renderMapping();
        const file = await readSpreadsheet(event.target.files[0]);
        if (request !== generation) return;
        const uploaded = await api("/api/warehouse/files", { method: "POST", body: JSON.stringify({ spaceId: getState().space.id, file }) });
        if (request !== generation) return;
        state.file = uploaded;
        state.sheetIndex = 0;
        $("sheet").innerHTML = state.file.sheets.map((s, i) => html`<option value="${i}">${esc(s.name)} (${s.rowCount})</option>`).join("");
        await matchColumns();
      });
    }
    if (event.target.id === "wi-sheet") working(async () => { invalidate(); state.sheetIndex = Number(event.target.value); await matchColumns(); });
  });
  dialog.addEventListener("click", event => {
    const id = event.target.closest("button")?.id;
    if (id === "wi-close" && !busy) dialog.close();
    if (id === "wi-preview") working(async () => {
      const request = generation;
      state.args = payload();
      const preview = await api(`/api/warehouse/imports/${state.linesOnly ? "match" : "preview"}`, { method: "POST", body: JSON.stringify(state.args) });
      if (request !== generation) return;
      state.preview = preview;
      renderResult(state.preview);
    });
    if (id === "wi-apply" && state.preview) working(async () => {
      const request = generation;
      if (state.linesOnly) {
        await state.onLines(state.preview.documents.flatMap(doc => doc.lines), state.preview.requestValues);
        if (request === generation) dialog.close();
      } else {
        const result = await api("/api/warehouse/imports/execute", { method: "POST", body: JSON.stringify({ ...state.args, fingerprint: state.preview.fingerprint }) });
        if (request !== generation) return;
        await onCompleted();
        if (request !== generation) return;
        $("result").innerHTML = html`<div class="section-heading"><h3>Workflow results</h3></div><ul>${result.documents.map(doc => html`<li>${esc(doc.number)} · ${uiText(doc.status)}</li>`).join("")}</ul>`;
        $("apply").hidden = true; state.preview = null; toast("Workflows completed.");
      }
    });
  });
  function reset() {
    generation++; state = undefined; busy = false;
    if (dialog.open) dialog.close();
    dialog.removeAttribute("aria-busy"); dialog.replaceChildren();
  }
  return { open, reset };
}
