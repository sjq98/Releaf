import { html, uiText, uiAttributes, setUIText, getLanguage } from "/i18n.js";

const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const icon = name => `<i data-lucide="${name}" aria-hidden="true"></i>`;

export function initAuth({ api, icons, onAuthenticated, onSignedOut }) {
  const $ = id => document.getElementById(id);
  let user = null, permissions = {}, setupRequired = false, busy = false, users = [], sequence = 0;
  const screen = document.createElement("main");
  screen.id = "auth-screen";
  screen.className = "auth-screen";
  const usersDialog = document.createElement("dialog");
  usersDialog.id = "auth-users-dialog"; usersDialog.className = "modal auth-users-dialog";
  const editDialog = document.createElement("dialog");
  editDialog.id = "auth-user-edit-dialog"; editDialog.className = "modal compact-dialog";
  const passwordDialog = document.createElement("dialog");
  passwordDialog.id = "auth-password-dialog"; passwordDialog.className = "modal compact-dialog";
  document.body.append(screen, usersDialog, editDialog, passwordDialog);

  function errorAt(id, message) {
    const node = $(id);
    if (!node) return;
    setUIText(node, message); node.hidden = !message;
  }
  function hideWorkspace() {
    $("app-workspace").hidden = true;
    $("assistant-launcher").hidden = true;
    $("assistant-panel").hidden = true;
    document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close());
    $("account-menu").hidden = true;
    $("account-button").setAttribute("aria-expanded", "false");
  }
  function renderScreen(message = "") {
    screen.hidden = false;
    screen.innerHTML = html`<section class="auth-content"><a class="brand auth-brand" href="#records"><span class="brand-mark">${icon("panels-top-left")}</span><span class="brand-copy"><strong>Releaf</strong><span>WORKSPACE</span></span></a><div class="auth-heading"><span class="eyebrow">WAREHOUSE WORKSPACE</span><h1>${uiText(setupRequired ? "Create administrator" : "Sign in")}</h1><p>${uiText(setupRequired ? "Set up the first administrator for this workspace." : "Sign in to your workspace account.")}</p></div><form id="auth-form"><div class="form-fields"><label class="input-field"><span>Username</span><input id="auth-username" class="standalone-input" required minlength="3" maxlength="32" pattern="[A-Za-z0-9][A-Za-z0-9._\\-]{2,31}" autocomplete="username" autocapitalize="none" spellcheck="false" ${busy ? "disabled" : ""}></label>${setupRequired ? html`<label class="input-field"><span>Display name</span><input id="auth-display-name" class="standalone-input" required maxlength="80" autocomplete="name" ${busy ? "disabled" : ""}></label>` : ""}<label class="input-field"><span>Password</span><input id="auth-password" class="standalone-input" type="password" required ${setupRequired ? 'minlength="12"' : ""} maxlength="1024" autocomplete="${setupRequired ? "new-password" : "current-password"}" ${busy ? "disabled" : ""}></label>${setupRequired ? html`<p class="auth-password-hint">Use at least 12 characters.</p>` : ""}</div><div id="auth-error" class="form-error" role="alert" ${message ? "" : "hidden"}>${uiText(message)}</div><button class="button button-primary auth-submit" type="submit" ${busy ? "disabled" : ""}>${icon(busy ? "loader-circle" : "log-in")}<span>${uiText(busy ? "Signing in..." : setupRequired ? "Create administrator" : "Sign in")}</span></button></form><div class="auth-language"><select class="language-select" data-language-picker aria-label="Language" title="Language"><option value="en">English</option><option value="zh">中文</option></select></div></section>`;
    const language = screen.querySelector("[data-language-picker]");
    language.value = getLanguage();
    $("auth-form").onsubmit = signIn;
    icons();
  }
  function renderAccount() {
    if (!user) return;
    const name = user.displayName || user.username;
    $("account-button").textContent = name.slice(0, 1).toUpperCase();
    $("account-button").title = name;
    $("account-button").setAttribute("aria-label", name);
    $("account-menu").innerHTML = html`<div class="account-summary"><strong>${esc(name)}</strong><span>${esc(user.username)} · ${uiText(user.role === "admin" ? "Administrator" : "Member")}</span></div><button type="button" data-auth-password>${icon("key-round")}<span>Change password</span></button>${permissions.manageUsers ? html`<button type="button" data-auth-users>${icon("users")}<span>Manage users</span></button>` : ""}<button type="button" data-auth-logout>${icon("log-out")}<span>Sign out</span></button>`;
    document.querySelectorAll("[data-ai-settings]").forEach(button => { button.hidden = !permissions.manageSettings; });
    icons();
  }
  async function accept(session, request) {
    user = session.user; permissions = session.permissions || {};
    await onAuthenticated(session);
    if (request !== sequence || !user) return;
    renderAccount();
    screen.hidden = true;
    $("app-workspace").hidden = false;
    $("assistant-launcher").hidden = false;
  }
  function clear(message = "") {
    sequence++;
    user = null; permissions = {}; users = []; busy = false;
    hideWorkspace(); onSignedOut?.();
    for (const dialog of [usersDialog, editDialog, passwordDialog]) dialog.replaceChildren();
    $("account-menu").replaceChildren();
    renderScreen(message);
  }
  async function signIn(event) {
    event.preventDefault();
    if (busy || !$("auth-form").reportValidity()) return;
    const body = { username: $("auth-username").value.trim(), password: $("auth-password").value };
    const request = ++sequence;
    if (setupRequired) body.displayName = $("auth-display-name").value.trim();
    busy = true;
    $("auth-form").querySelectorAll("input,button").forEach(input => { input.disabled = true; });
    errorAt("auth-error", "");
    try {
      const session = await api(`/api/auth/${setupRequired ? "setup" : "login"}`, { method: "POST", body: JSON.stringify(body) });
      if (request !== sequence) return;
      setupRequired = false;
      await accept(session, request);
      if (request === sequence) $("auth-password").value = "";
    } catch (error) {
      if (request !== sequence) return;
      if (error.status === 409 && setupRequired) { setupRequired = false; renderScreen(error.message); return; }
      errorAt("auth-error", error.message);
    } finally {
      if (request === sequence) {
        busy = false;
        $("auth-form")?.querySelectorAll("input,button").forEach(input => { input.disabled = false; });
      }
    }
  }
  async function start() {
    const request = ++sequence;
    hideWorkspace(); renderScreen();
    busy = true;
    $("auth-form").querySelectorAll("input,button").forEach(input => { input.disabled = true; });
    try {
      const status = await api("/api/auth/status");
      if (request !== sequence) return;
      setupRequired = status.setupRequired;
      busy = false;
      if (status.user) await accept(status, request);
      else renderScreen();
    } catch (error) { if (request === sequence) { busy = false; renderScreen(error.message); } }
  }
  async function showUsers() {
    if (!permissions.manageUsers) return;
    const request = sequence;
    usersDialog.innerHTML = html`<div class="modal-heading"><h2>Manage users</h2><button type="button" class="icon-button" data-auth-close="auth-users-dialog" ${uiAttributes("Close")}>${icon("x")}</button></div><div id="auth-users-error" class="form-error" role="alert" hidden></div><div id="auth-users-list"></div><div class="modal-actions"><button type="button" class="button button-primary" data-auth-user-new>${icon("user-plus")}<span>Add user</span></button></div>`;
    if (!usersDialog.open) usersDialog.showModal();
    try {
      const result = await api("/api/auth/users");
      if (request !== sequence || !user || !permissions.manageUsers) return;
      users = result;
      $("auth-users-list").innerHTML = html`<div class="table-clip"><table class="data-table"><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>${users.map(item => html`<tr><td>${esc(item.displayName)}</td><td>${esc(item.username)}</td><td>${uiText(item.role === "admin" ? "Administrator" : "Member")}</td><td>${uiText(item.active ? "Active" : "Disabled")}</td><td><button type="button" class="icon-button" data-auth-user-edit="${item.id}" ${uiAttributes("Edit user")}>${icon("pencil")}</button></td></tr>`).join("")}</tbody></table></div>`;
    } catch (error) { if (request === sequence) errorAt("auth-users-error", error.message); }
    icons();
  }
  function editUser(id) {
    if (!permissions.manageUsers) return;
    const item = users.find(candidate => candidate.id === id);
    editDialog.innerHTML = html`<form id="auth-user-form"><div class="modal-heading"><h2>${uiText(item ? "Edit user" : "Add user")}</h2><button type="button" class="icon-button" data-auth-close="auth-user-edit-dialog" ${uiAttributes("Close")}>${icon("x")}</button></div><div class="form-fields"><label class="input-field"><span>Username</span><input id="auth-user-username" class="standalone-input" required minlength="3" maxlength="32" pattern="[A-Za-z0-9][A-Za-z0-9._\\-]{2,31}" value="${esc(item?.username)}" ${item ? "disabled" : ""} autocomplete="off" autocapitalize="none" spellcheck="false"></label><label class="input-field"><span>Display name</span><input id="auth-user-name" class="standalone-input" required maxlength="80" value="${esc(item?.displayName)}"></label><label class="input-field"><span>Role</span><select id="auth-user-role" class="standalone-input"><option value="user" ${item?.role !== "admin" ? "selected" : ""}>Member</option><option value="admin" ${item?.role === "admin" ? "selected" : ""}>Administrator</option></select></label>${item ? html`<label class="auth-active"><input type="checkbox" id="auth-user-active" ${item.active ? "checked" : ""}><span>Account active</span></label>` : ""}<label class="input-field"><span>${uiText(item ? "New password (optional)" : "Password")}</span><input id="auth-user-password" class="standalone-input" type="password" minlength="12" maxlength="1024" ${item ? "" : "required"} autocomplete="new-password"></label><p class="auth-password-hint">Use at least 12 characters.</p></div><div id="auth-user-error" class="form-error" role="alert" hidden></div><div class="modal-actions"><button type="button" class="button button-secondary" data-auth-close="auth-user-edit-dialog">Cancel</button><button type="submit" class="button button-primary">${icon("check")}<span>Save user</span></button></div></form>`;
    $("auth-user-form").onsubmit = async event => {
      event.preventDefault();
      if (!permissions.manageUsers || !$("auth-user-form").reportValidity()) return;
      const request = sequence;
      const submit = event.submitter; submit.disabled = true;
      const body = { displayName: $("auth-user-name").value.trim(), role: $("auth-user-role").value };
      if (item) body.active = $("auth-user-active").checked;
      else body.username = $("auth-user-username").value.trim();
      if ($("auth-user-password").value) body.password = $("auth-user-password").value;
      try {
        const saved = await api(item ? `/api/auth/users/${item.id}` : "/api/auth/users", { method: item ? "PATCH" : "POST", body: JSON.stringify(body) });
        if (request !== sequence || !permissions.manageUsers) return;
        editDialog.close();
        if (item?.id === user?.id) {
          if (body.role !== item.role || body.active !== item.active || body.password) return clear("Account updated. Sign in again.");
          user = saved; renderAccount();
        }
        await showUsers();
      } catch (error) { if (request === sequence) errorAt("auth-user-error", error.message); }
      finally { submit.disabled = false; }
    };
    editDialog.showModal(); icons();
  }
  function showPassword() {
    if (!user) return;
    passwordDialog.innerHTML = html`<form id="auth-password-form"><div class="modal-heading"><h2>Change password</h2><button type="button" class="icon-button" data-auth-close="auth-password-dialog" ${uiAttributes("Close")}>${icon("x")}</button></div><div class="form-fields"><label class="input-field"><span>Current password</span><input id="auth-current-password" class="standalone-input" type="password" required autocomplete="current-password"></label><label class="input-field"><span>New password</span><input id="auth-new-password" class="standalone-input" type="password" required minlength="12" maxlength="1024" autocomplete="new-password"></label><label class="input-field"><span>Confirm new password</span><input id="auth-confirm-password" class="standalone-input" type="password" required minlength="12" maxlength="1024" autocomplete="new-password"></label><p class="auth-password-hint">Use at least 12 characters.</p></div><div id="auth-password-error" class="form-error" role="alert" hidden></div><div class="modal-actions"><button type="button" class="button button-secondary" data-auth-close="auth-password-dialog">Cancel</button><button type="submit" class="button button-primary">${icon("check")}<span>Change password</span></button></div></form>`;
    $("auth-password-form").onsubmit = async event => {
      event.preventDefault();
      if (!user) return;
      const request = sequence;
      if ($("auth-new-password").value !== $("auth-confirm-password").value) return errorAt("auth-password-error", "Passwords do not match.");
      const submit = event.submitter; submit.disabled = true;
      try {
        await api("/api/auth/password", { method: "POST", body: JSON.stringify({ currentPassword: $("auth-current-password").value, password: $("auth-new-password").value }) });
        if (request !== sequence) return;
        passwordDialog.close();
        $("auth-password-form").reset();
      } catch (error) { if (request === sequence) errorAt("auth-password-error", error.message); }
      finally { submit.disabled = false; }
    };
    passwordDialog.showModal(); icons();
  }
  $("account-button").onclick = () => {
    $("account-menu").hidden = !$("account-menu").hidden;
    $("account-button").setAttribute("aria-expanded", String(!$("account-menu").hidden));
  };
  document.addEventListener("click", async event => {
    const close = event.target.closest("[data-auth-close]");
    if (close) $(close.dataset.authClose).close();
    if (!event.target.closest(".account-control")) { $("account-menu").hidden = true; $("account-button").setAttribute("aria-expanded", "false"); }
    if (event.target.closest("[data-auth-users]")) { $("account-menu").hidden = true; await showUsers(); }
    if (event.target.closest("[data-auth-user-new]")) editUser();
    const edit = event.target.closest("[data-auth-user-edit]");
    if (edit) editUser(edit.dataset.authUserEdit);
    if (event.target.closest("[data-auth-password]")) { $("account-menu").hidden = true; showPassword(); }
    if (event.target.closest("[data-auth-logout]")) {
      try { await api("/api/auth/logout", { method: "POST", body: "{}" }); clear(); }
      catch (error) { clear(error.message); }
    }
  });
  document.addEventListener("keydown", event => { if (event.key === "Escape") { $("account-menu").hidden = true; $("account-button").setAttribute("aria-expanded", "false"); } });
  document.addEventListener("languagechange", () => {
    if (user) renderAccount();
    else {
      const values = [$("auth-username")?.value, $("auth-display-name")?.value, $("auth-password")?.value];
      renderScreen();
      $("auth-username").value = values[0] || "";
      if ($("auth-display-name")) $("auth-display-name").value = values[1] || "";
      $("auth-password").value = values[2] || "";
    }
  });
  return { start, expire: () => clear("Your session has expired. Sign in again."), setSession(session) { user = session.user; permissions = session.permissions || {}; renderAccount(); } };
}
