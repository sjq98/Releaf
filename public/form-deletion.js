import { html, uiText, setUIText } from "/i18n.js";

const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

export function initFormDeletion({ api, icons, toast, onDeleted }) {
  let preview, busy = false, generation = 0;
  const dialog = document.createElement("dialog");
  dialog.className = "modal confirm-dialog form-delete-dialog";
  dialog.setAttribute("aria-labelledby", "form-delete-title");
  dialog.innerHTML = html`<div class="confirm-icon"><i data-lucide="trash-2"></i></div><h2 id="form-delete-title">Delete this form?</h2>
    <div id="form-delete-summary"></div><p>This removes the form and all its records from the workspace. Historical data is retained locally.</p>
    <div id="form-delete-blockers"></div><div class="form-error" id="form-delete-error" role="alert" hidden></div>
    <div class="modal-actions"><button class="button button-secondary" id="form-delete-cancel">Cancel</button><button class="button button-danger" id="form-delete-confirm"><i data-lucide="trash-2"></i><span>Delete form</span></button></div>`;
  document.body.append(dialog);
  const $ = id => dialog.querySelector(`#form-delete-${id}`);
  $("cancel").onclick = () => { if (!busy) dialog.close(); };
  dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
  $("confirm").onclick = async () => {
    if (!preview?.canDelete || busy) return;
    const request = generation, formId = preview.formId;
    busy = true; $("confirm").disabled = true; $("cancel").disabled = true;
    try {
      await api(`/api/forms/${preview.formId}`, { method: "DELETE", body: JSON.stringify({
        version: preview.version, fingerprint: preview.fingerprint, confirmed: true,
      }) });
      if (request !== generation) return;
      dialog.close();
      await onDeleted(formId);
      if (request !== generation) return;
      toast("Form deleted. Historical data retained.");
    } catch (error) {
      if (request !== generation) return;
      setUIText($("error"), error.message); $("error").hidden = false;
      // A stale preview must be reopened; never silently confirm a different deletion.
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
        const result = await api(`/api/forms/${id}/deletion-preview`);
        if (request !== generation) return;
        preview = result;
        $("summary").innerHTML = html`<strong class="delete-form-name">${esc(preview.name)}</strong><span class="section-count">${uiText(`${preview.recordCount} records`)} · ${uiText(`${preview.notificationRuleCount} notification rules`)}</span>`;
        $("blockers").innerHTML = preview.blockers.length ? html`<div class="form-error"><strong>Cannot delete this form</strong><ul>${preview.blockers.map(item => html`<li>${uiText({
          system: "This is a core warehouse form required by the fixed workflows.",
          reference: "Remove the referencing field first:",
          task: "Remove the dependent AI task first:",
          notification: "Remove the dependent notification rule first:",
        }[item.type])}${item.type === "system" ? "" : ` ${esc(item.name)}${item.field ? ` / ${esc(item.field)}` : ""}`}</li>`).join("")}</ul></div>` : "";
        $("confirm").hidden = !preview.canDelete; $("confirm").disabled = !preview.canDelete;
        $("error").hidden = true;
        if (!dialog.open) dialog.showModal();
        $("cancel").focus(); icons();
      } catch (error) { if (request === generation) toast(error.message, true); }
    },
    reset() {
      generation++; preview = null; busy = false;
      if (dialog.open) dialog.close();
      $("summary").replaceChildren(); $("blockers").replaceChildren();
      $("error").hidden = true; setUIText($("error"), "");
      $("confirm").disabled = true; $("cancel").disabled = false;
    },
  };
}
