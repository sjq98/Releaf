import { html, uiText, setUIText, setUIAttribute, uiAttributes, t, languagePicker } from "/i18n.js";
import { initFormulaEditor } from "/formula-editor.js";
import { encodeFile } from "/table-import.js";
import { compileConditions, conditionBuilderFrom } from "/condition-expression.js";
import { initNavigationDrag } from "/navigation-drag.js";

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const icon = (name) => html`<i data-lucide="${name}" aria-hidden="true"></i>`;
const button = (attribute, name, label) => html`<button type="button" class="icon-button" ${attribute} ${uiAttributes(label)}>${icon(name)}</button>`;
const opt = (value, label, selected) => html`<option value="${esc(value)}"${value === selected ? " selected" : ""}>${esc(label)}</option>`;
const uiOpt = (value, label, selected) => html`<option value="${esc(value)}"${value === selected ? " selected" : ""}>${uiText(label)}</option>`;
const date = (value) => new Date(value).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
const status = (value) => html`<span class="status-label ${String(value).toLowerCase().replaceAll(" ", "-")}">${uiText(value)}</span>`;
const ruleTriggers = { created: "Record created", updated: "Record updated", deleted: "Record deleted" };
const get = (object, path) => path.split(".").reduce((value, key) => value?.[key], object);
function set(object, path, value) {
  const parts = path.split(".");
  const key = parts.pop();
  const parent = parts.reduce((item, part) => {
    if (!Object.hasOwn(item, part)) Object.defineProperty(item, part, { value: {}, writable: true, enumerable: true, configurable: true });
    return item[part];
  }, object);
  if (value === undefined) delete parent[key]; else Object.defineProperty(parent, key, { value, writable: true, enumerable: true, configurable: true });
}

