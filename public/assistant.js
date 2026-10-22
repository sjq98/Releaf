import { initAISettings } from "/ai-settings.js";

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const icon = (name) => `<i data-lucide="${name}" aria-hidden="true"></i>`;
const label = (value) => value == null || value === "" ? "(empty)" : typeof value === "boolean" ? value ? "Yes" : "No" : String(value);
const timestamp = (value) => new Date(value).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

export function initAssistant({ api, icons, onChanged }) {
  const $ = (id) => document.getElementById(`assistant-${id}`);
  const panel = $("panel");
  const state = { mode: "review", config: {}, actions: [], session: null, tab: "chat", busy: false, deciding: false };
  let tokenBusy = false;
  let polling = false;
  let actionsRenderKey = "";
  let lastFocus;
  let sessionId;
  try { sessionId = localStorage.getItem("releaf-assistant-session"); } catch { /* Conversations still work when browser storage is disabled. */ }

  // Reuse the same provider editor and validation flow, with separate assistant storage.
  const settings = document.getElementById("ai-settings-dialog").cloneNode(true);
  for (const node of [settings, ...settings.querySelectorAll("*")]) {
    if (node.id) node.id = `assistant-${node.id}`;
    for (const attr of ["for", "aria-labelledby", "aria-describedby"]) {
      if (node.hasAttribute(attr)) node.setAttribute(attr, node.getAttribute(attr).split(" ").map((id) => `assistant-${id}`).join(" "));
    }
  }
  settings.querySelector("h2").textContent = "Assistant provider";
  document.body.append(settings);
  initAISettings({ api, icons, namespace: "assistant-", endpoint: "/api/assistant", triggerSelector: "[data-assistant-settings]",
    onSaved(config) { state.config = config; renderHeader(); error(); } });

  function error(message = "") {
    $("error").textContent = message;
    $("error").hidden = !message;
  }
  function setBusy(busy) {
    state.busy = busy;
    $("message").disabled = busy;
    $("send").disabled = busy || !state.session || !state.config.configured;
    $("new").disabled = busy;
    $("working").hidden = !busy;
    $("message-form").setAttribute("aria-busy", String(busy));
    document.querySelectorAll("[data-assistant-mode]").forEach((button) => { button.disabled = busy; });
    renderActions();
  }
  function renderHeader() {
    $("provider-status").textContent = state.config.configured ? `${state.config.providerName} · ${state.config.model}` : "Not configured";
    $("provider-status").title = $("provider-status").textContent;
    document.querySelectorAll("[data-assistant-mode]").forEach((button) => { button.setAttribute("aria-pressed", String(button.dataset.assistantMode === state.mode)); });
    const count = state.actions.filter((action) => action.status === "pending").length;
    $("pending-count").textContent = count;
    $("launcher-count").textContent = count;
    $("launcher-count").hidden = !count;
    $("send").disabled = state.busy || !state.session || !state.config.configured;
    $("message").placeholder = state.config.configured ? "Message Releaf..." : "Configure an assistant provider to chat";
  }
  function renderMessages() {
    const messages = state.session?.messages || [];
    $("messages").innerHTML = messages.length ? messages.map((message) =>
      `<article class="assistant-message assistant-message-${message.role === "user" ? "user" : "bot"}"><span class="assistant-message-label">${message.role === "user" ? "YOU" : "RELEAF"}</span><p>${esc(message.content)}</p></article>`).join("")
      : `<div class="assistant-empty">${icon("messages-square")}No messages yet</div>`;
    icons();
    $("chat-view").scrollTop = $("chat-view").scrollHeight;
  }
  function renderActions() {
    const actions = state.actions.filter((action) => state.tab === "approvals" ? action.status === "pending" : action.status !== "pending");
    const renderKey = JSON.stringify([state.tab, state.busy, state.deciding, actions]);
    if (renderKey === actionsRenderKey) return;
    actionsRenderKey = renderKey;
    $("actions-view").innerHTML = actions.length ? actions.map((action) => {
      const preview = action.preview;
      const diff = preview.diff?.map((item) => `<div class="assistant-diff-row"><span class="assistant-diff-name">${esc(item.name)}</span><div class="assistant-diff-values"><span class="assistant-before">${esc(item.beforeLabel ?? label(item.before))}</span>${icon("arrow-right")}<span class="assistant-after">${esc(item.afterLabel ?? label(item.after))}</span></div></div>`).join("");
      const schema = preview.after?.fields ? `<div class="assistant-action-note">${preview.after.fields.length} ${preview.after.fields.length === 1 ? "field" : "fields"}${preview.before ? ` · ${preview.affectedRecords} existing records · ${preview.changedRecordCount} records with visible value changes` : ""}</div>
        ${preview.before?.name !== preview.after.name ? `<div class="assistant-diff-row"><span class="assistant-diff-name">Table name</span><div class="assistant-diff-values"><span class="assistant-before">${esc(preview.before?.name || "(new table)")}</span>${icon("arrow-right")}<span class="assistant-after">${esc(preview.after.name)}</span></div></div>` : ""}
        <details class="assistant-schema"><summary>Field changes</summary><pre>${esc(JSON.stringify({ before: preview.before?.fields || [], after: preview.after.fields }, null, 2))}</pre></details>
        ${preview.changedRecordCount ? `<details class="assistant-schema"><summary>Affected visible values (${preview.recordChanges.length} of ${preview.changedRecordCount})</summary><pre>${esc(JSON.stringify(preview.recordChanges, null, 2))}</pre></details>` : ""}` : "";
      const resultRecord = action.result?.record;
      const formId = preview.formId || action.result?.id;
      const recordId = resultRecord?.id || (action.operation === "delete_record" ? null : preview.recordId);
      return `<article class="assistant-action"><h3>${esc(preview.title)}</h3><div class="assistant-action-meta"><span>${esc(action.actorName)} · ${esc(timestamp(action.createdAt))}</span><span class="assistant-action-status ${esc(action.status)}">${esc(action.status)}</span></div>
        <div class="assistant-diff">${diff || ""}</div>${schema}${preview.noChange ? '<p class="assistant-action-note">No value changes.</p>' : ""}
        ${action.operation === "delete_record" ? '<p class="assistant-action-note">This record will be removed. Its activity history remains.</p>' : ""}
        ${action.error ? `<p class="assistant-action-note" role="alert">${esc(action.error)}</p>` : ""}
        ${action.status === "applied" && formId ? `<a class="assistant-record-link" href="?formId=${encodeURIComponent(formId)}${recordId ? `&recordId=${encodeURIComponent(recordId)}` : ""}#records">Open ${recordId ? "record" : "table"} ${icon("arrow-up-right")}</a>` : ""}
        ${action.status === "pending" ? `<div class="assistant-action-buttons"><button class="button button-secondary" data-assistant-reject="${action.id}"${state.deciding || state.busy ? " disabled" : ""}>${icon("x")}<span>Reject</span></button><button class="button ${action.operation === "delete_record" ? "button-danger" : "button-primary"}" data-assistant-approve="${action.id}"${state.deciding || state.busy ? " disabled" : ""}>${icon("check")}<span>Approve</span></button></div>` : ""}</article>`;
    }).join("") : `<div class="assistant-empty">${icon(state.tab === "approvals" ? "shield-check" : "history")}${state.tab === "approvals" ? "No pending approvals" : "No agent activity yet"}</div>`;
    icons();
  }
  function tab(name) {
    state.tab = name;
    document.querySelectorAll("[data-assistant-tab]").forEach((button) => {
      if (button.dataset.assistantTab === name) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    $("chat-view").hidden = name !== "chat";
    $("actions-view").hidden = name === "chat";
    $("message-form").hidden = name !== "chat";
    renderActions();
  }
  async function refreshState() {
    const data = await api("/api/assistant/state");
    state.mode = data.mode;
    state.config = data.config;
    state.actions = data.actions;
    renderHeader();
    renderActions();
  }
  async function newSession() {
    state.session = await api("/api/assistant/sessions", { method: "POST", body: "{}" });
    sessionId = state.session.id;
    try { localStorage.setItem("releaf-assistant-session", sessionId); } catch { /* Optional browser persistence. */ }
    renderMessages();
    renderHeader();
  }
  async function loadSession() {
    if (sessionId) {
      try { state.session = await api(`/api/assistant/sessions/${sessionId}`); renderMessages(); return; }
      catch (cause) { if (cause.status !== 404) throw cause; }
    }
    await newSession();
  }
  async function open() {
    lastFocus = document.activeElement;
    panel.hidden = false;
    $("launcher").hidden = true;
    $("launcher").setAttribute("aria-expanded", "true");
    error();
    try { await refreshState(); if (!state.session) await loadSession(); renderHeader(); }
    catch (cause) { error(cause.message); }
    $("message").focus();
  }
  function close() {
    panel.hidden = true;
    $("launcher").hidden = false;
    $("launcher").setAttribute("aria-expanded", "false");
    (lastFocus || $("launcher")).focus();
  }
  $("launcher").addEventListener("click", open);
  $("close").addEventListener("click", close);
  panel.addEventListener("keydown", (event) => { if (event.key === "Escape") { close(); event.stopPropagation(); } });
  $("new").addEventListener("click", async () => {
    try { await newSession(); tab("chat"); error(); $("message").focus(); }
    catch (cause) { error(cause.message); }
  });
  $("refresh").addEventListener("click", () => refreshState().catch((cause) => error(cause.message)));
  document.querySelectorAll("[data-assistant-tab]").forEach((button) => button.addEventListener("click", () => tab(button.dataset.assistantTab)));

  function confirm({ title = "Enable full access?", copy = "Changes can be saved and records deleted without approval. Field validation and activity history remain active.", accept = "Enable full access" } = {}) {
    return new Promise((resolve) => {
      const dialog = $("confirm-dialog");
      $("confirm-title").textContent = title;
      $("confirm-copy").textContent = copy;
      $("confirm-accept").querySelector("span").textContent = accept;
      dialog.returnValue = "";
      dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirmed"), { once: true });
      dialog.showModal();
      $("confirm-cancel").focus();
    });
  }
  $("confirm-cancel").addEventListener("click", () => $("confirm-dialog").close());
  $("confirm-accept").addEventListener("click", () => $("confirm-dialog").close("confirmed"));
  document.querySelectorAll("[data-assistant-mode]").forEach((button) => button.addEventListener("click", async () => {
    const mode = button.dataset.assistantMode;
    if (state.busy || mode === state.mode || (mode === "full" && !await confirm())) return;
    try {
      await api("/api/assistant/mode", { method: "PUT", body: JSON.stringify({ mode, confirmFullAccess: mode === "full" }) });
      await refreshState(); error();
    } catch (cause) { error(cause.message); }
  }));
  $("message-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = $("message").value.trim();
    if (!text || state.busy || !state.session) return;
    setBusy(true); error();
    const before = new Set(state.actions.map((action) => action.id));
    state.session.messages.push({ role: "user", content: text });
    renderMessages();
    try {
      const result = await api(`/api/assistant/sessions/${state.session.id}/messages`, { method: "POST", body: JSON.stringify({ text }) });
      state.session = result;
      $("message").value = "";
      renderMessages();
      await refreshState();
      if (result.changed) await onChanged();
      if (result.actions.some((action) => action.status === "pending" && !before.has(action.id))) tab("approvals");
    } catch (cause) {
      error(cause.message);
      try { await loadSession(); await refreshState(); await onChanged(); } catch { /* Keep the original error visible. */ }
    } finally { setBusy(false); if (state.tab === "chat") $("message").focus(); }
  });
  $("actions-view").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-assistant-approve],[data-assistant-reject]");
    if (!button || state.deciding || state.busy) return;
    const id = button.dataset.assistantApprove || button.dataset.assistantReject;
    const decision = button.dataset.assistantApprove ? "approve" : "reject";
    state.deciding = true; renderActions(); error();
    try {
      await api(`/api/assistant/actions/${id}/${decision}`, { method: "POST", body: "{}" });
      if (decision === "approve") await onChanged();
    } catch (cause) { error(cause.message); }
    finally { state.deciding = false; await refreshState().catch((cause) => error(cause.message)); }
  });

  function tokenError(message = "") { $("token-error").textContent = message; $("token-error").hidden = !message; }
  async function renderTokens() {
    const tokens = await api("/api/assistant/tokens");
    $("token-list").innerHTML = tokens.length ? tokens.map((token) => `<div class="assistant-token-row"><div><strong>${esc(token.name)}</strong><code>${esc(token.prefix)}...</code>${token.revokedAt ? '<span class="label-note"> · Revoked</span>' : ""}</div>
      <div class="assistant-token-controls"><select class="standalone-input" data-token-mode="${token.id}" aria-label="${esc(token.name)} access"${token.revokedAt ? " disabled" : ""}><option value="review"${token.mode === "review" ? " selected" : ""}>Review first</option><option value="full"${token.mode === "full" ? " selected" : ""}>Full access</option></select><button class="icon-button action-delete" data-token-revoke="${token.id}" title="Revoke token" aria-label="Revoke ${esc(token.name)}"${token.revokedAt ? " disabled" : ""}>${icon("trash-2")}</button></div></div>`).join("")
      : '<p class="assistant-action-note">No access tokens</p>';
    icons();
  }
  function tokenWorking(busy) {
    tokenBusy = busy;
    $("token-dialog").querySelectorAll("button,input,select").forEach((node) => {
      if (busy) node.setAttribute("data-was-disabled", String(node.disabled));
      if (busy) node.disabled = true;
      else if (node.hasAttribute("data-was-disabled")) {
        node.disabled = node.getAttribute("data-was-disabled") === "true";
        node.removeAttribute("data-was-disabled");
      }
    });
  }
  $("tokens-open").addEventListener("click", async () => {
    $("token-dialog").showModal(); tokenError();
    try { await renderTokens(); } catch (cause) { tokenError(cause.message); }
  });
  $("tokens-close").addEventListener("click", () => { if (!tokenBusy) $("token-dialog").close(); });
  $("token-dialog").addEventListener("cancel", (event) => { if (tokenBusy) event.preventDefault(); });
  $("token-dialog").addEventListener("close", () => { $("created-token").value = ""; $("token-secret").hidden = true; });
  $("token-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (tokenBusy) return;
    const mode = $("token-mode").value;
    if (mode === "full" && !await confirm()) return;
    tokenWorking(true); tokenError();
    try {
      const result = await api("/api/assistant/tokens", { method: "POST", body: JSON.stringify({ name: $("token-name").value, mode, confirmFullAccess: mode === "full" }) });
      $("created-token").value = result.token;
      $("token-secret").hidden = false;
      $("token-form").reset();
      await renderTokens();
    } catch (cause) { tokenError(cause.message); }
    finally { tokenWorking(false); }
  });
  $("copy-token").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("created-token").value); $("copy-token").title = "Copied"; }
    catch { $("created-token").focus(); $("created-token").select(); }
  });
  $("token-list").addEventListener("change", async (event) => {
    const input = event.target.closest("[data-token-mode]");
    if (!input || tokenBusy) return;
    const mode = input.value;
    if (mode === "full" && !await confirm()) { await renderTokens(); return; }
    tokenWorking(true); tokenError();
    try {
      await api(`/api/assistant/tokens/${input.dataset.tokenMode}`, { method: "PATCH", body: JSON.stringify({ mode, confirmFullAccess: mode === "full" }) });
    } catch (cause) { tokenError(cause.message); }
    finally { tokenWorking(false); await renderTokens().catch((cause) => tokenError(cause.message)); }
  });
  $("token-list").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-token-revoke]");
    if (!button || tokenBusy) return;
    if (!await confirm({ title: "Revoke this token?", copy: "The agent will lose access. Its pending changes will be rejected.", accept: "Revoke token" })) return;
    tokenWorking(true); tokenError();
    try { await api(`/api/assistant/tokens/${button.dataset.tokenRevoke}`, { method: "DELETE" }); await refreshState(); }
    catch (cause) { tokenError(cause.message); }
    finally { tokenWorking(false); await renderTokens().catch((cause) => tokenError(cause.message)); }
  });
  setInterval(async () => {
    if (panel.hidden || state.busy || state.deciding || polling || document.hidden) return;
    polling = true;
    try { await refreshState(); } catch (cause) { error(cause.message); }
    finally { polling = false; }
  }, 15000);
  icons();
  return { open };
}
