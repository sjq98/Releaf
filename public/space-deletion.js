import { html, uiText, setUIText } from "/i18n.js";

const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

export function initSpaceDeletion({ api, icons, toast, onDeleted }) {
  let preview, busy = false, generation = 0;
  const dialog = document.createElement("dialog");
  dialog.className = "modal confirm-dialog form-delete-dialog";
  dialog.setAttribute("aria-labelledby", "space-delete-title");
  dialog.innerHTML = html`<div class="confirm-icon"><i data-lucide="trash-2"></i></div><h2 id="space-delete-title">Delete this Space?</h2>
    <div id="space-delete-summary"></div><p>This permanently deletes the Space and its tables, records, files, and workflows, including historical data. This cannot be undone.</p>
    <div class="form-error" id="space-delete-error" role="alert" hidden></div>
    <div class="modal-actions"><button type="button" class="button button-secondary" id="space-delete-cancel">Cancel</button><button type="button" class="button button-danger" id="space-delete-confirm"><i data-lucide="trash-2"></i><span>Delete Space</span></button></div>`;
  document.body.append(dialog);
  const $ = id => dialog.querySelector(`#space-delete-${id}`);
  $("cancel").onclick = () => { if (!busy) dialog.close(); };
  dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
  dialog.addEventListener("close", () => { if (!busy) { generation++; preview = null; } });
  $("confirm").onclick = async () => {
    if (!preview?.canDelete || busy) return;
    const request = generation;
    busy = true; $("confirm").disabled = true; $("cancel").disabled = true;
    try {
      const result = await api(`/api/spaces/${preview.spaceId}`, { method: "DELETE", body: JSON.stringify({
        fingerprint: preview.fingerprint, confirmed: true,
      }) });
      if (request !== generation) return;
      await onDeleted(result);
      if (request !== generation) return;
      dialog.close();
      toast("Space deleted.");
    } catch (error) {
      if (request !== generation) return;
      setUIText($("error"), error.message); $("error").hidden = false;
      if (error.status === 409 || error.status === 404) preview = null;
    } finally {
      if (request === generation) { busy = false; $("confirm").disabled = !preview?.canDelete; $("cancel").disabled = false; }
    }
  };
  return {
    async open(id) {
      if (busy) return;
      const request = ++generation;
      try {
        const result = await api(`/api/spaces/${id}/deletion-preview`);
        if (request !== generation) return;
        preview = result;
        $("summary").innerHTML = html`<strong class="delete-form-name">${esc(preview.name)}</strong><span class="section-count">${uiText(`${preview.tableCount} tables`)} · ${uiText(`${preview.recordCount} records`)} · ${uiText(`${preview.fileCount} files`)}</span>`;
        $("confirm").hidden = !preview.canDelete; $("confirm").disabled = !preview.canDelete;
        $("error").hidden = preview.canDelete;
        if (!preview.canDelete) setUIText($("error"), "Keep at least one Space.");
        if (!dialog.open) dialog.showModal();
        $("cancel").focus(); icons();
      } catch (error) { if (request === generation) toast(error.message, true); }
    },
    reset() {
      generation++; preview = null; busy = false;
      if (dialog.open) dialog.close();
      $("summary").replaceChildren(); $("error").hidden = true; setUIText($("error"), "");
      $("confirm").disabled = true; $("cancel").disabled = false;
    },
  };
}
