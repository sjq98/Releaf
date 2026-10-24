import { html, uiText, uiAttributes, setUIText } from "/i18n.js";

const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const icon = name => html`<i data-lucide="${name}" aria-hidden="true"></i>`;
const today = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};
const EXAMPLE = "Alex will confirm the delivery schedule by 2026-10-26.\nPriya will prepare the stock report by 2026-10-27. The report is complete when all warehouse balances have been checked.\nThe packaging budget is still under discussion. No action has been agreed.";

export function initMeetingTasks({ api, icons, toast, getState, refresh, navigate }) {
  const $ = id => document.getElementById(id);
  const root = $("view-meeting-tasks");
  let mounted = false, busy = false, generation = 0, historyRequest = 0, detailRequest = 0, lastResult = null;
  let retryKey = null, retryBody = null;
  const state = () => getState();
  const canImport = () => Boolean(state().permissions?.editRecords);
  const active = () => Boolean(state().user && state().meetingTasks?.enabled);
  const detail = document.createElement("dialog");
  detail.className = "modal meeting-detail";
  detail.setAttribute("aria-labelledby", "meeting-detail-title");
  detail.innerHTML = html`<div class="modal-heading"><h2 id="meeting-detail-title">Meeting summary</h2><button type="button" class="icon-button" data-meeting-close ${uiAttributes("Close")}>${icon("x")}</button></div><div id="meeting-detail-body"></div>`;
  document.body.append(detail);
  detail.querySelector("[data-meeting-close]").onclick = () => { ++detailRequest; detail.close(); };
  detail.addEventListener("cancel", () => { ++detailRequest; });

  function mount() {
    if (mounted) return;
    root.innerHTML = html`<div class="page-heading"><div><div class="eyebrow">MEETING FOLLOW-UP</div><h1>Meeting to tasks</h1></div><button type="button" class="button button-secondary" data-meeting-table>${icon("table-2")}<span>Open task table</span></button></div>
      <div class="meeting-layout">
        <form id="meeting-import-form" class="meeting-composer">
          <div class="section-heading"><h2>Meeting summary</h2><div class="meeting-tools"><button type="button" class="icon-button" id="meeting-example" ${uiAttributes("Use example")}>${icon("flask-conical")}</button><button type="button" class="button button-secondary" id="meeting-file-open">${icon("file-up")}<span>Import file</span></button><input type="file" id="meeting-file" accept=".txt,.md,text/plain,text/markdown" hidden></div></div>
          <div class="meeting-metadata"><label class="input-field"><span class="builder-label">Meeting title</span><input id="meeting-title" maxlength="120" required autocomplete="off"></label><label class="input-field"><span class="builder-label">Meeting date</span><input id="meeting-date" type="date" min="1900-01-01" max="9999-12-31" required></label></div>
          <label class="input-field meeting-summary-input"><span class="builder-label">Meeting summary</span><textarea id="meeting-text" rows="13" maxlength="40000" required></textarea></label>
          <div class="meeting-text-meta"><span id="meeting-file-name"></span><span id="meeting-character-count">0 / 40,000</span></div>
          <div id="meeting-provider-warning" class="meeting-provider-warning" hidden><span>AI is not configured.</span><button type="button" class="button button-secondary" data-ai-settings>${icon("settings-2")}<span>AI settings</span></button></div>
          <div id="meeting-import-error" class="form-error" role="alert" hidden></div>
          <div class="meeting-submit"><span id="meeting-import-status" role="status"></span><button type="submit" class="button button-primary" id="meeting-import-submit">${icon("sparkles")}<span id="meeting-submit-label">Extract and create tasks</span></button></div>
        </form>
        <aside class="meeting-history" aria-labelledby="meeting-history-title"><div class="section-heading"><h2 id="meeting-history-title">Recent imports</h2><button type="button" class="icon-button" id="meeting-history-refresh" ${uiAttributes("Refresh imports")}>${icon("refresh-cw")}</button></div><div id="meeting-import-history"></div></aside>
      </div>
      <section id="meeting-import-result" class="meeting-result" aria-live="polite" hidden></section>`;
    $("meeting-date").value = today();
    $("meeting-file-open").onclick = () => $("meeting-file").click();
    $("meeting-file").onchange = importFile;
    $("meeting-example").onclick = () => {
      $("meeting-title").value = "Operations follow-up";
      $("meeting-date").value = "2026-10-24";
      $("meeting-text").value = EXAMPLE;
      $("meeting-file-name").textContent = "";
      countCharacters(); $("meeting-text").focus();
    };
    $("meeting-text").oninput = countCharacters;
    $("meeting-import-form").onsubmit = submit;
    $("meeting-history-refresh").onclick = loadHistory;
    root.addEventListener("click", handleClick);
    mounted = true;
  }
  function countCharacters() { $("meeting-character-count").textContent = `${$("meeting-text").value.length.toLocaleString()} / 40,000`; }
  function controls() {
    if (!mounted) return;
    const editable = canImport();
    root.querySelectorAll("#meeting-import-form input, #meeting-import-form textarea, #meeting-example, #meeting-file-open")
      .forEach(input => { input.disabled = busy || !editable; });
    $("meeting-import-submit").disabled = busy || !editable || !state().ai?.configured;
    $("meeting-provider-warning").hidden = Boolean(state().ai?.configured);
    root.querySelector("[data-ai-settings]").hidden = !state().permissions?.manageSettings;
    setUIText($("meeting-submit-label"), busy ? "Extracting..." : "Extract and create tasks");
    setUIText($("meeting-import-status"), busy ? "Creating tasks..." : editable ? "" : "Read-only access");
    $("meeting-import-form").setAttribute("aria-busy", String(busy));
  }
  async function importFile() {
    const file = $("meeting-file").files?.[0], session = generation;
    if (!file) return;
    try {
      if (!/\.(txt|md)$/i.test(file.name) || file.size > 200 * 1024) throw new Error("Choose a UTF-8 .txt or .md file up to 200 KB.");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
      if (session !== generation) return;
      if (!text.trim() || text.length > 40000) throw new Error("Import 1-40,000 characters of meeting text.");
      $("meeting-text").value = text;
      if (!$("meeting-title").value.trim()) $("meeting-title").value = file.name.replace(/\.(txt|md)$/i, "").slice(0, 120);
      $("meeting-file-name").textContent = file.name;
      $("meeting-import-error").hidden = true;
      countCharacters();
    } catch (error) {
      if (session !== generation) return;
      setUIText($("meeting-import-error"), error instanceof TypeError ? "Choose a UTF-8 .txt or .md file up to 200 KB." : error.message);
      $("meeting-import-error").hidden = false;
    } finally { if (session === generation) $("meeting-file").value = ""; }
  }
  async function submit(event) {
    event.preventDefault();
    if (busy || !canImport() || !active()) return;
    const session = generation, userId = state().user.id, spaceId = state().space.id;
    const body = JSON.stringify({ spaceId, title: $("meeting-title").value, date: $("meeting-date").value, text: $("meeting-text").value });
    if (body !== retryBody) { retryKey = crypto.randomUUID(); retryBody = body; }
    busy = true; controls(); $("meeting-import-error").hidden = true;
    try {
      const result = await api("/api/meeting-tasks/imports", { method: "POST", headers: { "Idempotency-Key": retryKey }, body });
      if (session !== generation || state().user?.id !== userId) return;
      lastResult = result;
      if (state().space?.id === spaceId) {
        renderResult();
        await refresh();
        await loadHistory();
        toast(result.duplicate ? "This summary was already imported. No duplicate tasks were created." : `${result.items.length} action items saved.`);
      }
    } catch (error) {
      if (session === generation && state().user?.id === userId) {
        setUIText($("meeting-import-error"), error.message); $("meeting-import-error").hidden = false;
      }
    } finally { if (session === generation) { busy = false; controls(); } }
  }
  function taskRows(result) {
    return result.items.map(item => html`<tr><td><button type="button" class="meeting-record-link" data-meeting-record="${item.recordId}" data-meeting-form="${result.formId}">${esc(item.values.task)}${icon("arrow-up-right")}</button><details class="meeting-evidence"><summary>Source quote</summary><blockquote>${esc(item.evidence)}</blockquote></details></td><td>${esc(item.values.owner ?? "")}</td><td>${esc(item.values.dueDate ?? "")}</td><td>${uiText(item.values.status)}</td></tr>`).join("");
  }
  function taskTable(result) {
    return result.items.length ? html`<div class="table-clip"><table class="data-table meeting-task-table"><thead><tr><th>Action item</th><th>Owner</th><th>Due date</th><th>Status</th></tr></thead><tbody>${taskRows(result)}</tbody></table></div>` : html`<div class="meeting-empty">No action items found. No task records were created.</div>`;
  }
  function renderResult() {
    if (!mounted || !lastResult) return;
    const result = lastResult;
    $("meeting-import-result").hidden = false;
    $("meeting-import-result").innerHTML = html`<div class="section-heading"><div><h2>${uiText(result.duplicate ? "Already imported" : "Tasks created")}</h2><span class="section-count">${result.items.length}</span></div><button type="button" class="icon-button" data-meeting-detail="${result.id}" ${uiAttributes("View meeting summary")}>${icon("file-text")}</button></div><p class="meeting-result-title">${esc(result.title)} <time>${esc(result.date)}</time></p>${taskTable(result)}`;
    icons();
  }
  async function loadHistory() {
    if (!active() || !mounted) return;
    const request = ++historyRequest, session = generation, spaceId = state().space.id;
    try {
      const items = await api(`/api/meeting-tasks/imports?${new URLSearchParams({ spaceId })}`);
      if (session !== generation || request !== historyRequest || state().space?.id !== spaceId) return;
      $("meeting-import-history").innerHTML = items.length ? items.map(item => html`<button type="button" class="meeting-history-row" data-meeting-detail="${item.id}"><span>${icon("file-text")}<strong>${esc(item.title)}</strong>${icon("chevron-right")}</span><small><time>${esc(item.date)}</time><span>${uiText(`${item.count} tasks`)}</span></small></button>`).join("") : html`<div class="meeting-empty">No meeting imports yet.</div>`;
      icons();
    } catch (error) {
      if (session === generation && request === historyRequest && state().space?.id === spaceId) {
        $("meeting-import-history").innerHTML = html`<div class="form-error" role="alert">${uiText(error.message)}</div>`;
      }
    }
  }
  async function inspect(id) {
    const request = ++detailRequest, session = generation, spaceId = state().space.id;
    try {
      const result = await api(`/api/meeting-tasks/imports/${id}?${new URLSearchParams({ spaceId })}`);
      if (session !== generation || request !== detailRequest || state().space?.id !== spaceId || !active()) return;
      $("meeting-detail-title").textContent = result.title;
      $("meeting-detail-body").innerHTML = html`<p class="meeting-detail-date">${esc(result.date)}</p>${taskTable(result)}<details class="meeting-original" open><summary>Original summary</summary><pre>${esc(result.text)}</pre></details>`;
      detail.showModal(); icons();
    } catch (error) { if (session === generation && request === detailRequest) toast(error.message, true); }
  }
  async function handleClick(event) {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.hasAttribute("data-meeting-table")) await navigate(state().meetingTasks.formId);
    if (button.dataset.meetingDetail) await inspect(button.dataset.meetingDetail);
    if (button.dataset.meetingRecord) {
      detail.close();
      await navigate(button.dataset.meetingForm, "records", button.dataset.meetingRecord);
    }
  }
  detail.addEventListener("click", handleClick);
  return {
    enter(view) {
      if (view !== "meeting-tasks" || !active()) { ++detailRequest; detail.close(); return; }
      mount(); controls(); renderResult(); loadHistory(); icons();
    },
    reset() {
      ++generation; ++historyRequest; ++detailRequest;
      busy = false; lastResult = null; retryKey = null; retryBody = null;
      detail.close(); $("meeting-detail-body").replaceChildren();
      if (mounted) {
        $("meeting-import-form").reset(); $("meeting-date").value = today();
        $("meeting-file-name").textContent = ""; countCharacters();
        $("meeting-import-error").hidden = true; $("meeting-import-result").hidden = true;
        $("meeting-import-result").replaceChildren(); $("meeting-import-history").replaceChildren();
      }
    },
    updateSettings: controls,
  };
}