export function initWorkspace({ api, icons, toast, getState, refresh, navigate, showView, getDraft, onDraftChanged, deleteForm, deleteSpace }) {
  const $ = (id) => document.getElementById(id);
  const formulas = initFormulaEditor({ api, icons, getState });
  let rules = [], tasks = [], runs = [], errors = [], editor, editorKind, busy = false, aiTab = "tasks";
  let configurationRequest = 0, viewRequest = 0;
  const ruleTabs = new Map();
  let navEditor, previewContext;
  const errorFilter = { status: "Unresolved", formId: "", category: "", from: "", to: "" };
  const collapsed = new Set();
  const current = () => getState();
  const canManage = () => Boolean(current().user && current().permissions?.manageForms);
  const requireManagement = () => {
    if (canManage()) return true;
    toast("Administrator access is required.", true);
    return false;
  };
  const ruleTab = () => ruleTabs.get(current().form?.id) ?? "created";
  const form = (id) => current().forms.find((form) => form.id === id);
  const options = (selected, exclude) => current().forms.filter((item) => item.id !== exclude).map((item) => opt(item.id, item.name, selected)).join("");
  const title = (row, table) => {
    const key = table.fields.find((field) => field.unique) ?? table.fields[0];
    return String(row.values[key?.id] ?? row.id.slice(0, 8));
  };
  const newCondition = (table) => ({ fieldId: table?.fields[0]?.id ?? "", operator: "eq", value: { kind: "literal", value: table?.fields[0]?.type === "number" ? 0 : table?.fields[0]?.type === "checkbox" ? false : "" } });
  const dialog = document.createElement("dialog");
  dialog.className = "modal workspace-dialog";
  dialog.innerHTML = html`<div class="modal-heading"><h2 id="workflow-editor-title">Automation</h2><div class="workflow-header-tools">${languagePicker()}${button('id="workflow-editor-close"', "x", "Close editor")}</div></div><div id="workflow-editor-body"></div><div class="form-error" id="workflow-editor-error" role="alert" hidden></div><div class="modal-actions"><button type="button" class="button button-secondary" id="workflow-editor-cancel">Cancel</button><button type="button" class="button button-primary" id="workflow-editor-save">${icon("check")}<span>Save</span></button></div>`;
  document.body.append(dialog);
  const navDialog = document.createElement("dialog");
  navDialog.className = "modal compact-dialog";
  navDialog.innerHTML = html`<form id="node-editor-form"><div class="modal-heading"><h2 id="node-editor-title">New node</h2>${button('data-node-close', "x", "Close navigation editor")}</div>
    <div class="form-fields"><label class="input-field" id="node-kind-row"><span class="builder-label">Type</span><select id="node-kind"><option value="node">Node</option><option value="form">Form</option></select></label><label class="input-field"><span class="builder-label">Name</span><input id="node-name" maxlength="80" required></label><label class="input-field" id="node-parent-row"><span class="builder-label">Parent node</span><select id="node-parent"></select></label><label class="input-field" id="node-position-row"><span class="builder-label">Sort position</span><input id="node-position" type="number" min="0" step="1"></label></div>
    <div class="form-error" id="node-error" role="alert" hidden></div><div class="modal-actions">${button('id="node-delete"', "trash-2", "Delete empty node")}<button class="button button-primary" type="submit">${icon("check")}<span>Save</span></button></div></form>`;
  document.body.append(navDialog);
  const review = document.createElement("dialog");
  review.className = "modal workspace-dialog";
  review.innerHTML = html`<div class="modal-heading"><h2 id="workflow-review-title">Run details</h2>${button('data-review-close', "x", "Close details")}</div><div id="workflow-review-body"></div><div class="form-error" id="workflow-review-error" role="alert" hidden></div><div class="modal-actions"><button class="button button-secondary" id="workflow-review-test" hidden>${icon("play")}<span>Preview changes</span></button><button class="button button-primary" id="workflow-review-apply" hidden>${icon("check")}<span>Apply result</span></button></div>`;
  document.body.append(review);
  const notifications = document.createElement("dialog");
  notifications.className = "modal";
  notifications.innerHTML = html`<div class="modal-heading"><h2>Notifications</h2>${button('data-notifications-close', "x", "Close notifications")}</div><div class="section-heading"><h3>Latest</h3><button class="icon-button" id="notification-rule-new" title="New notification rule" aria-label="New notification rule">${icon("bell-plus")}</button></div><button class="button button-secondary" id="notification-rules-open">Notification rules</button><div id="notification-items"></div>`;
  document.body.append(notifications);
  const nodes = () => current().navigation ?? [];
  const navigationDrag = initNavigationDrag({
    root: $("module-navigation"), getNodes: nodes, canMove: canManage,
    async onMove(id, drop) {
      if (!requireManagement()) return;
      const spaceId = current().space.id;
      const result = await api(`/api/nodes/${id}/move`, { method: "POST", body: JSON.stringify(drop) });
      if (current().space?.id !== spaceId) return;
      current().navigation = result.navigation;
      if (drop.placement === "inside") collapsed.delete(drop.targetId);
      renderNavigation();
      toast("Navigation order saved.");
    },
    onError: (error) => toast(error.message, true),
  });

  function renderNavigation() {
    const state = current();
    if (!$("space-selector")) {
      const host = document.createElement("div");
      host.className = "space-picker";
      host.innerHTML = html`<select id="space-selector" aria-label="Current Space"></select>${button('id="space-new"', "plus", "Create Space")}${button('id="space-delete"', "trash-2", "Delete Space")}`;
      document.querySelector(".sidebar-label").replaceWith(host);
      const tools = document.createElement("div");
      tools.className = "tree-tools";
      tools.innerHTML = html`<span class="sidebar-label">FORMS</span>${button('id="tree-new"', "plus", "New node or form")}`;
      host.after(tools);
      const fixed = document.createElement("nav");
      fixed.id = "space-tools";
      fixed.innerHTML = html`<button class="nav-item space-tool" data-workspace-view="meeting-tasks">${icon("clipboard-list")}<span>Meeting to tasks</span></button><button class="nav-item space-tool" data-workspace-view="orders">${icon("shopping-bag")}<span>Order management</span></button><button class="nav-item space-tool" data-workspace-view="inventory-dashboard">${icon("chart-no-axes-combined")}<span>Inventory analysis</span></button><button class="nav-item space-tool" data-workspace-view="warehouse-flows">${icon("warehouse")}<span>Warehouse workflows</span></button><button class="nav-item space-tool" data-workspace-view="ai-tasks">${icon("sparkles")}<span>AI tasks</span></button><button class="nav-item space-tool" data-workspace-view="errors">${icon("circle-alert")}<span>Error Center</span><span class="nav-count" id="space-error-count"></span></button>`;
      $("module-navigation").after(fixed);
      $("tree-new").onclick = () => openNode(null, null);
      $("space-new").onclick = () => openNode(null, null, true);
      $("space-delete").classList.add("action-delete");
      $("space-delete").onclick = () => { if (requireManagement()) deleteSpace(current().space.id); };
      $("space-selector").onchange = async () => {
        try {
          const spaceId = $("space-selector").value;
          const data = await api(`/api/forms?spaceId=${spaceId}`);
          if ($("space-selector").value !== spaceId) return;
          const view = spaceId === current().orders?.spaceId ? "orders"
            : spaceId === current().meetingTasks?.spaceId ? "meeting-tasks" : "records";
          await navigate(data[0]?.id ?? null, view, null, spaceId);
        } catch (error) { toast(error.message, true); }
      };
    }
    $("space-selector").innerHTML = (state.spaces ?? []).map((space) =>
      opt(space.id, space.name, state.space?.id)).join("");
    $("space-new").hidden = !canManage();
    $("space-delete").hidden = !canManage();
    $("space-delete").disabled = (state.spaces ?? []).length <= 1;
    setUIAttribute($("space-delete"), "title", $("space-delete").disabled ? "Keep at least one Space." : "Delete Space");
    $("tree-new").hidden = !canManage();
    $("space-error-count").textContent = state.errorCount || "";
    $("space-tools").querySelectorAll("[data-workspace-view]").forEach(button => {
      const view = button.dataset.workspaceView;
      button.hidden = view === "meeting-tasks" ? !state.meetingTasks?.enabled
        : view === "orders" ? !state.orders?.enabled
        : ["inventory-dashboard", "warehouse-flows"].includes(view) && Boolean(state.meetingTasks?.enabled || state.orders?.enabled);
      const selected = button.dataset.workspaceView === state.view;
      button.classList.toggle("is-active", selected);
      if (selected) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
    });
    function branch(parentId, depth) {
      return nodes().filter((node) => (node.parentId ?? null) === parentId).map((node) => {
        const table = node.formId ? form(node.formId) : null;
        const isNode = node.kind === "node", closed = collapsed.has(node.id);
        return html`<div class="tree-entry" data-tree-entry="${node.id}"><div class="tree-row" data-tree-id="${node.id}">
          ${canManage() ? html`<button type="button" class="icon-button tree-drag-handle" data-tree-drag="${node.id}" ${uiAttributes(`Move ${node.name}`)}>${icon("grip-vertical")}</button>` : html`<span class="tree-spacer"></span>`}
          ${isNode ? button(`data-tree-toggle="${node.id}" aria-expanded="${!closed}"`, closed ? "chevron-right" : "chevron-down", `${closed ? "Expand" : "Collapse"} ${node.name}`) : html`<span class="tree-spacer"></span>`}
          <button class="nav-item${table?.id === state.form?.id && state.view === "records" ? " is-active" : ""}" title="${esc(node.name)}" ${isNode ? `data-tree-toggle="${node.id}"` : `data-table="${node.formId}"`}>${icon(isNode ? "folder" : "table-2")}<span>${esc(node.name)}</span>${table ? html`<span class="nav-count">${table.recordCount}</span>` : ""}</button>
          ${canManage() ? html`<span class="tree-actions">${isNode ? button(`data-tree-new="${node.id}"`, "plus", `New in ${node.name}`) : ""}${button(`data-tree-edit="${node.id}"`, "ellipsis", `Edit ${node.name}`)}</span>` : ""}</div>${isNode && !closed ? html`<div class="tree-branch">${branch(node.id, depth + 1)}</div>` : ""}</div>`;
      }).join("");
    }
    $("module-navigation").innerHTML = branch(null, 0) + (canManage() ? html`<div class="tree-root-drop" data-tree-root-drop>${icon("corner-up-left")}<span>Space root</span></div>` : "");
    icons();
  }
  function openNode(id, parentId, space = false) {
    if (!requireManagement()) return;
    const node = id ? nodes().find((node) => node.id === id) : null;
    navEditor = { node, space, parentId };
    setUIText($("node-editor-title"), space ? "Create Space" : node ? "Edit navigation" : "New node or form");
    $("node-kind-row").hidden = Boolean(node) || space;
    $("node-parent-row").hidden = space;
    $("node-position-row").hidden = !node;
    $("node-position").value = node?.position ?? 0;
    $("node-kind").value = "node";
    $("node-name").value = node?.name ?? "";
    $("node-name").disabled = Boolean(node?.formId && form(node.formId)?.readOnly);
    $("node-parent").innerHTML = uiOpt("", "Space root", "") + nodes().filter((item) => item.kind === "node" && item.id !== id).map((item) => opt(item.id, item.name, node?.parentId ?? parentId)).join("");
    $("node-delete").hidden = !node || Boolean(node.formId && form(node.formId)?.readOnly);
    setUIAttribute($("node-delete"), "title", node?.kind === "form" ? "Delete form" : "Delete empty node");
    setUIAttribute($("node-delete"), "aria-label", node?.kind === "form" ? "Delete form" : "Delete empty node");
    $("node-error").hidden = true;
    navDialog.showModal(); $("node-name").focus(); icons();
  }
  $("node-editor-form").onsubmit = async (event) => {
    event.preventDefault();
    if (!requireManagement()) return;
    const submit = event.submitter;
    submit.disabled = true; $("node-error").hidden = true;
    try {
      const name = $("node-name").value, parentId = $("node-parent").value || null;
      if (navEditor.space) {
        const space = await api("/api/spaces", { method: "POST", body: JSON.stringify({ name }) });
        const forms = await api(`/api/forms?spaceId=${space.id}`);
        await navigate(forms[0].id);
      } else if (navEditor.node) {
        await api(`/api/nodes/${navEditor.node.id}`, { method: "PATCH", body: JSON.stringify({ name, parentId, position: Number($("node-position").value) }) }); await refresh();
      } else if ($("node-kind").value === "form") {
        const table = await api("/api/forms", { method: "POST", body: JSON.stringify({ name, parentId, spaceId: current().space.id }) });
        await navigate(table.id);
      } else { await api("/api/nodes", { method: "POST", body: JSON.stringify({ name, parentId, spaceId: current().space.id }) }); await refresh(); }
      navDialog.close();
    } catch (error) { setUIText($("node-error"), error.message); $("node-error").hidden = false; }
    finally { submit.disabled = false; }
  };
  $("node-delete").onclick = async () => {
    if (!requireManagement()) return;
    if (navEditor.node.kind === "form") {
      const id = navEditor.node.formId;
      navDialog.close();
      deleteForm(id); return;
    }
    if (!window.confirm(t("Delete this empty node?"))) return;
    try { await api(`/api/nodes/${navEditor.node.id}`, { method: "DELETE" }); navDialog.close(); await refresh(); }
    catch (error) { $("node-error").hidden = false; setUIText($("node-error"), error.message); }
  };

  function sourceForm() { return form(editor.formId); }
  function conditionSummary(condition) {
    const field = sourceForm()?.fields.find((item) => item.id === condition.fieldId);
    const labels = { eq: "Equals", ne: "Not equal", gt: ">", gte: ">=", lt: "<", lte: "<=", is_empty: "Is empty", not_empty: "Not empty", contains: "Contains", changed: "Changed" };
    let value = "";
    if (!["is_empty", "not_empty", "changed"].includes(condition.operator)) {
      const input = condition.value;
      if (input?.kind === "literal") {
        const reference = field?.type === "reference" ? current().references.find((table) => table.id === field.reference.formId) : null;
        const row = reference?.records.find((row) => row.id === input.value);
        value = input.value == null ? uiText("Not set") : esc(row ? row.values[field.reference.fieldId] : String(input.value));
      } else if (input?.kind === "formula") value = esc(input.formula.expression);
      else if (input?.kind === "empty") value = uiText("Not set");
      else if (input?.kind === "field") {
        const table = form(input.formId) ?? sourceForm();
        value = `${esc(table?.name)} / ${esc(table?.fields.find((item) => item.id === input.fieldId)?.name ?? input.fieldId)}`;
      }
    }
    return `${esc(field?.name ?? condition.fieldId)} ${uiText(labels[condition.operator] ?? condition.operator)} ${value}`;
  }
  function triggerConditionsUI() {
    const builder = editor.conditionBuilder;
    return html`<div class="condition-composer"><div class="condition-composer-heading"><span class="builder-label">Saved conditions</span><button type="button" class="button button-secondary" id="condition-new"${editor.conditionDraft ? " disabled" : ""}>${icon("plus")}<span>New condition</span></button></div>
      <div class="condition-tiles">${builder.conditions.length ? builder.conditions.map((item) => html`<div class="condition-tile"><button type="button" class="condition-tile-value" data-insert-condition="${item.id}" title="Insert condition"><strong>${item.id}</strong><span>${conditionSummary(item.condition)}</span></button><div class="condition-tile-tools">${button(`data-edit-condition="${item.id}"`, "pencil", "Edit condition")}${button(`data-delete-condition="${item.id}"`, "trash-2", "Delete condition")}</div></div>`).join("") : html`<p class="muted condition-empty">No saved conditions</p>`}</div>
      ${editor.conditionDraft ? html`<div class="condition-draft"><div class="section-heading"><h3>${editor.conditionDraft.id ?? uiText("New condition")}</h3></div>${conditionUI(editor.conditionDraft.condition, "conditionDraft.condition", sourceForm())}<div class="condition-draft-actions">${button('id="condition-cancel"', "x", "Cancel condition edit")}<button type="button" class="button button-secondary" id="condition-save">${icon("check")}<span>${uiText(editor.conditionDraft.id ? "Update condition" : "Save condition")}</span></button></div></div>` : ""}
      <label class="input-field"><span class="builder-label">Logical expression</span><textarea class="condition-expression" id="condition-expression" rows="2" maxlength="2000" spellcheck="false" aria-label="Condition expression">${esc(builder.expression)}</textarea></label><div class="condition-logic-toolbar">${["AND", "OR", "NOT", "(", ")"].map((token) => html`<button type="button" class="condition-logic-token" data-condition-token="${token}" title="Insert ${token}">${token}</button>`).join("")}${button('id="condition-expression-clear"', "eraser", "Clear expression")}</div><div id="condition-expression-status" class="condition-expression-status" role="status"></div></div>`;
  }
  function conditionStatus(edited = false) {
    if (editorKind !== "rule" || !$("condition-expression-status")) return;
    if (edited) $("workflow-editor-error").hidden = true;
    try {
      const result = compileConditions(editor.conditionBuilder);
      setUIText($("condition-expression-status"), result ? "Expression valid" : "No trigger filter");
      $("condition-expression-status").classList.remove("is-invalid");
      $("condition-expression").setAttribute("aria-invalid", "false");
    } catch (error) {
      setUIText($("condition-expression-status"), error.message);
      $("condition-expression-status").classList.add("is-invalid");
      $("condition-expression").setAttribute("aria-invalid", "true");
    }
  }
  function insertConditionToken(token) {
    const input = $("condition-expression"), start = input.selectionStart, end = input.selectionEnd;
    input.setRangeText(`${start && !/\s|\(/.test(input.value[start - 1]) ? " " : ""}${token} `, start, end, "end");
    editor.conditionBuilder.expression = input.value;
    input.focus(); conditionStatus(true);
  }
  function conditionUI(condition, path, target) {
    if (!condition) return html`<button type="button" class="button button-secondary" data-condition-add="${path}" data-target-form="${target?.id}">${icon("list-filter")}<span>Add condition</span></button>`;
    if (condition.op) return html`<div class="condition-group"><div class="condition-group-head"><select data-edit-path="${path}.op" aria-label="Logical operator">${["AND", "OR", "NOT"].map((value) => opt(value, value, condition.op)).join("")}</select>${condition.op !== "NOT" ? button(`data-condition-child="${path}" data-target-form="${target?.id}"`, "plus", "Add condition") + button(`data-condition-group="${path}" data-target-form="${target?.id}"`, "group", "Add group") : ""}${button(`data-condition-remove="${path}"`, "x", "Remove group")}</div>${condition.conditions.map((item, index) => conditionUI(item, `${path}.conditions.${index}`, target)).join("")}</div>`;
    const field = target?.fields.find((field) => field.id === condition.fieldId);
    const ops = ["eq", "ne", "is_empty", "not_empty", ...(field?.type === "number" || ["date", "datetime"].includes(field?.type) ? ["gt", "gte", "lt", "lte"] : []), ...(["text", "longtext", "select"].includes(field?.type) ? ["contains"] : []), "changed"];
    const labels = { eq: "Equals", ne: "Not equal", gt: ">", gte: ">=", lt: "<", lte: "<=", is_empty: "Is empty", not_empty: "Not empty", contains: "Contains", changed: "Changed" };
    return html`<div class="condition-leaf"><select data-edit-path="${path}.fieldId" data-condition-field data-target-form="${target?.id}" aria-label="Filter field">${(target?.fields ?? []).map((item) => opt(item.id, item.name, condition.fieldId)).join("")}</select><select data-edit-path="${path}.operator" aria-label="Comparison">${ops.map((value) => uiOpt(value, labels[value], condition.operator)).join("")}</select>${["is_empty", "not_empty", "changed"].includes(condition.operator) ? html`<span></span>` : valueUI(condition.value, `${path}.value`, field, target)}${path === "conditionDraft.condition" ? "" : button(`data-condition-remove="${path}"`, "x", "Remove condition")}</div>`;
  }
  function literalUI(value, path, field) {
    if (field?.type === "reference") {
      const table = current().references.find((item) => item.id === field.reference.formId);
      return html`<select data-edit-path="${path}.value" aria-label="Reference value">${uiOpt("", "Not set", value ?? "")}${(table?.records ?? []).map((row) => opt(row.id, row.values[field.reference.fieldId], value)).join("")}</select>`;
    }
    if (field?.type === "select") return html`<select data-edit-path="${path}.value" aria-label="Dropdown value">${uiOpt("", "Not set", value ?? "")}${field.options.map((item) => opt(item, item, value)).join("")}</select>`;
    if (field?.type === "checkbox") return html`<select data-edit-path="${path}.value" data-boolean aria-label="Boolean value">${uiOpt("true", "True", String(value))}${uiOpt("false", "False", String(value))}</select>`;
    const type = field?.type === "number" ? "number" : field?.type === "date" ? "date" : field?.type === "datetime" ? "datetime-local" : "text";
    return html`<input type="${type}" step="any" data-edit-path="${path}.value"${type === "number" ? " data-number" : ""} value="${esc(value ?? "")}" aria-label="Assignment value">`;
  }
  function valueUI(value, path, field, target, keep = false) {
    const kind = value?.kind ?? (keep ? "keep" : "literal");
    let content = "";
    if (kind === "literal") content = literalUI(value?.value, path, field);
    if (kind === "formula") content = html`<span class="value-formula"><code>${value?.formula?.expression ? esc(value.formula.expression) : uiText("No formula")}</code>${button(`data-edit-formula="${path}" data-target-form="${target?.id}"`, "function-square", "Edit assignment formula")}</span>`;
    if (kind === "field") {
      const selectedForm = form(value.formId) ?? (value.scope === "target" || value.scope === "output" ? target : sourceForm());
      const scopes = selectedForm?.id === sourceForm()?.id ? [["source", "Trigger: after"], ["before", "Trigger: before"], ...(selectedForm?.id === target?.id ? [["target", "Current target"], ...(editorKind === "task" ? [["output", "AI output"]] : [])] : []), ["lookup", "Latest record"], ["aggregate", "Aggregate"]]
        : selectedForm?.id === target?.id ? [["target", "Current target"], ...(editorKind === "task" ? [["output", "AI output"]] : []), ["lookup", "Latest record"], ["aggregate", "Aggregate"]] : [["lookup", "Latest record"], ["aggregate", "Aggregate"]];
      content = html`<select data-edit-path="${path}.formId" data-value-form data-value-path="${path}" data-target-form="${target?.id}" aria-label="Value source form">${options(selectedForm?.id)}</select><select data-edit-path="${path}.scope" data-rebuild aria-label="Value record scope">${scopes.map(([key, label]) => uiOpt(key, label, value.scope)).join("")}</select><select data-edit-path="${path}.fieldId" aria-label="Value source field">${(selectedForm?.fields ?? []).map((item) => opt(item.id, item.name, value.fieldId)).join("")}</select>
        ${["lookup", "aggregate"].includes(value.scope) ? html`<select data-edit-path="${path}.${value.scope === "aggregate" ? "aggregate" : "selection"}" aria-label="Lookup selection">${(value.scope === "aggregate" ? ["SUM", "COUNT", "MIN", "MAX"] : ["first", "unique"]).map((mode) => opt(mode, mode, value.aggregate ?? value.selection ?? "first")).join("")}</select>${conditionUI(value.condition, `${path}.condition`, selectedForm)}` : ""}`;
    }
    return html`<div class="value-editor"><select data-value-kind="${path}" data-target-field="${field?.id}" data-target-form="${target?.id}" aria-label="Value mode">${(keep ? [["keep", "Keep"]] : []).concat([["literal", "Value"], ["field", "Field"], ["formula", "Formula"], ...(!field?.required ? [["empty", "Set empty"]] : [])]).map(([key, label]) => uiOpt(key, label, kind)).join("")}</select><div class="value-fields">${content}</div></div>`;
  }
  function assignmentsUI(assignments, path, target) {
    return (target?.fields ?? []).map((field) => html`<div class="assignment-row"><span>${esc(field.name)}${field.required ? " *" : ""}<small>${uiText(field.formula ? "Calculated" : field.type)}</small></span>${field.formula ? html`<span class="muted">Automatic</span>` : valueUI(assignments?.[field.id], `${path}.${field.id}`, field, target, true)}</div>`).join("");
  }
  function removeCondition(path) {
    const parts = path.split(".");
    if (parts.at(-2) !== "conditions") return set(editor, path, null);
    const index = Number(parts.pop()), siblings = get(editor, parts.join("."));
    siblings.splice(index, 1);
    if (!siblings.length) removeCondition(parts.slice(0, -1).join("."));
  }
  function editorRender() {
    setUIText($("workflow-editor-title"), editorKind === "task" ? "AI task" : "Notification rule");
    const source = sourceForm(), target = form(editor.outputFormId);
    $("workflow-editor-body").innerHTML = html`${editorKind === "rule" ? html`<div class="workflow-rule-context"><div><span class="builder-label">Source form</span><strong>${esc(source?.name)}</strong></div><div><span class="builder-label">Trigger</span><strong>${uiText(ruleTriggers[editor.trigger])}</strong></div></div>` : ""}<div class="workflow-editor-grid"><label class="input-field"><span class="builder-label">Name</span><input data-edit-path="name" maxlength="100" value="${esc(editor.name)}"></label>
      ${editorKind === "rule" ? html`<label class="rule-control"><input type="checkbox" data-edit-path="enabled"${editor.enabled ? " checked" : ""}> Enabled</label>${editor.trigger === "updated" ? html`<label class="input-field full-width"><span class="builder-label">Watched fields</span><select multiple data-edit-path="watchedFields" aria-label="Watched fields">${(source?.fields ?? []).map((field) => html`<option value="${field.id}"${editor.watchedFields.includes(field.id) ? " selected" : ""}>${esc(field.name)}</option>`).join("")}</select></label>` : ""}<div class="full-width"><span class="builder-label">Trigger conditions</span>${triggerConditionsUI()}</div>` :
        html`<label class="input-field"><span class="builder-label">Source form</span><select data-edit-path="formId" data-source-form${editor.id ? " disabled" : ""}>${options(editor.formId)}</select></label>` +
        html`<label class="input-field"><span class="builder-label">Output form</span><select data-edit-path="outputFormId" data-task-target>${options(editor.outputFormId)}</select></label><label class="input-field"><span class="builder-label">Apply mode</span><select data-edit-path="mode">${uiOpt("review", "Review results", editor.mode)}${uiOpt("auto", "Automatically apply valid results", editor.mode)}</select></label>
        <div class="full-width"><span class="builder-label">Input fields</span><div class="choice-grid">${(source?.fields ?? []).map((field) => html`<label><input type="checkbox" data-field-choice="inputFields" value="${field.id}"${editor.inputFields.includes(field.id) ? " checked" : ""}>${esc(field.name)}</label>`).join("")}</div></div>
        <label class="input-field full-width"><span class="builder-label">Processing instructions</span><textarea data-edit-path="instructions" maxlength="12000" rows="5">${esc(editor.instructions)}</textarea></label>
        <label class="input-field"><span class="builder-label">Model</span><select data-edit-path="model" id="task-model-picker">${uiOpt("", `Provider default${current().ai.model ? `: ${current().ai.model}` : ""}`, editor.model)}${editor.model ? opt(editor.model, editor.model, editor.model) : ""}</select></label><div class="input-field"><span class="builder-label">Provider models</span><button type="button" class="button button-secondary" id="task-fetch-models">${icon("refresh-cw")}<span>Fetch models</span></button></div>
        <div class="full-width"><span class="builder-label">Structured output fields</span><div class="choice-grid">${(target?.fields ?? []).filter((field) => !field.formula && field.type !== "attachment").map((field) => html`<label><input type="checkbox" data-field-choice="outputFields" value="${field.id}"${editor.outputFields.includes(field.id) ? " checked" : ""}>${esc(field.name)}</label>`).join("")}</div></div>
        <label class="input-field"><span class="builder-label">Result action</span><select data-edit-path="action" data-rebuild>${[["create", "Create records"], ["update", "Update records"], ["delete", "Delete records"]].map(([value, text]) => uiOpt(value, text, editor.action)).join("")}</select></label>
        ${editor.action === "create" ? "" : html`<label class="input-field"><span class="builder-label">Matches per result</span><select data-edit-path="selection">${uiOpt("first", "First match", editor.selection)}${uiOpt("all", "All matches", editor.selection)}</select></label><div class="full-width">${conditionUI(editor.condition, "condition", target)}</div>`}
        <div class="full-width"><div class="section-heading"><h3>Assignment overrides</h3></div>${assignmentsUI(editor.assignments, "assignments", target)}</div>`}</div>
      ${editorKind === "rule" ? html`<label class="input-field"><span class="builder-label">Notification message</span><input data-edit-path="actions.0.message" maxlength="500" value="${esc(editor.actions[0].message)}"></label>` : ""}`;
    conditionStatus(); icons();
  }
  async function editRule(id, notify = false) {
    if (!requireManagement()) return;
    if (!await fetchConfiguration()) return;
    let existing = id ? rules.find((rule) => rule.id === id) : null;
    if (id && !existing) {
      // Error Center can link to a rule owned by another form in this Space.
      const spaceId = current().space.id;
      existing = (await api(`/api/notification-rules?${new URLSearchParams({ spaceId })}`)).find((rule) => rule.id === id);
      if (current().space.id !== spaceId) return;
      if (!existing) throw new Error("Automation not found.");
      await navigate(existing.formId, "notifications-rules");
      if (current().form.id !== existing.formId) return;
      await enter("notifications-rules");
    }
    editorKind = "rule";
    editor = existing ? structuredClone(existing) : { name: "", formId: current().form.id, trigger: Object.hasOwn(ruleTriggers, ruleTab()) ? ruleTab() : "created", enabled: true, watchedFields: [], condition: null, actions: [{ type: "notify", message: "" }] };
    if (notify && !id) { editor.name = "Stock alert"; editor.trigger = "updated"; editor.condition = newCondition(current().form); }
    editor.conditionBuilder ??= conditionBuilderFrom(editor.condition);
    $("workflow-editor-error").hidden = true; editorRender(); dialog.showModal();
  }
  async function editTask(id) {
    if (!requireManagement()) return;
    if (!current().form) return toast("Create a form before configuring an AI task.", true);
    if (!await fetchConfiguration()) return;
    editorKind = "task";
    const output = current().forms.find((table) => table.id !== current().form.id) ?? current().form;
    editor = id ? structuredClone(tasks.find((task) => task.id === id)) : { name: "", formId: current().form.id, outputFormId: output.id, instructions: "", inputFields: current().form.fields.map((field) => field.id), outputFields: output.fields.filter((field) => !field.formula && field.type !== "attachment").map((field) => field.id),
      action: "create", mode: "review", model: "", assignments: {}, condition: null, selection: "first", noMatch: "error" };
    $("workflow-editor-error").hidden = true; editorRender(); dialog.showModal();
  }
  dialog.addEventListener("input", (event) => {
    if (event.target.id === "condition-expression") { editor.conditionBuilder.expression = event.target.value; conditionStatus(true); return; }
    const input = event.target.closest("[data-edit-path]");
    if (!input) return;
    const value = input.multiple ? [...input.selectedOptions].map((option) => option.value) : input.type === "checkbox" ? input.checked
      : input.hasAttribute("data-number") ? input.value === "" ? null : Number(input.value) : input.hasAttribute("data-boolean") ? input.value === "true" : input.value;
    set(editor, input.dataset.editPath, value);
  });
  dialog.addEventListener("change", (event) => {
    const input = event.target;
    if (input.dataset.fieldChoice) {
      editor[input.dataset.fieldChoice] = [...dialog.querySelectorAll(`[data-field-choice="${input.dataset.fieldChoice}"]:checked`)].map((input) => input.value);
    }
    const mode = input.dataset.valueKind;
    if (mode) {
      const target = form(input.dataset.targetForm), field = target?.fields.find((field) => field.id === input.dataset.targetField);
      set(editor, mode, input.value === "keep" ? undefined : input.value === "empty" ? { kind: "empty" } : input.value === "formula" ? { kind: "formula", formula: { expression: "", bindings: {} } }
        : input.value === "field" ? { kind: "field", scope: "source", formId: sourceForm().id, fieldId: sourceForm().fields[0].id }
          : { kind: "literal", value: field?.type === "number" ? 0 : field?.type === "checkbox" ? false : "" });
      editorRender(); return;
    }
    if (input.hasAttribute("data-value-form")) {
      const value = get(editor, input.dataset.valuePath), selected = form(input.value), target = form(input.dataset.targetForm);
      value.scope = selected.id === editor.formId ? "source" : selected.id === target?.id ? "target" : "lookup";
      value.fieldId = selected.fields[0].id; delete value.condition; delete value.aggregate;
      editorRender(); return;
    }
    if (input.hasAttribute("data-source-form")) {
      editor.condition = null;
      if (editorKind === "rule") { editor.conditionBuilder = conditionBuilderFrom(null); delete editor.conditionDraft; }
      if (editorKind === "rule") { editor.actions = [{ type: "notify", message: "" }]; editor.watchedFields = []; }
      else editor.inputFields = sourceForm().fields.map((field) => field.id);
      editorRender(); return;
    }
    if (input.hasAttribute("data-task-target")) {
      editor.condition = null; editor.assignments = {};
      editor.outputFields = form(input.value).fields.filter((field) => !field.formula && field.type !== "attachment").map((field) => field.id);
      editorRender(); return;
    }
    if (input.hasAttribute("data-condition-field")) {
      const path = input.dataset.editPath.replace(/\.fieldId$/, "");
      const target = form(input.dataset.targetForm), field = target?.fields.find((field) => field.id === input.value);
      set(editor, `${path}.operator`, "eq"); set(editor, `${path}.value`, { kind: "literal", value: field?.type === "number" ? 0 : field?.type === "checkbox" ? false : "" }); editorRender(); return;
    }
    if (input.dataset.editPath?.endsWith(".op")) {
      const group = get(editor, input.dataset.editPath.replace(/\.op$/, ""));
      if (group.op === "NOT") group.conditions = group.conditions.slice(0, 1);
      editorRender(); return;
    }
    if (input.hasAttribute("data-rebuild") || input.dataset.editPath?.endsWith(".operator")) editorRender();
  });
  dialog.addEventListener("click", async (event) => {
    const control = event.target.closest("button");
    if (control?.id === "condition-new") { editor.conditionDraft = { condition: newCondition(sourceForm()) }; editorRender(); return; }
    if (control?.id === "condition-cancel") { delete editor.conditionDraft; editorRender(); return; }
    if (control?.id === "condition-save") {
      const draft = editor.conditionDraft;
      if (draft.id) editor.conditionBuilder.conditions.find((item) => item.id === draft.id).condition = structuredClone(draft.condition);
      else {
        if (editor.conditionBuilder.conditions.length >= 30) { toast("Use up to 30 saved conditions and a valid logical expression.", true); return; }
        const next = Math.max(0, ...editor.conditionBuilder.conditions.map((item) => Number(item.id.slice(1)))) + 1;
        editor.conditionBuilder.conditions.push({ id: `C${next}`, condition: structuredClone(draft.condition) });
      }
      delete editor.conditionDraft; editorRender(); return;
    }
    if (control?.dataset.editCondition) { editor.conditionDraft = structuredClone(editor.conditionBuilder.conditions.find((item) => item.id === control.dataset.editCondition)); editorRender(); return; }
    if (control?.dataset.deleteCondition) {
      const id = control.dataset.deleteCondition;
      if ((editor.conditionBuilder.expression.match(/C\d+/gi) ?? []).some((token) => token.toUpperCase() === id)) { toast(`Remove ${id} from the expression before deleting it.`, true); return; }
      editor.conditionBuilder.conditions = editor.conditionBuilder.conditions.filter((item) => item.id !== id);
      if (editor.conditionDraft?.id === id) delete editor.conditionDraft;
      editorRender(); return;
    }
    if (control?.dataset.insertCondition || control?.dataset.conditionToken) { insertConditionToken(control.dataset.insertCondition ?? control.dataset.conditionToken); return; }
    if (control?.id === "condition-expression-clear") { editor.conditionBuilder.expression = ""; $("condition-expression").value = ""; conditionStatus(true); return; }
    const add = event.target.closest("[data-condition-add]"), child = event.target.closest("[data-condition-child]"), group = event.target.closest("[data-condition-group]"), remove = event.target.closest("[data-condition-remove]");
    if (add) { set(editor, add.dataset.conditionAdd, { op: "AND", conditions: [newCondition(form(add.dataset.targetForm))] }); editorRender(); }
    if (child || group) {
      const input = child ?? group, path = input.dataset.conditionChild ?? input.dataset.conditionGroup;
      get(editor, path).conditions.push(child ? newCondition(form(input.dataset.targetForm)) : { op: "AND", conditions: [newCondition(form(input.dataset.targetForm))] });
      editorRender();
    }
    if (remove) {
      removeCondition(remove.dataset.conditionRemove);
      editorRender();
    }
    const editFormula = event.target.closest("[data-edit-formula]");
    if (editFormula) {
      const path = editFormula.dataset.editFormula;
      formulas.open({ mode: "assignment", ai: editorKind === "task", sourceForm: sourceForm(), targetForm: form(editFormula.dataset.targetForm), formula: get(editor, path)?.formula,
        onSave(value) { set(editor, path, value ? { kind: "formula", formula: value } : undefined); editorRender(); } });
    }
    if (event.target.closest("#task-fetch-models")) {
      try {
        const config = await api("/api/ai/config");
        const data = await api("/api/ai/models", { method: "POST", body: JSON.stringify({ providerName: config.providerName, baseUrl: config.baseUrl }) });
        $("task-model-picker").innerHTML = uiOpt("", "Provider default", editor.model) + data.models.map((model) => opt(model, model, editor.model)).join("");
      } catch (error) { setUIText($("workflow-editor-error"), error.message); $("workflow-editor-error").hidden = false; }
    }
  });
  $("workflow-editor-save").onclick = async () => {
    if (!requireManagement()) return;
    if (busy) return;
    busy = true; $("workflow-editor-save").disabled = true; $("workflow-editor-error").hidden = true;
    try {
      if (editorKind === "rule") {
        if (editor.conditionDraft) throw new Error("Save or cancel the condition being edited first.");
        editor.condition = compileConditions(editor.conditionBuilder);
      }
      const base = editorKind === "rule" ? "/api/notification-rules" : "/api/ai-tasks";
      await api(`${base}${editor.id ? `/${editor.id}` : ""}`, { method: editor.id ? "PUT" : "POST", body: JSON.stringify(editor) });
      dialog.close();
      if (editorKind === "rule") ruleTabs.set(editor.formId, editor.trigger);
      await refresh();
      if (editorKind === "rule" && current().form.id !== editor.formId) await navigate(editor.formId, "notifications-rules");
      else showView(editorKind === "rule" ? "notifications-rules" : "ai-tasks");
      toast(editorKind === "rule" ? "Automation saved." : "AI task saved.");
    } catch (error) { setUIText($("workflow-editor-error"), error.message); $("workflow-editor-error").hidden = false; }
    finally { busy = false; $("workflow-editor-save").disabled = false; }
  };
  $("workflow-editor-close").onclick = $("workflow-editor-cancel").onclick = () => { if (!busy) dialog.close(); };
  dialog.addEventListener("cancel", (event) => { if (busy) event.preventDefault(); });
  async function fetchConfiguration() {
    const request = ++configurationRequest;
    const spaceId = current().space?.id ?? "default", formId = current().form?.id;
    const result = await Promise.all([formId ? api(`/api/notification-rules?${new URLSearchParams({ spaceId, formId })}`) : [], api(`/api/ai-tasks?${new URLSearchParams({ spaceId })}`)]);
    if (request !== configurationRequest || current().form?.id !== formId || current().space?.id !== spaceId) return false;
    [rules, tasks] = result;
    return true;
  }
  function changesUI(changes) {
    return html`<div class="run-changes"><table class="data-table"><thead><tr><th>Form / record</th><th>Action</th><th>Before</th><th>After</th></tr></thead><tbody>${changes.map((change) => {
      const table = form(change.formId);
      const entries = (values) => values ? Object.entries(values).map(([key, value]) => html`<div><strong>${esc(table?.fields.find((field) => field.id === key)?.name ?? key)}:</strong> ${esc(value == null ? "(empty)" : typeof value === "object" ? JSON.stringify(value) : value)}</div>`).join("") : "(none)";
      return html`<tr><td>${esc(table?.name ?? change.formId)}<small>${esc(change.recordId?.slice(0, 8))}</small></td><td>${uiText(change.kind)}</td><td>${entries(change.before)}</td><td>${entries(change.after)}</td></tr>`;
    }).join("")}</tbody></table></div>`;
  }
  function renderRules() {
    const tab = ruleTab(), formRules = rules.filter((rule) => rule.formId === current().form.id);
    const items = tab === "runs" ? runs.filter((run) => run.event.formId === current().form.id) : formRules.filter((rule) => rule.trigger === tab);
    $("view-notifications-rules").innerHTML = html`<div class="page-heading"><div><div class="eyebrow workflow-form-name">${esc(current().space?.name)} / ${esc(current().form.name)}</div><h1>Notification rules</h1></div><div class="heading-actions"><button type="button" class="button button-secondary" data-workspace-view="records">${icon("arrow-left")}<span>Back to form</span></button>${tab === "runs" ? "" : html`<button class="button button-primary" data-rule-new>${icon("plus")}<span>Add action</span></button>`}</div></div><div class="workflow-tabbar workflow-trigger-tabs" role="tablist" aria-label="Form automations">${Object.entries(ruleTriggers).map(([value, label]) => html`<button id="rule-tab-${value}" role="tab" aria-controls="rule-tab-panel" data-rule-tab="${value}" aria-selected="${tab === value}" aria-pressed="${tab === value}"><span>${uiText(label)}</span><span class="workflow-tab-count">${formRules.filter((rule) => rule.trigger === value).length}</span></button>`).join("")}<button id="rule-tab-runs" role="tab" aria-controls="rule-tab-panel" data-rule-tab="runs" aria-selected="${tab === "runs"}" aria-pressed="${tab === "runs"}">Run history</button></div><div id="rule-tab-panel" class="workflow-list" role="tabpanel" aria-labelledby="rule-tab-${tab}">
      ${tab !== "runs" ? items.map((rule) => html`<article class="automation-row"><div><h3>${esc(rule.name)} ${status(rule.enabled ? "Enabled" : "Disabled")}</h3><p>${rule.actions.length} ${uiText("actions")}</p></div><div class="row-actions">${button(`data-rule-preview="${rule.id}"`, "play", `Preview ${rule.name}`)}${button(`data-rule-edit="${rule.id}"`, "pencil", `Edit ${rule.name}`)}${button(`data-rule-toggle="${rule.id}"`, rule.enabled ? "pause" : "play", rule.enabled ? "Disable rule" : "Enable rule")}${button(`data-rule-delete="${rule.id}"`, "trash-2", `Delete ${rule.name}`)}</div></article>`).join("")
        : items.map((run) => html`<article class="automation-row"><div><h3>${esc(run.ruleName)}</h3><p>${esc(date(run.createdAt))} · ${uiText(ruleTriggers[run.event.kind] ?? run.event.kind)}</p></div>${button(`data-run-details="${run.id}"`, "external-link", "Run details")}</article>`).join("")}${items.length ? "" : html`<div class="workflow-empty">${uiText(tab === "runs" ? "No runs for this form" : "No rules for this trigger")}</div>`}</div>`;
    if (!canManage()) $("view-notifications-rules").querySelectorAll("[data-rule-new], [data-rule-preview], [data-rule-edit], [data-rule-toggle], [data-rule-delete]").forEach(control => { control.hidden = true; });
    icons();
  }
  function renderTasks(aiRuns = []) {
    $("view-ai-tasks").innerHTML = html`<div class="page-heading"><div><div class="eyebrow">${esc(current().space?.name)}</div><h1>AI tasks</h1></div><button class="button button-primary" data-task-new>${icon("plus")}<span>New task</span></button></div><div class="workflow-tabbar"><button data-ai-tab="tasks" aria-pressed="${aiTab === "tasks"}">Tasks</button><button data-ai-tab="runs" aria-pressed="${aiTab === "runs"}">Runs</button></div><div class="workflow-list">
      ${aiTab === "tasks" ? tasks.map((task) => html`<article class="automation-row"><div><h3>${esc(task.name)}</h3><p>${esc(form(task.formId)?.name)} → ${esc(form(task.outputFormId)?.name)} · ${uiText(task.mode === "review" ? "Review results" : "Automatic")}</p></div><div class="row-actions">${button(`data-task-run="${task.id}"`, "play", `Run ${task.name}`)}${button(`data-task-edit="${task.id}"`, "pencil", `Edit ${task.name}`)}${button(`data-task-delete="${task.id}"`, "trash-2", `Delete ${task.name}`)}</div></article>`).join("")
        : aiRuns.map((run) => html`<article class="automation-row"><div><h3>${esc(run.task.name)} ${status(run.status)}</h3><p>${esc(date(run.createdAt))}${run.error ? ` · ${esc(run.error)}` : ""}</p></div><div class="row-actions">${button(`data-ai-run-details="${run.id}"`, "external-link", "Inspect AI run")}${["Failed", "Stale"].includes(run.status) ? button(`data-ai-retry="${run.id}"`, "rotate-ccw", "Retry AI run") : ""}${["Queued", "Needs review", "Failed", "Stale"].includes(run.status) ? button(`data-ai-cancel="${run.id}"`, "x", "Cancel AI run") : ""}</div></article>`).join("")}</div>`;
    if (!canManage()) $("view-ai-tasks").querySelectorAll("[data-task-new], [data-task-edit], [data-task-delete]").forEach(control => { control.hidden = true; });
    icons();
  }
  function renderErrors() {
    const items = errors.filter((item) => {
      const day = new Date(item.createdAt).toLocaleDateString("en-CA");
      return (errorFilter.status === "all" || item.status === errorFilter.status) && (!errorFilter.formId || item.context.formId === errorFilter.formId) &&
        (!errorFilter.category || item.category === errorFilter.category) && (!errorFilter.from || day >= errorFilter.from) && (!errorFilter.to || day <= errorFilter.to);
    });
    $("view-errors").innerHTML = html`<div class="page-heading"><div><div class="eyebrow">${esc(current().space?.name)}</div><h1>Error Center</h1></div>${button('data-errors-refresh', "refresh-cw", "Refresh errors")}</div>
      <div class="error-filters"><select data-error-filter="status" aria-label="Error status">${["Unresolved", "Resolved", "Ignored", "all"].map((item) => uiOpt(item, item === "all" ? "All statuses" : item, errorFilter.status)).join("")}</select>
      <select data-error-filter="formId" aria-label="Error source form">${uiOpt("", "All forms", errorFilter.formId)}${options(errorFilter.formId)}</select><select data-error-filter="category" aria-label="Error category">${uiOpt("", "All categories", errorFilter.category)}${[...new Set(errors.map((item) => item.category))].map((item) => uiOpt(item, item, errorFilter.category)).join("")}</select>
      <input type="date" data-error-filter="from" value="${esc(errorFilter.from)}" aria-label="Errors from"><input type="date" data-error-filter="to" value="${esc(errorFilter.to)}" aria-label="Errors through"><span class="section-count">${uiText(`${items.length} errors`)}</span></div>
      <div class="table-clip"><table class="data-table"><thead><tr><th>Time</th><th>Source</th><th>Error</th><th>Status</th><th>Actions</th></tr></thead><tbody>${items.map((item) => html`<tr><td>${esc(date(item.createdAt))}</td><td>${form(item.context.formId) ? esc(form(item.context.formId).name) : uiText(item.category)}${item.context.ruleName ? html`<small>${esc(item.context.ruleName)} · ${uiText("Step")} ${item.context.step}</small>` : ""}</td><td class="error-message">${uiText(item.message)}</td><td>${status(item.status)}</td><td><div class="row-actions">${button(`data-error-details="${item.id}"`, "list", "Error details")}${item.context.formId ? button(`data-error-open="${item.id}"`, "external-link", "Open source form") : ""}${item.context.ruleId ? button(`data-error-rule="${item.id}"`, "workflow", "Edit failed rule") : ""}${item.status === "Unresolved" && (item.context.operation || item.context.runId) ? button(`data-error-retry="${item.id}"`, "rotate-ccw", "Retry operation") : ""}${item.status !== "Resolved" ? button(`data-error-resolve="${item.id}"`, "check", "Mark resolved") : ""}${item.status !== "Ignored" ? button(`data-error-ignore="${item.id}"`, "eye-off", "Ignore error") : ""}</div></td></tr>`).join("")}</tbody></table>${items.length ? "" : html`<div class="workflow-empty">No errors</div>`}</div>`;
    if (!canManage()) $("view-errors").querySelectorAll("[data-error-rule], [data-error-retry], [data-error-resolve], [data-error-ignore]").forEach(control => { control.hidden = true; });
    icons();
  }
  async function enter(view) {
    const request = ++viewRequest;
    if (!["notifications-rules", "ai-tasks", "errors"].includes(view)) return;
    const spaceId = current().space.id, formId = current().form?.id;
    const isCurrent = () => request === viewRequest && current().view === view && current().space?.id === spaceId && current().form?.id === formId;
    try {
      if (view === "notifications-rules") {
        $("view-notifications-rules").innerHTML = html`<div class="workflow-empty" role="status">Loading automations...</div>`;
        if (!await fetchConfiguration() || !isCurrent()) return;
        const result = await api(`/api/automation-runs?${new URLSearchParams({ spaceId, formId })}`);
        if (!isCurrent()) return;
        runs = result; renderRules();
      }
      if (view === "ai-tasks") {
        if (!await fetchConfiguration() || !isCurrent()) return;
        const result = await api(`/api/ai-runs?${new URLSearchParams({ spaceId })}`);
        if (isCurrent()) renderTasks(result);
      }
      if (view === "errors") {
        const result = await api(`/api/errors?${new URLSearchParams({ spaceId })}`);
        if (isCurrent()) { errors = result; renderErrors(); }
      }
    } catch (error) {
      if (isCurrent()) {
        if (view === "notifications-rules") $("view-notifications-rules").innerHTML = html`<div class="form-error" role="alert">${uiText(error.message)}</div>`;
        toast(error.message, true);
      }
    }
  }
  function showChanges(titleText, changes) {
    setUIText($("workflow-review-title"), titleText);
    $("workflow-review-body").innerHTML = changesUI(changes);
    $("workflow-review-test").hidden = true; $("workflow-review-apply").hidden = true; $("workflow-review-error").hidden = true;
    if (!review.open) review.showModal(); icons();
  }
  async function rulePreview(id) {
    if (!requireManagement()) return;
    const rule = rules.find((rule) => rule.id === id), source = form(rule.formId);
    const records = await api(`/api/forms/${source.id}/records`);
    previewContext = { kind: "rule", rule, source, records };
    setUIText($("workflow-review-title"), `Preview: ${rule.name}`);
    $("workflow-review-body").innerHTML = html`<label class="input-field"><span class="builder-label">Source record</span><select id="preview-source-record">${records.map((record) => opt(record.id, title(record, source), records[0]?.id)).join("")}</select></label><div id="preview-source-values"></div><div id="preview-result"></div>`;
    const record = records[0];
    $("preview-source-values").innerHTML = source.fields.filter((field) => !field.formula && field.type !== "attachment").map((field) => html`<label class="input-field"><span class="builder-label">${esc(field.name)}</span>${literalUI(record?.values[field.id] ?? "", `sample.${field.id}`, field).replace('data-edit-path=', 'data-preview-field=')}</label>`).join("");
    $("workflow-review-test").hidden = false; $("workflow-review-apply").hidden = true; $("workflow-review-error").hidden = true;
    review.showModal(); icons();
  }
  $("workflow-review-test").onclick = async () => {
    try {
      if (previewContext.kind === "ai") {
        const result = await api(`/api/ai-runs/${previewContext.id}/preview`, { method: "POST", body: "{}" });
        previewContext.fingerprint = result.fingerprint;
        $("workflow-review-body").insertAdjacentHTML("beforeend", changesUI(result.changes));
    $("workflow-review-apply").hidden = !canManage(); $("workflow-review-test").hidden = true; return;
      }
      const { rule, source, records } = previewContext;
      const record = records.find((row) => row.id === $("preview-source-record").value);
      const values = Object.fromEntries([...review.querySelectorAll("[data-preview-field]")].map((input) => [input.dataset.previewField.replace("sample.", ""), input.hasAttribute("data-number") ? input.value === "" ? null : Number(input.value) : input.hasAttribute("data-boolean") ? input.value === "true" : input.value || null]));
      const result = await api("/api/notification-rules/preview", { method: "POST", body: JSON.stringify({ formId: source.id, operation: { created: "create", updated: "update", deleted: "delete" }[rule.trigger], recordId: record?.id, values }) });
      $("preview-result").innerHTML = changesUI(result.changes); icons();
    } catch (error) { setUIText($("workflow-review-error"), error.message); $("workflow-review-error").hidden = false; }
  };
  $("workflow-review-apply").onclick = async () => {
    if (!requireManagement()) return;
    try { await api(`/api/ai-runs/${previewContext.id}/apply`, { method: "POST", body: JSON.stringify({ fingerprint: previewContext.fingerprint }) }); review.close(); await refresh(); await enter("ai-tasks"); toast("AI result applied."); }
    catch (error) { setUIText($("workflow-review-error"), error.message); $("workflow-review-error").hidden = false; }
  };
  review.addEventListener("click", (event) => {
    if (event.target.closest("[data-reference]") && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.button === 0) review.close();
  });
  async function inspectAI(id) {
    const run = await api(`/api/ai-runs/${id}`);
    previewContext = { kind: "ai", id };
    delete $("workflow-review-title").dataset.i18nText;
    $("workflow-review-title").textContent = run.task.name;
    const target = form(run.task.outputFormId);
    $("workflow-review-body").innerHTML = html`<div class="workflow-preview-meta">${status(run.status)}<span>${esc(date(run.createdAt))}</span></div>${run.error ? html`<div class="form-error">${esc(run.error)}</div>` : ""}<div class="table-clip"><table class="data-table"><thead><tr>${run.task.outputFields.map((id) => html`<th>${esc(target?.fields.find((field) => field.id === id)?.name ?? id)}</th>`).join("")}</tr></thead><tbody>${(run.items ?? []).map((item) => html`<tr>${run.task.outputFields.map((id) => html`<td>${esc(item[id] ?? "(empty)")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
    $("workflow-review-test").hidden = run.status !== "Needs review"; $("workflow-review-apply").hidden = true; $("workflow-review-error").hidden = true;
    review.showModal(); icons();
  }
  async function runTask(id) {
    const task = tasks.find((task) => task.id === id), source = form(task.formId);
    const records = await api(`/api/forms/${source.id}/records`);
    if (!records.length) return toast("Add a source record before running this task.", true);
    previewContext = { kind: "launch", taskId: id };
    setUIText($("workflow-review-title"), `Run: ${task.name}`);
    $("workflow-review-body").innerHTML = html`<label class="input-field"><span class="builder-label">Input record</span><select id="ai-input-record">${records.map((row) => opt(row.id, title(row, source), records[0].id)).join("")}</select></label><div class="modal-actions"><button class="button button-primary" data-ai-launch="${id}">${icon("play")}<span>Run task</span></button></div>`;
    $("workflow-review-test").hidden = true; $("workflow-review-apply").hidden = true; $("workflow-review-error").hidden = true; review.showModal(); icons();
  }
  async function openNotifications() {
    const items = await api(`/api/notifications?spaceId=${current().space.id}`);
    $("notification-items").innerHTML = items.length ? items.map((item) => html`<article class="notification-row"><div><p>${esc(item.message)}</p><small>${esc(date(item.createdAt))} · ${esc(form(item.formId)?.name)}</small></div>${item.read ? "" : button(`data-notification-read="${item.id}"`, "check", "Mark notification read")}</article>`).join("") : html`<div class="workflow-empty">No notifications</div>`;
    $("notification-rule-new").hidden = !canManage();
    notifications.showModal(); icons();
  }
  $("notification-rules-open").onclick = () => { notifications.close(); showView("notifications-rules"); };
  $("notification-rule-new").onclick = () => { notifications.close(); editRule(null, true); };
  document.addEventListener("click", async (event) => {
    const target = event.target.closest("button");
    if (!target) return;
    const data = target.dataset;
    try {
      if ((data.ruleToggle || data.ruleDelete || data.taskDelete || data.errorResolve || data.errorIgnore || data.errorRetry) && !requireManagement()) return;
      if (data.treeToggle) { collapsed.has(data.treeToggle) ? collapsed.delete(data.treeToggle) : collapsed.add(data.treeToggle); renderNavigation(); }
      if (data.treeNew) openNode(null, data.treeNew);
      if (data.treeEdit) openNode(data.treeEdit);
      if (data.treeDrag) openNode(data.treeDrag);
      if (target.hasAttribute("data-node-close")) navDialog.close();
      if (target.hasAttribute("data-review-close")) review.close();
      if (target.hasAttribute("data-notifications-close")) notifications.close();
      if (data.workspaceView) showView(data.workspaceView);
      if (target.hasAttribute("data-rule-new")) await editRule();
      if (data.ruleEdit) await editRule(data.ruleEdit);
      if (data.rulePreview) await rulePreview(data.rulePreview);
      if (data.ruleTab && (Object.hasOwn(ruleTriggers, data.ruleTab) || data.ruleTab === "runs")) { ruleTabs.set(current().form.id, data.ruleTab); renderRules(); $("rule-tab-" + data.ruleTab).focus(); }
      if (data.ruleToggle) { const rule = rules.find((rule) => rule.id === data.ruleToggle); await api(`/api/notification-rules/${rule.id}`, { method: "PUT", body: JSON.stringify({ ...rule, enabled: !rule.enabled }) }); await enter("notifications-rules"); }
      if (data.ruleDelete) { const rule = rules.find((rule) => rule.id === data.ruleDelete); await api(`/api/notification-rules/${rule.id}`, { method: "DELETE", body: JSON.stringify({ version: rule.version }) }); await enter("notifications-rules"); }
      if (data.runDetails) {
        const run = runs.find((run) => run.id === data.runDetails);
        showChanges(run.ruleName, run.changes ?? [run.event]);
        icons();
      }
      if (target.hasAttribute("data-task-new")) await editTask();
      if (data.taskEdit) await editTask(data.taskEdit);
      if (data.taskDelete) { const task = tasks.find((task) => task.id === data.taskDelete); await api(`/api/ai-tasks/${task.id}`, { method: "DELETE", body: JSON.stringify({ version: task.version }) }); await enter("ai-tasks"); }
      if (data.aiTab) { aiTab = data.aiTab; await enter("ai-tasks"); }
      if (data.taskRun) await runTask(data.taskRun);
      if (data.aiLaunch) {
        await api(`/api/ai-tasks/${data.aiLaunch}/run`, { method: "POST", body: JSON.stringify({ recordId: $("ai-input-record").value }) });
        review.close(); aiTab = "runs"; showView("ai-tasks"); await enter("ai-tasks"); toast("AI task queued.");
      }
      if (data.aiRunDetails) await inspectAI(data.aiRunDetails);
      if (data.aiRetry) { await api(`/api/ai-runs/${data.aiRetry}/retry`, { method: "POST", body: "{}" }); await enter("ai-tasks"); }
      if (data.aiCancel) { await api(`/api/ai-runs/${data.aiCancel}/cancel`, { method: "POST", body: "{}" }); await enter("ai-tasks"); }
      if (target.hasAttribute("data-errors-refresh")) await enter("errors");
      if (data.errorResolve || data.errorIgnore) { await api(`/api/errors/${data.errorResolve ?? data.errorIgnore}`, { method: "PATCH", body: JSON.stringify({ status: data.errorResolve ? "Resolved" : "Ignored" }) }); await refresh(); await enter("errors"); }
      if (data.errorRetry) { await api(`/api/errors/${data.errorRetry}/retry?spaceId=${current().space.id}`, { method: "POST", body: "{}" }); await refresh(); await enter("errors"); }
      if (data.errorOpen) { const error = errors.find((error) => error.id === data.errorOpen); await navigate(error.context.formId); }
      if (data.errorRule) { const error = errors.find((error) => error.id === data.errorRule); await editRule(error.context.ruleId); }
      if (data.errorDetails) {
        const error = errors.find((error) => error.id === data.errorDetails);
        showChanges("Error details", []);
        $("workflow-review-body").innerHTML = html`<div class="form-error">${esc(error.message)}</div><pre class="error-context">${esc(JSON.stringify(error.context, null, 2))}</pre>`;
      }
      if (target.id === "form-automations") showView("notifications-rules");
      if (target.id === "form-notifications") await openNotifications();
      if (data.notificationRead) { await api(`/api/notifications/${data.notificationRead}`, { method: "PATCH", body: "{}" }); await refresh(); notifications.close(); await openNotifications(); }
    } catch (error) { toast(error.message, true); }
  });
  document.addEventListener("keydown", (event) => {
    const selected = event.target.closest("[data-rule-tab]");
    if (!selected || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const tabs = [...selected.parentElement.querySelectorAll("[data-rule-tab]")];
    const index = tabs.indexOf(selected), delta = event.key === "ArrowLeft" ? -1 : 1;
    tabs[event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + delta + tabs.length) % tabs.length].click();
  });
  document.addEventListener("change", (event) => {
    const key = event.target.dataset.errorFilter;
    if (key) { errorFilter[key] = event.target.value; renderErrors(); }
  });
  setInterval(async () => {
    if (current().user && current().view === "ai-tasks" && aiTab === "runs" && !review.open && !dialog.open) {
      const userId = current().user.id, spaceId = current().space?.id;
      try {
        const result = await api(`/api/ai-runs?spaceId=${spaceId}`);
        if (current().user?.id === userId && current().space?.id === spaceId) renderTasks(result);
      } catch { /* Next refresh retries. */ }
    }
  }, 2500);
  return {
    renderNavigation, enter,
    reset() {
      ++configurationRequest; ++viewRequest;
      navigationDrag.reset();
      rules = []; tasks = []; runs = []; errors = []; editor = null; navEditor = null; previewContext = null;
      busy = false; collapsed.clear(); ruleTabs.clear(); aiTab = "tasks";
      for (const modal of [dialog, navDialog, review, notifications]) modal.close();
      $("workflow-editor-body").replaceChildren(); $("workflow-review-body").replaceChildren(); $("notification-items").replaceChildren();
    },
    editFieldFormula(fieldId) {
      if (!requireManagement()) return;
      const draft = getDraft(), field = draft.fields.find((field) => field.id === fieldId);
      formulas.open({ mode: "field", sourceForm: draft, fieldId, formula: field.formula,
        onSave(formula) { if (formula) field.formula = formula; else delete field.formula; onDraftChanged(); } });
    },
  };
}

export function initAttachments({ api, getState, toast, icons }) {
  document.addEventListener("change", async (event) => {
    const input = event.target.closest("[data-attachment-upload]");
    if (!input) return;
    const host = input.closest(".attachment-editor"), hidden = host.querySelector("[data-value-id]");
    input.disabled = true;
    try {
      const ids = JSON.parse(hidden.dataset.files || "[]");
      if (ids.length + input.files.length > 10) throw new Error("A field supports up to 10 attachments.");
      for (const file of input.files) {
        let images;
        if (/\.pdf$/i.test(file.name)) {
          const pdfjs = await import("/vendor/pdf.mjs");
          pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.mjs";
          const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
          if (pdf.numPages > 6) throw new Error("Choose a PDF with at most 6 pages.");
          images = [];
          for (let number = 1; number <= pdf.numPages; number++) {
            const page = await pdf.getPage(number), viewport = page.getViewport({ scale: 1.2 }), canvas = document.createElement("canvas");
            canvas.width = viewport.width; canvas.height = viewport.height;
            await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
            images.push(canvas.toDataURL("image/jpeg", 0.75));
          }
          await pdf.destroy();
        }
        const saved = await api("/api/attachments", { method: "POST", body: JSON.stringify({ spaceId: getState().space.id, file: await encodeFile(file), images }) });
        ids.push(saved.id);
        hidden.dataset.files = JSON.stringify(ids);
      }
      hidden.dataset.files = JSON.stringify(ids);
      host.querySelector(".attachment-list").innerHTML = ids.map((id, index) => html`<span class="attachment-item"><a href="/api/attachments/${id}" download>File ${index + 1}</a>${button(`data-attachment-remove="${id}"`, "x", "Remove attachment")}</span>`).join("");
      hidden.dispatchEvent(new Event("input", { bubbles: true })); icons();
    } catch (error) { toast(error.message, true); }
    finally { input.disabled = false; input.value = ""; }
  });
  document.addEventListener("click", (event) => {
    const remove = event.target.closest("[data-attachment-remove]");
    if (!remove) return;
    const host = remove.closest(".attachment-editor"), hidden = host.querySelector("[data-value-id]");
    hidden.dataset.files = JSON.stringify(JSON.parse(hidden.dataset.files).filter((id) => id !== remove.dataset.attachmentRemove));
    remove.closest(".attachment-item").remove(); hidden.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
