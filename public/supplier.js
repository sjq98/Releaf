import { inputValue } from "/field-types.js";
import { renderFieldInput } from "/field-ui.js";
import { encodeFile } from "/table-import.js";

export function initSupplier({ api, icons, toast, getState, refresh, openAISettings }) {
  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const types = ["Delivery note", "Invoice", "Statement"];
  $("view-document").innerHTML = `
    <div class="page-heading"><div><div class="eyebrow">SUPPLIER RECONCILIATION</div><h1>Document recognition</h1></div><button class="icon-button toolbar-icon" data-ai-settings title="AI settings" aria-label="AI settings"><i data-lucide="sliders-horizontal"></i></button></div>
    <form id="supplier-recognition-form" class="workflow-editor">
      <div class="workflow-file-row"><label class="input-field"><span class="builder-label">Supplier document</span><span class="file-picker"><i data-lucide="file-up"></i><span id="supplier-filename">Choose PDF or image</span><input type="file" id="supplier-file" accept=".pdf,.jpg,.jpeg,.png" class="sr-only" required></span></label><span id="supplier-file-state" class="section-count" role="status"></span><button class="button button-primary" id="supplier-extract" disabled><i data-lucide="scan-text"></i><span>Recognize document</span></button></div>
      <p class="privacy-note workflow-footnote">Document images and reference identifiers are sent to the configured AI provider.</p>
      <div id="supplier-pages" class="document-pages" hidden></div>
    </form>
    <div id="supplier-error" class="form-error" role="alert" hidden></div>
    <section id="supplier-review" hidden><div class="section-heading"><div><h2>Review document lines</h2><span class="section-count" id="supplier-review-count"></span></div><button class="button button-primary" id="supplier-save"><i data-lucide="check"></i><span>Save selected</span></button></div><a id="supplier-original" class="reference-link workflow-footnote" download><i data-lucide="file-down"></i><span>Original document</span></a><div id="supplier-review-lines"></div></section>
    <section class="meeting-history"><div class="section-heading"><h2>Recent recognition</h2></div><div id="supplier-history"></div></section>`;
  $("view-document").querySelector("[data-ai-settings]").onclick = openAISettings;
  $("view-reconciliation").innerHTML = `
    <div class="page-heading"><div><div class="eyebrow">SUPPLIER RECONCILIATION</div><h1>Reconciliation results</h1></div><button class="icon-button toolbar-icon" id="reconciliation-refresh" title="Refresh reconciliation" aria-label="Refresh reconciliation"><i data-lucide="refresh-cw"></i></button></div>
    <form id="reconciliation-form" class="workflow-editor">
      <div class="workflow-grid"><label class="input-field"><span class="builder-label">Comparison name</span><input id="reconciliation-name" class="standalone-input" maxlength="120"></label><label class="input-field"><span class="builder-label">Document type</span><select id="reconciliation-type" class="standalone-input">${types.map((type) => `<option>${type}</option>`).join("")}</select></label></div>
      <div class="reconciliation-sources">${["receipts", "documents"].map((side) => `<section class="source-selection"><div class="section-heading"><h2>${side === "receipts" ? "Goods receipts" : "Supplier documents"}</h2><label class="rule-control"><input type="checkbox" id="${side}-all" checked>Select all</label></div><select id="${side}-table" class="standalone-input" aria-label="${side === "receipts" ? "Receipt" : "Supplier"} source table"></select><details class="mapping-settings"><summary>Field mapping</summary><div id="${side}-mapping" class="source-mapping"></div></details><div id="${side}-records" class="source-records"></div></section>`).join("")}</div>
      <div class="workflow-run-actions"><span id="reconciliation-scope" class="section-count"></span><button class="button button-primary" id="reconciliation-run"><i data-lucide="git-compare-arrows"></i><span>Run comparison</span></button></div>
    </form>
    <div id="reconciliation-error" class="form-error" role="alert" hidden></div>
    <section id="reconciliation-result" hidden></section>
    <section class="meeting-history"><div class="section-heading"><h2>Comparison history</h2></div><div id="reconciliation-history"></div></section>`;
  const dialog = document.createElement("dialog");
  dialog.id = "reconciliation-row-dialog"; dialog.className = "modal";
  dialog.setAttribute("aria-labelledby", "reconciliation-row-title");
  dialog.innerHTML = `<form id="reconciliation-row-form"><div class="modal-heading"><div><span class="eyebrow">DISCREPANCY</span><h2 id="reconciliation-row-title">Review result</h2></div><button type="button" class="icon-button" id="reconciliation-row-close" title="Close result" aria-label="Close result"><i data-lucide="x"></i></button></div><div class="form-fields"><div id="reconciliation-row-detail"></div><label class="input-field"><span class="builder-label">Status</span><select id="reconciliation-row-status" class="standalone-input"><option>Open</option><option>In progress</option><option>Resolved</option></select></label><label class="input-field"><span class="builder-label">Notes</span><textarea id="reconciliation-row-notes" class="meeting-text" rows="4" maxlength="2000"></textarea></label></div><div id="reconciliation-row-error" class="form-error" role="alert" hidden></div><div class="modal-actions"><button class="button button-primary" id="reconciliation-row-save"><i data-lucide="check"></i><span>Save review</span></button></div></form>`;
  document.body.append(dialog);
  const imageDialog = document.createElement("dialog");
  imageDialog.className = "modal document-preview-dialog";
  imageDialog.setAttribute("aria-label", "Document page preview");
  imageDialog.innerHTML = '<div class="modal-heading"><h2 id="document-preview-title">Document page</h2><button class="icon-button" id="document-preview-close" title="Close preview" aria-label="Close preview"><i data-lucide="x"></i></button></div><img id="document-preview-image" alt="Supplier document page">';
  document.body.append(imageDialog);
  $("document-preview-close").onclick = () => imageDialog.close();
  let file, images = [], draft, busy = false, sourceLoad = 0, currentRun, editingRow, sources = {};
  const setError = (id, message = "") => { $(id).textContent = message; $(id).hidden = !message; };
  const link = (formId, recordId, label) => `<a class="reference-link" data-reference href="?formId=${encodeURIComponent(formId)}&recordId=${encodeURIComponent(recordId)}#records"><i data-lucide="external-link"></i><span>${esc(label)}</span></a>`;
  const number = (value) => value === null || value === undefined ? "-" : new Intl.NumberFormat("en-GB", { maximumFractionDigits: 12 }).format(value);
  const date = (value) => new Date(value).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
  function lockRecognition(value) {
    busy = value;
    $("supplier-file").disabled = value;
    $("supplier-extract").disabled = value || !images.length;
    $("supplier-extract").querySelector("span").textContent = value ? "Processing..." : "Recognize document";
    $("supplier-save").disabled = value;
    $("supplier-review-lines").querySelectorAll("input,select,textarea").forEach((input) => { input.disabled = value; });
  }
  function canvasImage(canvas) {
    const image = canvas.toDataURL("image/jpeg", .78);
    if (image.length > 1800000) throw new Error("A document page is too large. Use a smaller or clearer scan.");
    return image;
  }
  async function renderFile(selected) {
    if (selected.size > 5 * 1024 * 1024) throw new Error("Choose a PDF, JPG or PNG file up to 5 MB.");
    if (/\.pdf$/i.test(selected.name)) {
      const pdfjs = await import("/vendor/pdf.mjs");
      pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.mjs";
      const task = pdfjs.getDocument({ data: new Uint8Array(await selected.arrayBuffer()), isEvalSupported: false, useSystemFonts: true, useWorkerFetch: false, isOffscreenCanvasSupported: false });
      let pdf;
      try {
        pdf = await task.promise;
        if (pdf.numPages > 6) throw new Error("Use a document with up to 6 pages. Split longer documents before uploading.");
        const pages = [];
        for (let index = 1; index <= pdf.numPages; index++) {
          $("supplier-file-state").textContent = `Reading page ${index} / ${pdf.numPages}`;
          const page = await pdf.getPage(index), initial = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: 1500 / Math.max(initial.width, initial.height) });
          const canvas = document.createElement("canvas"); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
          await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
          pages.push(canvasImage(canvas)); canvas.width = 0; canvas.height = 0; page.cleanup();
        }
        return pages;
      } finally { await task.destroy(); }
    }
    if (!/\.(?:jpe?g|png)$/i.test(selected.name)) throw new Error("Choose a PDF, JPG or PNG file.");
    const bitmap = await createImageBitmap(selected);
    try {
      const scale = Math.min(1, 1500 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas"); canvas.width = Math.ceil(bitmap.width * scale); canvas.height = Math.ceil(bitmap.height * scale);
      const context = canvas.getContext("2d"); context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return [canvasImage(canvas)];
    } finally { bitmap.close(); }
  }
  $("supplier-file").onchange = async () => {
    const selected = $("supplier-file").files[0];
    draft = null; file = null; images = []; $("supplier-review").hidden = true; $("supplier-pages").hidden = true;
    setError("supplier-error"); $("supplier-file-state").textContent = "";
    if (!selected) return;
    $("supplier-filename").textContent = selected.name;
    lockRecognition(true);
    try {
      images = await renderFile(selected); file = await encodeFile(selected);
      $("supplier-file-state").textContent = `${images.length} ${images.length === 1 ? "page" : "pages"}`;
      $("supplier-pages").innerHTML = images.map((image, index) => `<figure><button class="document-thumb" type="button" data-document-page="${index}" aria-label="Open document page ${index + 1}" title="Open document page ${index + 1}"><img src="${image}" alt="Supplier document page ${index + 1}"></button><figcaption>Page ${index + 1}</figcaption></figure>`).join("");
      $("supplier-pages").hidden = false;
    } catch (error) { images = []; file = null; setError("supplier-error", error.message); }
    finally { lockRecognition(false); }
  };
  $("supplier-pages").onclick = (event) => {
    const button = event.target.closest("[data-document-page]");
    if (!button) return;
    const index = Number(button.dataset.documentPage);
    $("document-preview-image").src = images[index]; $("document-preview-title").textContent = `Page ${index + 1}`;
    imageDialog.showModal();
  };
  function syncDraft() {
    if (!draft || draft.saved) return;
    draft.items.forEach((item, index) => {
      item.selected = Boolean($(`supplier-include-${index}`)?.checked);
      for (const field of draft.form.fields) {
        const input = $(`supplier-line-${index}-${field.id}`);
        if (input) item.values[field.id] = inputValue(field, input);
      }
    });
  }
  function renderReview() {
    $("supplier-review").hidden = !draft;
    if (!draft) return;
    $("supplier-review-count").textContent = `${draft.items.length} ${draft.items.length === 1 ? "line" : "lines"}`;
    $("supplier-original").href = `/api/suppliers/files/${draft.fileId}`;
    $("supplier-save").hidden = Boolean(draft.saved);
    $("supplier-review-lines").innerHTML = draft.saved
      ? `<div class="source-evidence"><strong>Saved to ${esc(draft.form.name)}</strong><div class="saved-links">${draft.saved.map((id, index) => link(draft.form.id, id, `Line ${index + 1}`)).join("")}</div></div>`
      : draft.items.map((item, index) => `<details class="review-item supplier-review-item"${index === 0 ? " open" : ""}><summary><label><input id="supplier-include-${index}" type="checkbox"${item.selected ? " checked" : ""} aria-label="Include document line ${index + 1}"><strong>Line ${index + 1} · ${esc(item.values.itemCode || "Needs review")}</strong></label><span class="section-count">Page ${item.page}</span></summary><blockquote>${esc(item.evidence)}</blockquote><div class="review-fields">${draft.form.fields.map((field) => renderFieldInput(field, item.values[field.id], `supplier-line-${index}`, getState().references)).join("")}</div></details>`).join("");
    icons();
  }
  $("supplier-recognition-form").onsubmit = async (event) => {
    event.preventDefault();
    if (busy || !file || !images.length) return;
    if (!getState().ai.configured) { setError("supplier-error", "Configure an image-capable model in AI settings first."); return openAISettings(); }
    lockRecognition(true); setError("supplier-error"); draft = null; $("supplier-review").hidden = true;
    try {
      const result = await api("/api/suppliers/extract", { method: "POST", body: JSON.stringify({ file, images }) });
      draft = { ...result, items: result.items.map((item) => ({ ...item, selected: true })) };
      await refresh(); renderReview(); await loadDocumentHistory(); toast("Recognition ready for review. No business records saved yet.");
    } catch (error) { setError("supplier-error", error.message); }
    finally { lockRecognition(false); }
  };
  $("supplier-review-lines").addEventListener("input", () => { syncDraft(); $("supplier-save").disabled = busy || Boolean(draft?.stale) || !draft?.items.some((item) => item.selected); });
  $("supplier-save").onclick = async () => {
    if (busy || !draft || draft.saved) return;
    syncDraft(); lockRecognition(true); setError("supplier-error");
    try {
      const result = await api(`/api/suppliers/drafts/${draft.id}/commit`, { method: "POST",
        body: JSON.stringify({ items: draft.items.flatMap((item, index) => item.selected ? [{ index, values: item.values }] : []) }) });
      draft.saved = result.recordIds;
      await refresh(); renderReview(); await loadDocumentHistory(); toast(`${result.recordIds.length} document lines saved.`);
    } catch (error) {
      const details = Object.entries(error.fields || {}).map(([id, message]) => `${draft.form.fields.find((field) => field.id === id)?.name || id}: ${message}`).join(" ");
      setError("supplier-error", `${error.message}${details ? ` ${details}` : ""}`);
    } finally { lockRecognition(false); }
  };
  async function loadDocumentHistory() {
    const imports = await api("/api/suppliers/drafts");
    $("supplier-history").innerHTML = imports.length ? imports.map((item) => `<button class="import-row" data-document-draft="${item.id}"><span><i data-lucide="${item.committed ? "circle-check" : "file-clock"}"></i><strong>${esc(item.fileName)}</strong><small>${esc(date(item.createdAt))}</small></span><span>${item.itemCount} lines<small>${item.committed ? "Saved" : "Draft"}</small><i data-lucide="chevron-right"></i></span></button>`).join("") : '<p class="import-empty muted">No document recognition yet.</p>';
    icons();
  }
  $("supplier-history").onclick = async (event) => {
    const button = event.target.closest("[data-document-draft]");
    if (!button || busy) return;
    lockRecognition(true);
    try {
      const data = await api(`/api/suppliers/drafts/${button.dataset.documentDraft}`);
      draft = { ...data, saved: data.recordIds, items: data.items.map((item) => ({ ...item, selected: true })) };
      renderReview(); images = []; file = null; $("supplier-file").value = ""; $("supplier-pages").hidden = true;
      $("supplier-filename").textContent = data.fileName; $("supplier-file-state").textContent = data.recordIds ? "Saved" : "Draft";
      setError("supplier-error", data.stale && !data.recordIds ? "The table fields changed. Recognize the original document again before saving." : "");
    } catch (error) { setError("supplier-error", error.message); }
    finally { lockRecognition(false); if (draft?.stale && !draft.saved) $("supplier-save").disabled = true; }
  };
  const roleNames = { order: "Order reference", item: "Item code", quantity: "Quantity", unit: "Unit", supplier: "Supplier", documentType: "Document type" };
  const defaultIds = { order: "relatedOrder", item: "itemCode", quantity: "quantity", unit: "unit", supplier: "supplier", documentType: "documentType" };
  function renderSource(side) {
    const source = sources[side];
    if (!source) return;
    const roles = Object.keys(roleNames).filter((role) => side === "documents" || role !== "documentType");
    $(`${side}-mapping`).innerHTML = roles.map((role) => `<label><span>${roleNames[role]}</span><select class="standalone-input" data-source-role="${role}" aria-label="${side} ${roleNames[role]}"><option value="">Choose field</option>${source.form.fields.filter((field) =>
      role === "order" ? field.type === "reference" : role === "quantity" ? field.type === "number" : role === "documentType" ? field.type === "select" : ["text", "select"].includes(field.type))
      .map((field) => `<option value="${field.id}"${field.id === source.mapping[role] ? " selected" : ""}>${esc(field.name)}</option>`).join("")}</select></label>`).join("");
    renderSelection(side);
  }
  function visibleRecords(side) {
    const source = sources[side];
    return (source?.records || []).filter((record) => side !== "documents" || record.values[source.mapping.documentType] === $("reconciliation-type").value);
  }
  function renderSelection(side) {
    const source = sources[side];
    const records = visibleRecords(side);
    $(`${side}-records`).innerHTML = records.length ? records.map((record) => {
      const orderField = source.form.fields.find((field) => field.id === source.mapping.order);
      const table = getState().references.find((table) => table.id === orderField?.reference?.formId);
      const order = table?.records.find((item) => item.id === record.values[source.mapping.order])?.values[orderField.reference.fieldId] || "No order";
      return `<label class="source-record"><input type="checkbox" data-source-record="${record.id}"${source.selected.has(record.id) ? " checked" : ""}><span><strong>${esc(record.values.receiptNumber || record.values.documentNumber || record.values.lineId || record.id.slice(0, 8))}</strong><small>${esc(order)} · ${esc(record.values[source.mapping.item] ?? "No item")} · ${esc(record.values[source.mapping.supplier] ?? "")}</small></span><span>${esc(number(record.values[source.mapping.quantity]))} ${esc(record.values[source.mapping.unit] ?? "")}</span></label>`;
    }).join("") : '<p class="import-empty muted">No source records</p>';
    $(`${side}-all`).checked = records.length > 0 && records.every((record) => source.selected.has(record.id));
    $(`${side}-all`).indeterminate = records.some((record) => source.selected.has(record.id)) && !$(`${side}-all`).checked;
    renderScope();
  }
  function renderScope() {
    const receiptCount = visibleRecords("receipts").filter((record) => sources.receipts.selected.has(record.id)).length;
    const docCount = visibleRecords("documents").filter((record) => sources.documents.selected.has(record.id)).length;
    $("reconciliation-scope").textContent = `${receiptCount} receipt lines / ${docCount} document lines selected`;
    $("reconciliation-run").disabled = !receiptCount || !docCount;
  }
  async function loadSource(side) {
    const id = $(`${side}-table`).value;
    if (!id) { delete sources[side]; $(`${side}-records`).innerHTML = ""; renderScope(); return; }
    const data = await api(`/api/bootstrap?formId=${encodeURIComponent(id)}`);
    const mapping = Object.fromEntries(Object.entries(defaultIds).map(([role, id]) => [role, data.form.fields.some((field) => field.id === id) ? id : ""]));
    sources[side] = { form: data.form, records: data.records, mapping, selected: new Set(data.records.map((record) => record.id)) };
    renderSource(side);
  }
  async function loadHistory() {
    const runs = await api("/api/reconciliations");
    $("reconciliation-history").innerHTML = runs.length ? runs.map((run) => `<button class="import-row" data-run="${run.id}"><span><i data-lucide="${run.stale ? "circle-alert" : "git-compare-arrows"}"></i><strong>${esc(run.name)}</strong><small>${esc(date(run.createdAt))}</small></span><span>${run.discrepancyCount} discrepancies<small>${run.stale ? "Source changed" : `${run.openCount} open`}</small><i data-lucide="chevron-right"></i></span></button>`).join("") : '<p class="import-empty muted">No comparisons yet.</p>';
    icons();
  }
  function renderResult() {
    $("reconciliation-result").hidden = !currentRun;
    if (!currentRun) return;
    const run = currentRun;
    $("reconciliation-result").innerHTML = `<div class="section-heading"><div><h2>${esc(run.name)}</h2><span class="section-count">${run.rows.length} results</span></div><button class="icon-button toolbar-icon" id="reconciliation-export" title="Export results as CSV" aria-label="Export results as CSV"><i data-lucide="download"></i></button></div>
      ${run.stale ? '<div class="form-error" role="status">Source records or fields have changed. This comparison is out of date.</div>' : ""}
      <div class="result-summary"><span class="status-badge status-success">${run.rows.filter((row) => row.outcome === "Matched").length} matched</span><span class="status-badge status-warning">${run.rows.filter((row) => row.outcome !== "Matched").length} discrepancies</span><span class="section-count">${esc(run.documentType)} · ${esc(date(run.createdAt))}</span></div>
      <div class="table-clip"><table class="data-table reconciliation-table"><thead><tr><th>Order</th><th>Item / Supplier</th><th>Unit</th><th>Received</th><th>Supplier</th><th>Difference</th><th>Result</th><th>Status</th><th>Sources</th><th></th></tr></thead><tbody>${run.rows.map((row) => `<tr><td>${row.orderId ? link(row.orderFormId, row.orderId, row.order) : "-"}</td><td><strong>${esc(row.item)}</strong><small class="cell-subtitle">${esc(row.supplier)}</small></td><td>${esc(row.unit)}</td><td>${number(row.receiptQuantity)}</td><td>${number(row.documentQuantity)}</td><td>${number(row.difference)}</td><td><span class="status-badge ${row.outcome === "Matched" ? "status-success" : "status-warning"}" title="${esc(row.reason)}">${esc(row.outcome)}</span></td><td>${esc(row.status)}</td><td><div class="result-source-links">${row.receipts.map((source) => link(source.formId, source.recordId, source.label)).join("")}${row.documents.map((source) => link(source.formId, source.recordId, source.label)).join("")}</div></td><td><button class="icon-button" data-result-row="${row.id}" title="Review result" aria-label="Review result for ${esc(row.item)}"><i data-lucide="pencil"></i></button></td></tr>`).join("")}</tbody></table></div>`;
    $("reconciliation-export").onclick = () => {
      const cell = (value) => {
        const text = String(value ?? "");
        return `"${(typeof value === "string" && /^(?:\s*[=+@-]|[\t\r\n])/.test(text) ? `'${text}` : text).replace(/"/g, '""')}"`;
      };
      const columns = ["order", "item", "supplier", "unit", "receiptQuantity", "documentQuantity", "difference", "outcome", "reason", "status", "notes"];
      const content = [columns, ...run.rows.map((row) => columns.map((column) => row[column]))].map((row) => row.map(cell).join(",")).join("\r\n");
      const url = URL.createObjectURL(new Blob(["\ufeff", content], { type: "text/csv;charset=utf-8" }));
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = "reconciliation-results.csv"; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    icons();
  }
  async function openRun(id) { currentRun = await api(`/api/reconciliations/${id}`); renderResult(); }
  for (const side of ["receipts", "documents"]) {
    $(`${side}-table`).onchange = () => loadSource(side).catch((error) => setError("reconciliation-error", error.message));
    $(`${side}-mapping`).onchange = (event) => {
      const role = event.target.dataset.sourceRole;
      if (!role || !sources[side]) return;
      sources[side].mapping[role] = event.target.value; renderSelection(side);
    };
    $(`${side}-records`).onchange = (event) => {
      const id = event.target.dataset.sourceRecord;
      if (!id) return;
      event.target.checked ? sources[side].selected.add(id) : sources[side].selected.delete(id);
      renderSelection(side);
    };
    $(`${side}-all`).onchange = () => {
      for (const record of visibleRecords(side)) $(`${side}-all`).checked ? sources[side].selected.add(record.id) : sources[side].selected.delete(record.id);
      renderSelection(side);
    };
  }
  $("reconciliation-type").onchange = () => { renderSelection("documents"); };
  $("reconciliation-form").onsubmit = async (event) => {
    event.preventDefault();
    $("reconciliation-run").disabled = true; setError("reconciliation-error");
    try {
      const config = { name: $("reconciliation-name").value, documentType: $("reconciliation-type").value };
      for (const side of ["receipts", "documents"]) config[side] = { formId: sources[side].form.id, schemaVersion: sources[side].form.version, mapping: sources[side].mapping,
        recordIds: visibleRecords(side).filter((record) => sources[side].selected.has(record.id)).map((record) => record.id) };
      currentRun = await api("/api/reconciliations", { method: "POST", body: JSON.stringify(config) });
      renderResult(); await loadHistory(); toast("Comparison saved.");
    } catch (error) { setError("reconciliation-error", error.message); }
    finally { renderScope(); }
  };
  $("reconciliation-history").onclick = (event) => {
    const button = event.target.closest("[data-run]");
    if (button) openRun(button.dataset.run).catch((error) => setError("reconciliation-error", error.message));
  };
  $("reconciliation-result").onclick = (event) => {
    const button = event.target.closest("[data-result-row]");
    if (!button) return;
    editingRow = currentRun.rows.find((row) => row.id === button.dataset.resultRow);
    $("reconciliation-row-title").textContent = `${editingRow.item} · ${editingRow.outcome}`;
    $("reconciliation-row-detail").innerHTML = `<p>${esc(editingRow.reason || "Quantities match.")}</p><div class="result-summary"><span>Received: ${number(editingRow.receiptQuantity)}</span><span>Supplier: ${number(editingRow.documentQuantity)}</span><strong>Difference: ${number(editingRow.difference)}</strong></div>`;
    $("reconciliation-row-status").value = editingRow.status; $("reconciliation-row-notes").value = editingRow.notes;
    $("reconciliation-row-save").disabled = currentRun.stale; setError("reconciliation-row-error", currentRun.stale ? "Source changed. Run a new comparison before resolving." : "");
    dialog.showModal();
  };
  $("reconciliation-row-close").onclick = () => dialog.close();
  $("reconciliation-row-form").onsubmit = async (event) => {
    event.preventDefault(); $("reconciliation-row-save").disabled = true;
    try {
      currentRun = await api(`/api/reconciliations/${currentRun.id}`, { method: "PATCH", body: JSON.stringify({
        version: currentRun.version, rowId: editingRow.id, status: $("reconciliation-row-status").value, notes: $("reconciliation-row-notes").value,
      }) });
      dialog.close(); renderResult(); await loadHistory(); toast("Review saved.");
    } catch (error) { setError("reconciliation-row-error", error.message); }
    finally { $("reconciliation-row-save").disabled = Boolean(currentRun.stale); }
  };
  async function enter(view) {
    if (view === "document") {
      try { await loadDocumentHistory(); } catch (error) { setError("supplier-error", error.message); }
      return;
    }
    if (view !== "reconciliation") return;
    const ticket = ++sourceLoad;
    const data = getState();
    for (const side of ["receipts", "documents"]) {
      const current = $(`${side}-table`).value;
      $(`${side}-table`).innerHTML = data.forms.map((form) => `<option value="${form.id}">${esc(form.name)}</option>`).join("");
      $(`${side}-table`).value = data.forms.some((form) => form.id === current) ? current : data.supplierTables[side];
    }
    try {
      await Promise.all([loadSource("receipts"), loadSource("documents"), loadHistory()]);
      if (ticket !== sourceLoad) return;
      if (currentRun) await openRun(currentRun.id);
      setError("reconciliation-error");
    } catch (error) { setError("reconciliation-error", error.message); }
  }
  $("reconciliation-refresh").onclick = async () => { await refresh(); await enter("reconciliation"); };
  return { enter, isBusy: () => busy };
}
