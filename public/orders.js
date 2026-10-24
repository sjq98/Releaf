import { html, uiText, uiAttributes, setUIText, t, getLocale } from "/i18n.js";
import { renderFieldInput, renderFieldCell } from "/field-ui.js";

const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const icon = name => html`<i data-lucide="${esc(name)}" aria-hidden="true"></i>`;
const money = (value, currency = "MYR") => {
  if (value === null || value === undefined || value === "") return "—";
  const amount = Number(value);
  return Number.isFinite(amount) ? new Intl.NumberFormat("en-MY", { style: "currency", currency, currencyDisplay: "narrowSymbol", maximumFractionDigits: 2 }).format(amount) : "—";
};
const date = value => value ? new Intl.DateTimeFormat(getLocale(), { day: "2-digit", month: "short", year: "numeric" }).format(new Date(value)) : "—";
const dateTime = value => value ? new Intl.DateTimeFormat(getLocale(), { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(value)) : "—";
const localDateTime = value => {
  if (!value) return "";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "" : new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const statusClass = value => String(value || "draft").toLowerCase().replaceAll("_", "-");
const status = value => html`<span class="order-status order-status-${statusClass(value)}">${uiText(String(value || "draft"))}</span>`;
const val = (object, ...keys) => keys.reduce((result, key) => result ?? object?.[key], undefined);
const orderCustomer = order => val(order, "customerName", "customer", "customer_name") || "—";
const orderNumber = order => val(order, "number", "orderNumber", "order_number") || order?.id?.slice?.(0, 8) || "—";
const orderDate = order => val(order, "createdAt", "orderDate", "order_date");
const deliveryStatus = order => {
  if (order.status === "cancelled") return "cancelled";
  if (order.fulfillment === "pickup") return order.status === "completed" ? "completed" : "pickup";
  if (order.status === "completed") return "delivered";
  if (order.status === "dispatched") return "in transit";
  if (order.status === "ready") return "ready";
  return "awaiting fulfillment";
};
const actualDelivery = order => val(order, "actualDeliveryAt", "actualDeliveredAt", "completedAt", "actual_delivery_at");

export function initOrders({ api, icons, toast, getState }) {
  const $ = id => document.getElementById(id);
  const state = () => getState();
  const root = $("view-orders");
  let mounted = false;
  let active = false;
  let generation = 0;
  let request = 0;
  let activeTab = "all";
  let query = "";
  let statusFilter = "";
  let deliveryFilter = "";
  let sort = "newest";
  let busy = false;
  let selected = null;
  let editorMode = "create";
  let editorOrder = null;
  let draft = null;
  let detailRequest = 0;
  let whatsappBusy = false;
  let whatsappRequest = 0;
  let whatsappOpening = 0;
  let whatsappStatusLoading = false;
  let whatsappChatRequest = 0;
  let whatsappChatsLoading = false;
  let whatsappChatsAttempted = false;
  let whatsappChatsState = "idle";
  let whatsappChatsError = "";
  let whatsappChatsTruncated = false;
  let whatsappPoll = null;
  let whatsappStatus = null;
  let whatsappChats = [];
  let whatsappPlan = null;

  const orderState = () => state().orders || {};
  const orders = () => orderState().orders || [];
  const currency = () => orderState().currency || "MYR";
  const canEdit = () => Boolean(state().permissions?.manageOrders);
  const spaceId = () => state().space?.id || orderState().spaceId || "default";
  const currentUserId = () => state().user?.id;
  const fresh = token => active && token === generation;
  const uploading = () => Boolean($("order-editor-dialog")?.querySelector("[data-attachment-upload]:disabled:not([data-order-busy-lock])"));
  const editorLocked = () => busy || uploading();
  const canConfigure = () => state().user?.role === "admin";
  const whatsappFresh = (token, opening) => fresh(token) && opening === whatsappOpening &&
    Boolean($("order-whatsapp-dialog")?.open) && canConfigure();
  const changed = () => document.dispatchEvent(new CustomEvent("orderschanged"));
  const tableLink = (role, label, recordId) => {
    const id = orderState().tables?.[role];
    if (!id) return "";
    const query = new URLSearchParams({ spaceId: spaceId(), formId: id });
    if (recordId) query.set("recordId", recordId);
    return html`<a class="button button-secondary" href="?${query}#records">${icon("table-2")}<span>${uiText(label)}</span></a>`;
  };

  function closeOwnedDialogs() {
    document.querySelectorAll("dialog[data-orders-dialog]").forEach(dialog => {
      if (dialog.open) dialog.close();
    });
    selected = null;
    editorOrder = null;
    draft = null;
    resetWhatsAppDialog();
  }

  function renderRoot() {
    if (!mounted || !active) return;
    const search = root.querySelector("[data-order-search]");
    const focused = document.activeElement === search;
    const caret = focused ? search.selectionStart : null;
    const data = orderState();
    const summary = data.summary || {};
    const visible = filteredOrders();
    const all = orders();
    root.innerHTML = html`
      <div class="page-heading orders-heading">
        <div><div class="eyebrow">WORKSPACE <span class="eyebrow-divider"></span> ORDER MANAGEMENT</div><h1>Order management</h1></div>
        <div class="heading-actions">
          ${canConfigure() ? html`<button type="button" class="button button-secondary" data-order-whatsapp>${icon("message-circle")}<span>WhatsApp</span></button>` : ""}
          ${canEdit() ? html`<button type="button" class="button button-primary" data-order-new>${icon("plus")}<span>New order</span></button>` : ""}
          <button type="button" class="icon-button toolbar-icon" data-order-refresh ${uiAttributes("Refresh orders")}>${icon("refresh-cw")}</button>
        </div>
      </div>
      <div class="metrics order-metrics">
        <div class="metric"><span class="metric-label">Total orders</span><strong class="metric-value">${all.length}</strong><span class="metric-foot">${icon("files")} ${uiText("Visible orders")}</span></div>
        <div class="metric"><span class="metric-label">Awaiting verification</span><strong class="metric-value">${summary.pendingReview ?? all.filter(order => !order.reviewed && order.status !== "cancelled").length}</strong><span class="metric-foot">${icon("clipboard-check")} ${uiText("Order review")}</span></div>
        <div class="metric"><span class="metric-label">Order amount</span><strong class="metric-value metric-money">${esc(money(summary.totalAmount ?? all.filter(order => order.status !== "cancelled").reduce((total, order) => total + Number(order.totalAmount || 0), 0), currency()))}</strong><span class="metric-foot">${icon("coins")} ${uiText("Excluding cancelled orders")}</span></div>
        <div class="metric"><span class="metric-label">Payment confirmed</span><strong class="metric-value">${summary.paymentConfirmed ?? all.filter(order => order.paymentConfirmed).length}</strong><span class="metric-foot">${icon("badge-check")} ${uiText("Paid in full")}</span></div>
      </div>
      <div class="order-workflow-list">
        <article class="order-workflow"><span class="order-workflow-icon">${icon("clipboard-list")}</span><div><h2>Order fulfillment</h2><ol class="order-workflow-steps"><li>Order review</li><li>Accept</li><li>Preparation</li><li>Handover</li><li>Complete</li></ol></div><div class="order-workflow-actions">${canEdit() ? html`<button type="button" class="button button-primary" data-order-new>${icon("plus")}<span>Start order</span></button>` : ""}${tableLink("orders", "View orders")}</div></article>
        <article class="order-workflow"><span class="order-workflow-icon">${icon("wallet-cards")}</span><div><h2>Payment confirmation</h2><ol class="order-workflow-steps"><li>Check wallet</li><li>Mark paid in full</li></ol></div><div class="order-workflow-actions">${tableLink("payments", "View payment confirmations")}</div></article>
        <article class="order-workflow"><span class="order-workflow-icon">${icon("file-check-2")}</span><div><h2>Invoice registration</h2><ol class="order-workflow-steps"><li>Select order</li><li>Record invoice</li></ol></div><div class="order-workflow-actions">${tableLink("invoices", "View invoices")}</div></article>
      </div>
      <div class="orders-tabs" role="tablist" aria-label="Order scope">
        <button type="button" class="${activeTab === "all" ? "is-active" : ""}" data-order-tab="all" role="tab" aria-selected="${activeTab === "all"}">${uiText("All orders")} <span>${all.length}</span></button>
        <button type="button" class="${activeTab === "review" ? "is-active" : ""}" data-order-tab="review" role="tab" aria-selected="${activeTab === "review"}">${uiText("Awaiting verification")} <span>${all.filter(order => !order.reviewed && order.status !== "cancelled").length}</span></button>
        <button type="button" class="${activeTab === "mine" ? "is-active" : ""}" data-order-tab="mine" role="tab" aria-selected="${activeTab === "mine"}">${uiText("My orders")} <span>${all.filter(order => order.createdBy === currentUserId() || order.ownerId === currentUserId()).length}</span></button>
      </div>
      <div class="toolbar orders-toolbar">
        <label class="search-box"><i data-lucide="search"></i><input type="search" data-order-search value="${esc(query)}" placeholder="Search orders..." aria-label="Search orders"></label>
        <label class="filter-select"><i data-lucide="list-filter"></i><select data-order-status aria-label="Filter order status"><option value="">All statuses</option>${(data.statuses || ["draft", "accepted", "preparing", "ready", "dispatched", "completed", "cancelled"]).map(item => html`<option value="${esc(item)}"${item === statusFilter ? " selected" : ""}>${uiText(item)}</option>`).join("")}</select><i data-lucide="chevron-down" class="select-chevron"></i></label>
        <label class="filter-select"><i data-lucide="truck"></i><select data-order-delivery aria-label="Filter delivery status"><option value="">All delivery</option>${["awaiting fulfillment", "pickup", "ready", "in transit", "delivered", "cancelled"].map(item => html`<option value="${esc(item)}"${item === deliveryFilter ? " selected" : ""}>${uiText(item)}</option>`).join("")}</select><i data-lucide="chevron-down" class="select-chevron"></i></label>
        <label class="filter-select order-sort"><i data-lucide="arrow-down-up"></i><select data-order-sort aria-label="Sort orders"><option value="newest"${sort === "newest" ? " selected" : ""}>Newest first</option><option value="oldest"${sort === "oldest" ? " selected" : ""}>Oldest first</option><option value="amount"${sort === "amount" ? " selected" : ""}>Amount high to low</option><option value="delivery"${sort === "delivery" ? " selected" : ""}>Delivery date</option></select><i data-lucide="chevron-down" class="select-chevron"></i></label>
      </div>
      <div class="table-clip order-table-clip"><table class="data-table order-table" aria-label="Orders">
        <thead><tr>
          <th>Order number</th><th>Order date</th><th>Customer</th><th>Department</th><th>Salesperson</th><th>Verification</th><th>Order status</th><th>Delivery status</th><th>Estimated delivery date</th><th>Actual delivery time</th><th>Order amount</th><th>Paid in full</th><th>Invoiced amount</th><th>Attachments</th><th>Notes</th><th><span class="sr-only">Actions</span></th>
        </tr></thead>
        <tbody>${visible.map(renderOrderRow).join("")}</tbody>
      </table>${visible.length ? "" : html`<div class="empty-state order-empty"><span class="empty-mark">${icon("clipboard-x")}</span><h3>${uiText(all.length ? "No matching orders" : "No orders yet")}</h3>${canEdit() && !all.length ? html`<button type="button" class="button button-secondary" data-order-new>${icon("plus")}<span>New order</span></button>` : ""}</div>`}</div>
      <div class="list-footer"><span>${visible.length} / ${all.length} ${uiText("orders")}</span><span>${icon("database")} ${uiText("Local workspace")}</span></div>`;
    if (focused) {
      const replacement = root.querySelector("[data-order-search]");
      replacement.focus({ preventScroll: true });
      replacement.setSelectionRange(caret, caret);
    }
    icons();
  }

  function renderOrderRow(order) {
    const attachments = Array.isArray(order.attachments) ? order.attachments.length : Number(order.attachmentCount || 0);
    const customer = orderCustomer(order);
    return html`<tr data-order-row="${esc(order.id)}">
      <td><button type="button" class="order-number-link" data-order-open="${esc(order.id)}">${esc(orderNumber(order))}</button></td>
      <td class="nowrap">${esc(date(orderDate(order)))}</td>
      <td><span class="order-customer">${esc(customer)}</span>${order.customerPhone ? html`<small>${esc(order.customerPhone)}</small>` : ""}</td>
      <td>${esc(order.department || "—")}</td><td>${esc(order.salesperson || order.salespersonName || "—")}</td>
      <td>${verificationBadge(order)}</td><td>${status(order.status)}</td><td>${status(deliveryStatus(order))}</td>
      <td>${esc(date(order.estimatedDeliveryAt))}</td><td>${esc(dateTime(actualDelivery(order)))}</td>
      <td class="numeric">${esc(money(order.totalAmount, currency()))}</td><td>${paymentBadge(order)}</td><td class="numeric">${esc(money(order.invoicedAmount, currency()))}</td>
      <td>${attachments ? html`<span class="attachment-count">${icon("paperclip")}${attachments}</span>` : "—"}</td><td class="notes-cell" title="${esc(order.notes || "")}">${esc(order.notes || "—")}</td>
      <td><button type="button" class="icon-button" data-order-open="${esc(order.id)}" ${uiAttributes(`Open ${orderNumber(order)}`)}>${icon("arrow-up-right")}</button></td>
    </tr>`;
  }

  function filteredOrders() {
    let result = orders().filter(order => activeTab === "all" || (activeTab === "review" ? !order.reviewed && order.status !== "cancelled" : order.createdBy === currentUserId() || order.ownerId === currentUserId()));
    const needle = query.trim().toLowerCase();
    if (needle) result = result.filter(order => [orderNumber(order), orderCustomer(order), order.customerPhone, order.department, order.salesperson, order.notes, order.status].some(value => String(value || "").toLowerCase().includes(needle)));
    if (statusFilter) result = result.filter(order => order.status === statusFilter);
    if (deliveryFilter) result = result.filter(order => deliveryStatus(order) === deliveryFilter);
    result.sort((a, b) => {
      if (sort === "amount") return Number(b.totalAmount || 0) - Number(a.totalAmount || 0);
      if (sort === "delivery") return (new Date(a.estimatedDeliveryAt || "9999-12-31")) - (new Date(b.estimatedDeliveryAt || "9999-12-31"));
      const delta = new Date(orderDate(b) || 0) - new Date(orderDate(a) || 0);
      return sort === "oldest" ? -delta : delta;
    });
    return result;
  }

  async function load() {
    if (!mounted || !active || !state().user) return;
    const token = generation, sequence = ++request, id = spaceId();
    try {
      const data = await api(`/api/orders/workspace?${new URLSearchParams({ spaceId: id })}`);
      if (!fresh(token) || sequence !== request || state().space?.id !== id) return;
      state().orders = { ...orderState(), ...data };
      renderRoot();
    } catch (error) {
      if (!fresh(token) || sequence !== request) return;
      renderError(error);
    }
  }

  function renderError(error) {
    if (!mounted) return;
    root.innerHTML = html`<div class="page-heading"><div><div class="eyebrow">WORKSPACE <span class="eyebrow-divider"></span> ORDER MANAGEMENT</div><h1>Order management</h1></div><button type="button" class="button button-secondary" data-order-refresh>${icon("refresh-cw")}<span>Retry</span></button></div><div class="orders-error"><span class="empty-mark">${icon("circle-alert")}</span><h2>Order service unavailable</h2><p>${esc(error.message || "Could not load orders.")}</p></div>`;
    icons();
  }

  function emptyDraft() {
    return { customerName: "", customerPhone: "", department: "", salesperson: state().user?.displayName || state().user?.username || "", fulfillment: "", deliveryAddress: "", requestedTime: "", estimatedDeliveryAt: "", notes: "", sourceText: "", totalAmount: null, attachments: [], issues: [], reviewed: false };
  }

  function renderEditor() {
    if (uploading()) return;
    const data = draft || emptyDraft();
    const issues = data.issues || [];
    const dialog = $("order-editor-dialog");
    if (!dialog) return;
    setUIText($("order-editor-title"), editorMode === "edit" ? "Edit order" : "New order");
    setUIText($("order-editor-kicker"), editorMode === "edit" ? "ORDER REVIEW" : "AI ORDER CAPTURE");
    $("order-source-text").value = data.sourceText || "";
    $("order-customer-name").value = data.customerName || "";
    $("order-customer-phone").value = data.customerPhone || "";
    $("order-department").value = data.department || "";
    $("order-salesperson").value = data.salesperson || "";
    $("order-fulfillment").value = data.fulfillment || "";
    $("order-address").value = data.deliveryAddress || "";
    $("order-requested-time").value = data.requestedTime || "";
    $("order-estimated-date").value = localDateTime(data.estimatedDeliveryAt);
    $("order-notes").value = data.notes || "";
    $("order-total-amount").value = data.totalAmount ?? "";
    $("order-attachment-field").innerHTML = renderFieldInput({ id: "attachments", name: t("Attachments"), type: "attachment" }, data.attachments || [], "order", []);
    $("order-extraction-issues").hidden = !issues.length;
    $("order-extraction-issues").innerHTML = issues.length ? html`<strong>Review before confirming</strong><ul>${issues.map(issue => html`<li>${uiText(issue.message || issue.code || "Unresolved item")}</li>`).join("")}</ul>` : "";
    $("order-review-check").checked = Boolean(data.reviewed);
    setUIText($("order-extract-label"), editorMode === "edit" ? "Extract draft" : "Import order");
    updateBusyControls();
    icons();
  }

  function updateBusyControls() {
    document.querySelectorAll("dialog[data-orders-dialog]:not(#order-whatsapp-dialog) button, dialog[data-orders-dialog]:not(#order-whatsapp-dialog) input, dialog[data-orders-dialog]:not(#order-whatsapp-dialog) select, dialog[data-orders-dialog]:not(#order-whatsapp-dialog) textarea").forEach(input => {
      if (!input.matches("[data-attachment-upload]")) {
        input.disabled = busy;
      } else if (busy && !input.disabled) {
        input.dataset.orderBusyLock = "";
        input.disabled = true;
      } else if (!busy && input.hasAttribute("data-order-busy-lock")) {
        delete input.dataset.orderBusyLock;
        input.disabled = false;
      }
    });
    $("order-extract").disabled = !state().ai?.configured || busy;
    $("order-editor-save").disabled = busy || !canEdit();
    const reviewed = $("order-review-check").checked;
    $("order-customer-name").required = reviewed;
    $("order-total-amount").required = reviewed;
    $("order-fulfillment").required = reviewed;
    $("order-address").required = reviewed && $("order-fulfillment").value === "delivery";
    setUIText($("order-editor-save-label"), reviewed ? "Confirm and save" : "Save draft");
    const paid = $("order-paid-check");
    if (paid) paid.disabled = busy || !canEdit() || !selected?.canConfirmPayment;
  }

  function openEditor(order = null) {
    if (!canEdit() || busy || (order && !order.canEdit)) return;
    editorMode = order ? "edit" : "create";
    editorOrder = order ? structuredClone(order) : null;
    draft = order ? {
      ...emptyDraft(), ...order,
      customerName: orderCustomer(order),
      sourceText: order.sourceText || "",
      reviewed: false,
    } : emptyDraft();
    $("order-editor-error").hidden = true;
    renderEditor();
    $("order-editor-dialog").showModal();
    $("order-customer-name").focus();
  }

  async function extractDraft() {
    if (editorLocked()) return;
    syncDraftFromEditor();
    const text = $("order-source-text").value.trim();
    if (!text) return setError("order-editor-error", "Paste a customer message first.");
    if (!state().ai?.configured) return setError("order-editor-error", "Configure an AI provider before extracting.");
    const token = generation; busy = true; updateBusyControls();
    $("order-editor-error").hidden = true;
    try {
      const importing = editorMode === "create";
      const result = await api(importing ? "/api/orders/intake" : "/api/orders/extract", { method: "POST", body: JSON.stringify({ spaceId: spaceId(), text }) });
      if (!fresh(token)) return;
      const extracted = result.order ?? result;
      if (extracted.skipped || extracted.isOrder === false) {
        setError("order-editor-error", "This message does not contain a new order request.");
        return;
      }
      const manualAmount = importing ? null : draft.totalAmount;
      if (importing) {
        if (extracted.canEdit === false) {
          $("order-editor-dialog").close();
          toast("This order was already imported.");
          await load();
          if (fresh(token)) await openDetail(extracted.id);
          return;
        }
        editorMode = "edit";
        editorOrder = structuredClone(extracted);
      }
      draft = { ...draft, ...extracted, totalAmount: manualAmount, fulfillment: extracted.fulfillment || "", sourceText: text, issues: extracted.issues || [], reviewed: false };
      renderEditor();
      if (importing) {
        toast(extracted.intakeDuplicate ? "This order was already imported." : "Order imported for verification.");
        changed();
        await load();
      }
    } catch (error) { if (fresh(token)) setError("order-editor-error", error.message); }
    finally { if (fresh(token)) { busy = false; updateBusyControls(); } }
  }

  function syncDraftFromEditor() {
    if (!draft) draft = emptyDraft();
    draft.customerName = $("order-customer-name").value.trim();
    draft.customerPhone = $("order-customer-phone").value.trim();
    draft.department = $("order-department").value.trim();
    draft.salesperson = $("order-salesperson").value.trim();
    draft.fulfillment = $("order-fulfillment").value;
    draft.deliveryAddress = $("order-address").value.trim();
    draft.requestedTime = $("order-requested-time").value.trim();
    draft.estimatedDeliveryAt = $("order-estimated-date").value ? new Date($("order-estimated-date").value).toISOString() : null;
    draft.notes = $("order-notes").value.trim();
    draft.sourceText = $("order-source-text").value.trim();
    draft.totalAmount = $("order-total-amount").value === "" ? null : Number($("order-total-amount").value);
    draft.attachments = JSON.parse($("order-attachments")?.dataset.files || "[]");
    draft.reviewed = $("order-review-check").checked;
  }

  async function saveEditor() {
    if (editorLocked() || !canEdit() || (editorMode === "edit" && !editorOrder?.canEdit)) return;
    syncDraftFromEditor();
    if (draft.totalAmount !== null && (!Number.isFinite(draft.totalAmount) || draft.totalAmount < 0)) return setError("order-editor-error", "Enter the confirmed order amount in MYR.");
    if (draft.reviewed) {
      if (!draft.customerName) return setError("order-editor-error", "Customer name is required.");
      if (draft.totalAmount === null) return setError("order-editor-error", "Enter the confirmed order amount in MYR.");
      if (!["pickup", "delivery"].includes(draft.fulfillment)) return setError("order-editor-error", "Choose pickup or delivery.");
      if (draft.fulfillment === "delivery" && !draft.deliveryAddress) return setError("order-editor-error", "Delivery address is required for delivery orders.");
    }
    const body = { spaceId: spaceId(), customerName: draft.customerName || null, customerPhone: draft.customerPhone || null, department: draft.department || null, salesperson: draft.salesperson || null, fulfillment: draft.fulfillment || null, deliveryAddress: draft.deliveryAddress || null, estimatedDeliveryAt: draft.estimatedDeliveryAt || null, requestedTime: draft.requestedTime || null, notes: draft.notes || null, sourceText: draft.sourceText || null, attachments: draft.attachments || [], totalAmount: draft.totalAmount, reviewed: draft.reviewed };
    if (editorMode === "edit") body.version = editorOrder.version;
    const token = generation; busy = true; updateBusyControls();
    $("order-editor-error").hidden = true;
    try {
      const result = await api(editorMode === "edit" ? `/api/orders/${editorOrder.id}` : "/api/orders", { method: editorMode === "edit" ? "PATCH" : "POST", body: JSON.stringify(body) });
      if (!fresh(token)) return;
      $("order-editor-dialog").close();
      toast(editorMode === "edit" ? "Order updated." : "Order created.");
      changed();
      await load();
      if (fresh(token) && result?.id) await openDetail(result.id);
    } catch (error) { if (fresh(token)) setError("order-editor-error", error.message); }
    finally { if (fresh(token)) { busy = false; updateBusyControls(); } }
  }

  function setError(id, message) {
    const element = $(id);
    if (!element) return;
    setUIText(element, message);
    element.hidden = false;
  }

  function verificationBadge(order) {
    return html`<span class="order-status ${order.reviewed ? "order-status-completed" : "order-status-review"}">${uiText(order.reviewed ? "Verified" : "Awaiting verification")}</span>`;
  }

  function paymentBadge(order) {
    return html`<span class="order-payment-state ${order.paymentConfirmed ? "is-confirmed" : ""}">${icon(order.paymentConfirmed ? "circle-check" : "circle")}<span>${uiText(order.paymentConfirmed ? "Paid in full" : "Not confirmed")}</span></span>`;
  }

  function renderProgress(order) {
    if (order.status === "cancelled") return html`<div class="order-progress-cancelled">${icon("ban")}<span>Cancelled</span></div>`;
    const steps = [
      ["draft", "Order review"], ["accepted", "Accepted"], ["preparing", "Preparation"], ["ready", order.fulfillment === "pickup" ? "Ready for pickup" : "Ready for dispatch"],
      ...(order.fulfillment === "delivery" ? [["dispatched", "In transit"]] : []), ["completed", "Completed"],
    ];
    const active = steps.findIndex(([key]) => key === order.status);
    return html`<ol class="order-progress" aria-label="Order progress">${steps.map(([key, label], index) => html`<li class="${index < active ? "is-done" : index === active ? "is-current" : ""}"${index === active ? ' aria-current="step"' : ""}><span class="order-progress-mark">${index < active ? icon("check") : index + 1}</span><span>${uiText(label)}</span></li>`).join("")}</ol>`;
  }

  function renderDetail(order) {
    const dialog = $("order-detail-dialog");
    if (!dialog || !order) return;
    selected = order;
    $("order-detail-title").textContent = orderNumber(order);
    $("order-detail-status").innerHTML = `${verificationBadge(order)} ${status(order.status)}`;
    $("order-detail-body").innerHTML = html`
      <div class="order-detail-summary">
        <div><span>Customer</span><strong>${esc(orderCustomer(order))}</strong>${order.customerPhone ? html`<small>${esc(order.customerPhone)}</small>` : ""}</div>
        <div><span>Order date</span><strong>${esc(dateTime(orderDate(order)))}</strong></div>
        <div><span>Fulfillment</span><strong>${order.fulfillment ? uiText(order.fulfillment === "pickup" ? "Pickup" : "Delivery") : "—"}</strong><small>${esc(order.deliveryAddress || "—")}</small></div>
        <div><span>Order amount</span><strong>${esc(money(order.totalAmount, currency()))}</strong>${paymentBadge(order)}</div>
      </div>
      ${renderProgress(order)}
      <div class="order-detail-actions">${!order.reviewed && order.canEdit && canEdit() ? html`<button type="button" class="button button-primary" data-order-review>${icon("clipboard-check")}<span>Review order</span></button>` : ""}${actionButtons(order)}</div>
      <div class="order-detail-grid">
        <section class="order-detail-section"><div class="section-heading"><h3>Order details</h3></div><dl class="order-info-list">
          ${[["Department", order.department], ["Salesperson", order.salesperson], ["Requested time", order.requestedTime], ["Estimated delivery", dateTime(order.estimatedDeliveryAt)], ["Actual delivery time", dateTime(actualDelivery(order))]].map(([label, value]) => html`<div><dt>${uiText(label)}</dt><dd>${esc(value || "—")}</dd></div>`).join("")}
        </dl><div class="section-heading"><h3>Notes</h3></div><p class="order-notes">${esc(order.notes || "—")}</p>
        <div class="section-heading"><h3>Attachments</h3></div>${renderFieldCell({ type: "attachment" }, order.attachments || [], { catalog: [] })}</section>
        <section class="order-detail-section"><div class="section-heading"><h3>Payment confirmation</h3></div>
          <label class="order-payment-check"><input type="checkbox" id="order-paid-check" ${order.paymentConfirmed ? "checked" : ""}${!canEdit() || !order.canConfirmPayment ? " disabled" : ""}><span>Paid in full</span></label>
          <dl class="order-info-list">
            <div><dt>Confirmation</dt><dd>${uiText(order.paymentConfirmed ? "Confirmed" : "Not confirmed")}</dd></div>
            <div><dt>Confirmed by</dt><dd>${esc(order.paymentConfirmation?.confirmedBy || "—")}</dd></div>
            <div><dt>Confirmed at</dt><dd>${esc(dateTime(order.paymentConfirmation?.confirmedAt))}</dd></div>
          </dl>
          <div class="detail-button-row">${tableLink("payments", "View confirmation", order.paymentConfirmation?.id)}</div>
          <div class="section-heading"><h3>Invoice registration</h3></div><div class="amount-list"><div><span>Invoiced</span><strong>${esc(money(order.invoicedAmount, currency()))}</strong></div></div><div class="detail-button-row">${order.canInvoice !== false && canEdit() ? html`<button type="button" class="button button-secondary" data-order-invoice>${icon("file-check-2")}<span>Record invoice</span></button>` : ""}${tableLink("invoices", "View invoices")}</div></section>
      </div>
      <section class="order-detail-section"><div class="section-heading"><h3>Invoice records</h3></div>${renderInvoices(order.invoices || [])}</section>
      <section class="order-detail-section"><div class="section-heading"><h3>Status messages</h3></div><div class="detail-button-row">${canEdit() ? html`<button type="button" class="button button-secondary" data-order-notify>${icon("message-square-share")}<span>Prepare status message</span></button>` : ""}</div><div id="order-notification-history">${renderNotifications(order.notifications || [])}</div></section>
      <section class="order-detail-section"><div class="section-heading"><h3>Activity</h3><span class="section-count">${(order.events || []).length}</span></div><div class="order-events">${[...(order.events || [])].reverse().map(event => html`<div class="order-event"><span class="event-dot"></span><div><strong>${event.fromStatus ? html`${uiText(event.fromStatus)} → ${uiText(event.toStatus)}` : uiText(event.message)}</strong><small>${esc(dateTime(event.createdAt))}${event.actor ? ` · ${esc(event.actor)}` : ""}</small></div></div>`).join("") || html`<p class="muted">No activity yet.</p>`}</div></section>
    `;
    $("order-detail-edit").hidden = !order.canEdit || !canEdit();
    updateBusyControls();
    icons();
  }

  function renderInvoices(entries) {
    if (!entries.length) return html`<p class="muted">No entries yet.</p>`;
    return entries.map(entry => html`<div class="order-finance-entry"><div><strong>${esc(entry.number)}</strong><small>${esc(dateTime(entry.createdAt))}</small>${entry.note ? html`<p>${esc(entry.note)}</p>` : ""}</div><strong>${esc(money(entry.amount, currency()))}</strong></div>`).join("");
  }

  function actionButtons(order) {
    if (!canEdit()) return "";
    const actions = order.allowedActions || [];
    const labels = { accept: ["check", "Accept"], prepare: ["chef-hat", "Start preparation"], ready: ["package-check", "Mark ready"], dispatch: ["truck", "Dispatch"], complete: ["circle-check", "Complete"], cancel: ["ban", "Cancel"] };
    return actions.map(action => {
      const [name, label] = labels[action] || ["play", action];
      return html`<button type="button" class="button ${action === "cancel" ? "button-danger" : "button-primary"}" data-order-transition="${esc(action)}">${icon(name)}<span>${uiText(label)}</span></button>`;
    }).join("");
  }

  async function openDetail(id) {
    const token = generation, sequence = ++detailRequest;
    try {
      const result = await api(`/api/orders/${id}`);
      if (!fresh(token) || sequence !== detailRequest) return;
      renderDetail(result);
      $("order-detail-dialog").showModal();
    } catch (error) { if (fresh(token)) toast(error.message, true); }
  }

  async function transition(action) {
    if (!selected || busy) return;
    if (action === "cancel" && !window.confirm(t("Cancel this order?"))) return;
    const token = generation; busy = true; updateBusyControls();
    try {
      const result = await api(`/api/orders/${selected.id}/transition`, { method: "POST", body: JSON.stringify({ version: selected.version, action }) });
      if (!fresh(token)) return;
      renderDetail(result); toast("Order status updated.");
      changed();
      await load();
    } catch (error) { if (fresh(token)) toast(error.message, true); }
    finally { if (fresh(token)) { busy = false; updateBusyControls(); } }
  }

  function renderNotifications(items) {
    if (!items.length) return html`<p class="muted">No status messages prepared.</p>`;
    return items.map(item => html`<div class="notification-history"><div><strong>${esc(item.message)}</strong><small>${esc(dateTime(item.createdAt))}</small></div><button type="button" class="icon-button" data-copy-notification="${esc(item.message)}" ${uiAttributes("Copy message")}>${icon("copy")}</button></div>`).join("");
  }

  async function confirmPayment(confirmed) {
    if (!selected || busy || !canEdit() || !selected.canConfirmPayment) return;
    if (!confirmed && !window.confirm(t("Clear full-payment confirmation?"))) {
      $("order-paid-check").checked = Boolean(selected.paymentConfirmed);
      return;
    }
    const token = generation; busy = true; updateBusyControls();
    try {
      const result = await api(`/api/orders/${selected.id}/payment-confirmation`, { method: "POST", body: JSON.stringify({ version: selected.version, confirmed }) });
      if (!fresh(token)) return;
      renderDetail(result);
      toast(confirmed ? "Full payment confirmed." : "Payment confirmation cleared.");
      changed();
      await load();
    } catch (error) {
      if (fresh(token)) {
        $("order-paid-check").checked = Boolean(selected.paymentConfirmed);
        toast(error.message, true);
      }
    } finally { if (fresh(token)) { busy = false; updateBusyControls(); } }
  }

  function openTransaction() {
    if (!selected) return;
    const dialog = $("order-transaction-dialog");
    $("order-transaction-error").hidden = true;
    $("transaction-amount").value = "";
    $("transaction-reference").value = "";
    $("transaction-notes").value = "";
    dialog.showModal();
  }

  async function submitTransaction(event) {
    event.preventDefault();
    if (!selected || busy) return;
    const body = { version: selected.version, amount: Number($("transaction-amount").value), number: $("transaction-reference").value.trim(), note: $("transaction-notes").value.trim() || null };
    if (!(body.amount > 0) || !body.number) return setError("order-transaction-error", "Enter a positive amount and invoice number.");
    const token = generation; busy = true; updateBusyControls();
    try {
      const result = await api(`/api/orders/${selected.id}/invoices`, { method: "POST", body: JSON.stringify(body) });
      if (!fresh(token)) return;
      $("order-transaction-dialog").close();
      toast("Invoice recorded.");
      renderDetail(result);
      changed();
      await load();
    } catch (error) { if (fresh(token)) setError("order-transaction-error", error.message); }
    finally { if (fresh(token)) { busy = false; updateBusyControls(); } }
  }

  async function prepareNotification() {
    if (!selected || busy) return;
    const token = generation; busy = true; updateBusyControls();
    try {
      const result = await api(`/api/orders/${selected.id}/notifications`, { method: "POST", body: JSON.stringify({ version: selected.version }) });
      if (!fresh(token)) return;
      const message = result.message || result.notification?.message || "";
      const updated = await api(`/api/orders/${selected.id}`);
      if (!fresh(token)) return;
      renderDetail(updated);
      changed();
      if (message) toast(await copy(message) ? "Status message prepared and copied." : "Status message prepared.");
    } catch (error) { if (fresh(token)) toast(error.message, true); }
    finally { if (fresh(token)) { busy = false; updateBusyControls(); } }
  }

  async function copy(value) {
    try { await navigator.clipboard.writeText(value); return true; } catch { toast("Copy failed. Select the message manually.", true); return false; }
  }

  function stopWhatsAppPoll() {
    if (whatsappPoll) clearInterval(whatsappPoll);
    whatsappPoll = null;
  }

  function resetWhatsAppChats() {
    ++whatsappChatRequest;
    whatsappChats = [];
    whatsappChatsLoading = false;
    whatsappChatsAttempted = false;
    whatsappChatsState = "idle";
    whatsappChatsError = "";
    whatsappChatsTruncated = false;
    whatsappPlan = null;
    if (!$("whatsapp-chat")) return;
    $("whatsapp-chat").innerHTML = html`<option value="">Select chat</option>`;
    $("whatsapp-plan").replaceChildren();
    $("whatsapp-plan").hidden = true;
    $("whatsapp-result").replaceChildren();
    $("whatsapp-result").hidden = true;
    renderWhatsAppChats();
  }

  function resetWhatsAppDialog() {
    ++whatsappOpening;
    ++whatsappRequest;
    whatsappStatusLoading = false;
    whatsappBusy = false;
    whatsappStatus = null;
    stopWhatsAppPoll();
    resetWhatsAppChats();
    if (!$("whatsapp-project-path")) return;
    $("whatsapp-project-path").value = "";
    $("whatsapp-status").replaceChildren();
    $("whatsapp-status").classList.remove("is-connected");
    $("whatsapp-qr").replaceChildren();
    $("whatsapp-qr").hidden = true;
    $("whatsapp-error").hidden = true;
    $("whatsapp-connection-error").hidden = true;
  }

  function updateWhatsAppControls() {
    const dialog = $("order-whatsapp-dialog");
    if (!dialog) return;
    const workBusy = whatsappBusy || whatsappChatsLoading;
    dialog.querySelectorAll("button, input, select").forEach(control => { control.disabled = workBusy; });
    const linked = Boolean(whatsappStatus?.linked);
    const running = Boolean(whatsappStatus?.available || linked);
    dialog.querySelectorAll("[data-order-close]").forEach(control => { control.disabled = false; });
    $("whatsapp-refresh").disabled = whatsappBusy || whatsappStatusLoading;
    $("whatsapp-connect").disabled = workBusy || whatsappStatusLoading || running;
    $("whatsapp-project-path").disabled = workBusy || running;
    setUIText($("whatsapp-connect-label"), running ? "Connector running" : "Start connector");
    $("whatsapp-load-chats").disabled = workBusy || !linked;
    $("whatsapp-chat").disabled = workBusy || !linked || !whatsappChats.length;
    $("whatsapp-preview").disabled = workBusy || !linked || !$("whatsapp-chat").value;
    $("whatsapp-import").disabled = workBusy || !linked || !whatsappPlan?.candidates?.length;
    $("whatsapp-link").disabled = workBusy || whatsappStatusLoading || !whatsappStatus?.available || linked;
  }

  function renderWhatsAppChats() {
    if (!$("whatsapp-chats-status")) return;
    $("whatsapp-chat-count").textContent = whatsappChatsLoading && !whatsappChats.length ? "..." : String(whatsappChats.length);
    const element = $("whatsapp-chats-status");
    const message = whatsappChatsState === "loading" ? "Loading chats..."
      : whatsappChatsState === "error" ? whatsappChatsError || "Could not load chats."
      : whatsappChatsState === "empty" ? "No direct conversations found."
      : whatsappChatsTruncated ? "Only the most recent chats are shown."
      : whatsappChatsState === "idle" ? "Link WhatsApp to load chats." : "";
    setUIText(element, message);
    element.hidden = !message;
    element.classList.toggle("is-error", whatsappChatsState === "error");
    element.setAttribute("role", whatsappChatsState === "error" ? "alert" : "status");
    $("whatsapp-chat").setAttribute("aria-busy", String(whatsappChatsLoading));
    updateWhatsAppControls();
  }

  function maybeLoadWhatsAppChats() {
    if (!$("order-whatsapp-dialog")?.open || !canConfigure() || !whatsappStatus?.linked ||
        whatsappBusy || whatsappChatsLoading || whatsappChatsAttempted) return;
    whatsappChatsAttempted = true;
    loadWhatsAppChats();
  }

  function renderWhatsAppStatus(data) {
    const previous = whatsappStatus;
    whatsappStatus = data;
    if (previous?.linked && !data.linked || previous?.accountId && data.accountId && previous.accountId !== data.accountId) {
      resetWhatsAppChats();
    }
    const stateLabels = { ready: "Connected", connected: "Connected", authenticated: "Connecting", connecting: "Connecting", starting: "Connecting", loading: "Connecting", qr: "Scan QR code", unlinked: "Not linked", disconnected: "Not linked", stopped: "Not connected", idle: "Not linked", offline: "Not connected", auth_failure: "Connection issue", not_configured: "Not configured", unavailable: "Connector unavailable" };
    const label = data.linked ? "Connected" : data.error ? "Connection issue" : stateLabels[data.state] || "Not connected";
    $("whatsapp-status").innerHTML = html`${icon(data.linked ? "circle-check" : "circle")}<span>${uiText(label)}</span>`;
    $("whatsapp-status").classList.toggle("is-connected", Boolean(data.linked));
    if (data.projectPath && !$("whatsapp-project-path").value) $("whatsapp-project-path").value = data.projectPath;
    const image = typeof data.qrImage === "string" && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=\s]+$/.test(data.qrImage) ? data.qrImage : null;
    $("whatsapp-qr").hidden = !image;
    $("whatsapp-qr").innerHTML = image ? html`<img src="${esc(image)}" alt="WhatsApp linking QR code"><strong>Scan QR code</strong>` : "";
    if (data.error) setError("whatsapp-connection-error", data.error);
    else $("whatsapp-connection-error").hidden = true;
    updateWhatsAppControls();
    icons();
    maybeLoadWhatsAppChats();
  }

  async function loadWhatsAppStatus(report = true) {
    if (whatsappBusy || whatsappStatusLoading || !canConfigure() || !$("order-whatsapp-dialog")?.open) return;
    const token = generation, opening = whatsappOpening, sequence = ++whatsappRequest;
    whatsappStatusLoading = true;
    updateWhatsAppControls();
    try {
      const result = await api("/api/whatsapp/status");
      if (!whatsappFresh(token, opening) || sequence !== whatsappRequest) return;
      renderWhatsAppStatus(result);
    } catch (error) {
      if (whatsappFresh(token, opening) && sequence === whatsappRequest && report) setError("whatsapp-connection-error", error.message);
    } finally {
      if (whatsappFresh(token, opening) && sequence === whatsappRequest) {
        whatsappStatusLoading = false;
        updateWhatsAppControls();
      }
    }
  }

  async function openWhatsApp() {
    if (!canConfigure() || $("order-whatsapp-dialog")?.open) return;
    resetWhatsAppDialog();
    const token = generation, opening = whatsappOpening;
    $("order-whatsapp-dialog").showModal();
    renderWhatsAppChats();
    setUIText($("whatsapp-status"), "Connecting");
    await loadWhatsAppStatus();
    if (!whatsappFresh(token, opening)) return;
    stopWhatsAppPoll();
    whatsappPoll = setInterval(() => {
      if (!whatsappFresh(token, opening)) { stopWhatsAppPoll(); return; }
      loadWhatsAppStatus(false);
    }, 4000);
  }

  async function connectWhatsApp(link = false) {
    if (whatsappBusy || whatsappChatsLoading || whatsappStatusLoading || !canConfigure() ||
        !$("order-whatsapp-dialog")?.open) return;
    if (link ? whatsappStatus?.linked : whatsappStatus?.available || whatsappStatus?.linked) return;
    const token = generation, opening = whatsappOpening;
    ++whatsappRequest;
    whatsappBusy = true; updateWhatsAppControls();
    $("whatsapp-error").hidden = true;
    try {
      const body = link ? {} : { projectPath: $("whatsapp-project-path").value.trim() || undefined };
      const result = await api(link ? "/api/whatsapp/link" : "/api/whatsapp/connect", { method: "POST", body: JSON.stringify(body) });
      if (!whatsappFresh(token, opening)) return;
      renderWhatsAppStatus(result);
    } catch (error) { if (whatsappFresh(token, opening)) setError("whatsapp-error", error.message); }
    finally {
      if (whatsappFresh(token, opening)) {
        whatsappBusy = false;
        updateWhatsAppControls();
        maybeLoadWhatsAppChats();
      }
    }
  }

  async function loadWhatsAppChats() {
    if (whatsappBusy || whatsappChatsLoading || !canConfigure() || !whatsappStatus?.linked ||
        !$("order-whatsapp-dialog")?.open) return;
    const token = generation, opening = whatsappOpening, sequence = ++whatsappChatRequest;
    const selectedChat = $("whatsapp-chat").value;
    whatsappChatsAttempted = true;
    whatsappChatsLoading = true;
    whatsappChatsState = "loading";
    whatsappChatsError = "";
    renderWhatsAppChats();
    try {
      const result = await api("/api/whatsapp/chats");
      if (!whatsappFresh(token, opening) || sequence !== whatsappChatRequest) return;
      whatsappChats = result.chats || [];
      whatsappChatsTruncated = Boolean(result.truncated);
      whatsappChatsState = whatsappChats.length ? "loaded" : "empty";
      $("whatsapp-chat").innerHTML = html`<option value="">Select chat</option>${whatsappChats.map(chat => html`<option value="${esc(chat.id)}"${selectedChat === chat.id ? " selected" : ""}>${esc(chat.name)}</option>`).join("")}`;
      if (selectedChat && !$("whatsapp-chat").value) {
        whatsappPlan = null;
        renderWhatsAppPlan();
      }
    } catch (error) {
      if (whatsappFresh(token, opening) && sequence === whatsappChatRequest) {
        whatsappChatsState = "error";
        whatsappChatsError = error.message;
      }
    } finally {
      if (whatsappFresh(token, opening) && sequence === whatsappChatRequest) {
        whatsappChatsLoading = false;
        renderWhatsAppChats();
      }
    }
  }

  function renderWhatsAppPlan() {
    const plan = whatsappPlan;
    const candidates = plan?.candidates || [];
    $("whatsapp-plan").hidden = !plan;
    $("whatsapp-plan").innerHTML = plan ? html`<div class="section-heading"><h3>Order preview</h3><span class="section-count">${candidates.length}</span></div>
      <div class="whatsapp-preview-counts"><span>${uiText("Messages scanned")}: ${Number(plan.counts?.scanned || 0)}</span><span>${uiText("Duplicates skipped")}: ${Number(plan.counts?.duplicates || 0)}</span>${plan.truncated ? html`<span>Read limit reached</span>` : ""}</div>
      <div class="table-clip whatsapp-preview-table"><table class="data-table"><thead><tr><th>Customer</th><th>Fulfillment</th><th>Requested time</th><th>Notes</th></tr></thead><tbody>${candidates.map(candidate => {
        const order = candidate.draft || {};
        return html`<tr><td>${esc(order.customerName || "—")}</td><td>${order.fulfillment ? uiText(order.fulfillment === "pickup" ? "Pickup" : "Delivery") : "—"}</td><td>${esc(order.requestedTime || "—")}</td><td>${esc(order.notes || "—")}${candidate.text ? html`<details class="whatsapp-source-message"><summary>Customer message</summary><p>${esc(candidate.text)}</p></details>` : ""}</td></tr>`;
      }).join("")}</tbody></table>${candidates.length ? "" : html`<div class="workflow-empty">No new orders found</div>`}</div>` : "";
    updateWhatsAppControls();
  }

  async function previewWhatsAppOrders() {
    if (whatsappBusy || whatsappChatsLoading || !canConfigure() || !whatsappStatus?.linked ||
        !$("order-whatsapp-dialog")?.open) return;
    const chatId = $("whatsapp-chat").value;
    if (!chatId) return setError("whatsapp-error", "Select a chat first.");
    const limit = Number($("whatsapp-limit").value);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) return setError("whatsapp-error", "Choose a message limit from 1 to 50.");
    const token = generation, opening = whatsappOpening;
    whatsappBusy = true; whatsappPlan = null; renderWhatsAppPlan();
    $("whatsapp-result").hidden = true;
    $("whatsapp-error").hidden = true;
    try {
      const result = await api("/api/whatsapp/preview", { method: "POST", body: JSON.stringify({ chatId, hours: Number($("whatsapp-hours").value), limit }) });
      if (!whatsappFresh(token, opening)) return;
      whatsappPlan = result;
      renderWhatsAppPlan();
    } catch (error) { if (whatsappFresh(token, opening)) setError("whatsapp-error", error.message); }
    finally { if (whatsappFresh(token, opening)) { whatsappBusy = false; updateWhatsAppControls(); } }
  }

  async function importWhatsAppOrders() {
    if (whatsappBusy || whatsappChatsLoading || !canConfigure() || !whatsappStatus?.linked ||
        !$("order-whatsapp-dialog")?.open || !whatsappPlan?.candidates?.length) return;
    const token = generation, opening = whatsappOpening;
    whatsappBusy = true; updateWhatsAppControls();
    $("whatsapp-error").hidden = true;
    try {
      const result = await api("/api/whatsapp/import", { method: "POST", body: JSON.stringify({ planId: whatsappPlan.planId, fingerprint: whatsappPlan.fingerprint }) });
      if (!whatsappFresh(token, opening)) return;
      whatsappPlan = null; renderWhatsAppPlan();
      const imported = Number(result.imported ?? result.orders?.length ?? 0);
      $("whatsapp-result").hidden = false;
      $("whatsapp-result").innerHTML = html`<strong>${uiText("Orders imported")}: ${imported}</strong><span>${uiText("Awaiting verification")}</span>${(result.orders || []).map(order => html`<button type="button" class="order-number-link" data-order-open="${esc(order.id)}">${esc(orderNumber(order))}</button>`).join("")}`;
      toast("WhatsApp orders imported for verification.");
      changed();
      await load();
    } catch (error) { if (whatsappFresh(token, opening)) setError("whatsapp-error", error.message); }
    finally { if (whatsappFresh(token, opening)) { whatsappBusy = false; updateWhatsAppControls(); } }
  }

  async function handleClick(event) {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.dataset.orderNew !== undefined) { openEditor(); return; }
    if (button.dataset.orderRefresh !== undefined) { await load(); return; }
    if (button.dataset.orderTab) { activeTab = button.dataset.orderTab; renderRoot(); return; }
    if (button.dataset.orderOpen) {
      if ($("order-whatsapp-dialog")?.open) $("order-whatsapp-dialog").close();
      await openDetail(button.dataset.orderOpen); return;
    }
    if (button.dataset.orderTransition) { await transition(button.dataset.orderTransition); return; }
    if (button.id === "order-detail-edit" || button.dataset.orderReview !== undefined) { $("order-detail-dialog").close(); openEditor(selected); return; }
    if (button.dataset.orderInvoice !== undefined) { openTransaction(); return; }
    if (button.dataset.orderNotify !== undefined) { await prepareNotification(); return; }
    if (button.dataset.orderWhatsapp !== undefined) { await openWhatsApp(); return; }
    if (button.dataset.copyNotification && await copy(button.dataset.copyNotification)) toast("Message copied.");
  }

  function handleInput(event) {
    const target = event.target;
    if (busy && target.matches("[data-attachment-upload]")) {
      target.value = "";
      event.stopPropagation();
      return;
    }
    if (target.matches("[data-order-search]")) { query = target.value; renderRoot(); return; }
    if (target.matches("[data-order-status]")) { statusFilter = target.value; renderRoot(); return; }
    if (target.matches("[data-order-delivery]")) { deliveryFilter = target.value; renderRoot(); return; }
    if (target.matches("[data-order-sort]")) { sort = target.value; renderRoot(); return; }
    if (target.id === "order-paid-check") { if (event.type === "change") confirmPayment(target.checked); return; }
    if (target.closest("#order-editor-dialog") && target.id !== "order-review-check") {
      $("order-review-check").checked = false;
    }
    if (target.closest("#order-editor-dialog")) updateBusyControls();
  }

  function mount() {
    if (mounted) return;
    root.addEventListener("click", handleClick);
    root.addEventListener("input", handleInput);
    root.addEventListener("change", handleInput);
    document.body.insertAdjacentHTML("beforeend", html`
      <dialog class="modal order-editor-dialog" id="order-editor-dialog" data-orders-dialog aria-labelledby="order-editor-title">
        <div class="modal-heading"><div><span class="eyebrow" id="order-editor-kicker">AI ORDER CAPTURE</span><h2 id="order-editor-title">New order</h2></div><button type="button" class="icon-button" data-order-close="order-editor-dialog" ${uiAttributes("Close")}>${icon("x")}</button></div>
        <div class="order-ai-capture"><label class="builder-label" for="order-source-text">Customer message</label><textarea id="order-source-text" rows="4" maxlength="40000" placeholder="Paste a WhatsApp order or customer message here..."></textarea><div class="order-ai-actions"><button type="button" class="button button-secondary" id="order-extract">${icon("sparkles")}<span id="order-extract-label">Import order</span></button></div></div>
        <div class="form-fields order-editor-fields">
          <div class="order-field-grid"><label class="input-field"><span class="builder-label">Customer</span><input class="standalone-input" id="order-customer-name" maxlength="200"></label><label class="input-field"><span class="builder-label">Phone</span><input class="standalone-input" id="order-customer-phone" maxlength="80"></label><label class="input-field"><span class="builder-label">Department</span><input class="standalone-input" id="order-department" maxlength="200"></label><label class="input-field"><span class="builder-label">Salesperson</span><input class="standalone-input" id="order-salesperson" maxlength="200"></label></div>
          <div class="order-field-grid"><label class="input-field"><span class="builder-label">Fulfillment</span><select class="standalone-input" id="order-fulfillment"><option value="">Select an option</option><option value="delivery">Delivery</option><option value="pickup">Pickup</option></select></label><label class="input-field order-span-2"><span class="builder-label">Delivery address</span><input class="standalone-input" id="order-address" maxlength="2000"></label><label class="input-field"><span class="builder-label">Requested time</span><input class="standalone-input" id="order-requested-time" placeholder="Original customer wording" maxlength="500"></label><label class="input-field"><span class="builder-label">Estimated delivery</span><input class="standalone-input" id="order-estimated-date" type="datetime-local"></label><label class="input-field"><span class="builder-label">Order amount (MYR)</span><input class="standalone-input" id="order-total-amount" type="number" min="0" max="1000000000000" step="0.01" inputmode="decimal"></label></div>
          <label class="input-field"><span class="builder-label">Notes</span><textarea class="standalone-input order-notes-input" id="order-notes" rows="3" maxlength="10000"></textarea></label>
          <div id="order-attachment-field"></div>
          <div class="order-extraction-issues" id="order-extraction-issues" hidden></div>
          <label class="order-review-check"><input type="checkbox" id="order-review-check"><span>I reviewed the customer details, product notes, fulfillment and order amount.</span></label>
        </div>
        <div class="form-error" id="order-editor-error" role="alert" hidden></div><div class="modal-actions"><button type="button" class="button button-secondary" data-order-close="order-editor-dialog">Cancel</button><button type="button" class="button button-primary" id="order-editor-save">${icon("check")}<span id="order-editor-save-label">Save draft</span></button></div>
      </dialog>
      <dialog class="modal order-detail-dialog" id="order-detail-dialog" data-orders-dialog aria-labelledby="order-detail-title">
        <div class="modal-heading"><div><span class="eyebrow">ORDER DETAIL</span><h2 id="order-detail-title">Order</h2></div><div class="order-detail-head-actions"><span id="order-detail-status"></span><button type="button" class="icon-button" data-order-close="order-detail-dialog" ${uiAttributes("Close")}>${icon("x")}</button></div></div>
        <div id="order-detail-body"></div><div class="modal-actions"><button type="button" class="button button-secondary" id="order-detail-edit">${icon("pencil")}<span>Edit order</span></button><button type="button" class="button button-secondary" data-order-close="order-detail-dialog">Close</button></div>
      </dialog>
      <dialog class="modal order-transaction-dialog compact-dialog" id="order-transaction-dialog" data-orders-dialog aria-labelledby="order-transaction-title">
        <div class="modal-heading"><h2 id="order-transaction-title">Record invoice</h2><button type="button" class="icon-button" data-order-close="order-transaction-dialog" ${uiAttributes("Close")}>${icon("x")}</button></div>
        <form id="order-transaction-form"><label class="input-field"><span class="builder-label">Invoice number</span><input class="standalone-input" id="transaction-reference" maxlength="200" required></label><label class="input-field"><span class="builder-label">Amount</span><input class="standalone-input" id="transaction-amount" type="number" min="0.01" max="1000000000000" step="0.01" required></label><label class="input-field"><span class="builder-label">Notes</span><textarea class="standalone-input" id="transaction-notes" rows="3" maxlength="2000"></textarea></label><div class="form-error" id="order-transaction-error" role="alert" hidden></div><div class="modal-actions"><button type="button" class="button button-secondary" data-order-close="order-transaction-dialog">Cancel</button><button type="submit" class="button button-primary" id="order-transaction-save">${icon("check")}<span>Save</span></button></div></form>
      </dialog>
      <dialog class="modal order-whatsapp-dialog" id="order-whatsapp-dialog" data-orders-dialog aria-labelledby="whatsapp-title">
        <div class="modal-heading"><h2 id="whatsapp-title">WhatsApp</h2><button type="button" class="icon-button" data-order-close="order-whatsapp-dialog" ${uiAttributes("Close")}>${icon("x")}</button></div>
        <div class="whatsapp-connection-status"><span id="whatsapp-status" role="status"></span><button type="button" class="icon-button" id="whatsapp-refresh" ${uiAttributes("Refresh connection")}>${icon("refresh-cw")}</button></div>
        <div class="form-error" id="whatsapp-connection-error" role="alert" hidden></div>
        <div class="whatsapp-connection"><label class="input-field"><span class="builder-label">Connector project folder</span><input class="standalone-input" id="whatsapp-project-path" maxlength="1000"></label><div class="detail-button-row"><button type="button" class="button button-secondary" id="whatsapp-connect">${icon("plug")}<span id="whatsapp-connect-label">Start connector</span></button><button type="button" class="button button-secondary" id="whatsapp-link">${icon("qr-code")}<span>Link WhatsApp</span></button></div></div>
        <div class="whatsapp-qr" id="whatsapp-qr" hidden></div>
        <div class="section-heading whatsapp-chats-heading"><h3>Chats</h3><div class="whatsapp-chat-tools"><span class="section-count" id="whatsapp-chat-count">0</span><button type="button" class="button button-secondary" id="whatsapp-load-chats">${icon("refresh-cw")}<span>Refresh chats</span></button></div></div>
        <p class="whatsapp-chats-status" id="whatsapp-chats-status" role="status" hidden></p>
        <div class="whatsapp-import-fields"><label class="input-field"><span class="builder-label">Chat</span><select class="standalone-input" id="whatsapp-chat"><option value="">Select chat</option></select></label><label class="input-field"><span class="builder-label">Time range</span><select class="standalone-input" id="whatsapp-hours"><option value="1">Last hour</option><option value="6">Last 6 hours</option><option value="24" selected>Last 24 hours</option><option value="168">Last 7 days</option></select></label><label class="input-field"><span class="builder-label">Message limit</span><input class="standalone-input" id="whatsapp-limit" type="number" min="1" max="50" value="10" step="1"></label></div>
        <div class="detail-button-row"><button type="button" class="button button-secondary" id="whatsapp-preview">${icon("scan-text")}<span>Preview orders</span></button></div>
        <div id="whatsapp-plan" hidden></div><div id="whatsapp-result" class="whatsapp-import-result" role="status" hidden></div>
        <div class="form-error" id="whatsapp-error" role="alert" hidden></div>
        <div class="modal-actions"><button type="button" class="button button-secondary" data-order-close="order-whatsapp-dialog">Close</button><button type="button" class="button button-primary" id="whatsapp-import" disabled>${icon("import")}<span>Import for verification</span></button></div>
      </dialog>`);
    $("order-editor-dialog").addEventListener("click", handleDialogClick);
    $("order-detail-dialog").addEventListener("click", handleDialogClick);
    $("order-transaction-dialog").addEventListener("click", handleDialogClick);
    $("order-whatsapp-dialog").addEventListener("click", handleDialogClick);
    $("order-whatsapp-dialog").addEventListener("close", () => { if (!$("order-whatsapp-dialog").open) resetWhatsAppDialog(); });
    $("order-detail-dialog").addEventListener("change", handleInput);
    $("order-editor-dialog").addEventListener("input", handleInput);
    $("order-editor-dialog").addEventListener("change", handleInput);
    $("order-extract").onclick = extractDraft;
    $("order-editor-save").onclick = saveEditor;
    $("order-transaction-form").onsubmit = submitTransaction;
    $("whatsapp-refresh").onclick = () => loadWhatsAppStatus();
    $("whatsapp-connect").onclick = () => connectWhatsApp();
    $("whatsapp-link").onclick = () => connectWhatsApp(true);
    $("whatsapp-load-chats").onclick = loadWhatsAppChats;
    $("whatsapp-preview").onclick = previewWhatsAppOrders;
    $("whatsapp-import").onclick = importWhatsAppOrders;
    ["whatsapp-chat", "whatsapp-hours", "whatsapp-limit"].forEach(id => {
      $(id).addEventListener("change", () => { whatsappPlan = null; renderWhatsAppPlan(); });
    });
    document.querySelectorAll("dialog[data-orders-dialog]").forEach(dialog => {
      dialog.addEventListener("cancel", event => { if (editorLocked()) event.preventDefault(); });
    });
    mounted = true;
    icons();
  }

  function handleDialogClick(event) {
    const close = event.target.closest("[data-order-close]");
    if (close) { const dialog = $(close.dataset.orderClose); if (dialog && !editorLocked()) dialog.close(); return; }
    handleClick(event);
  }

  document.addEventListener("languagechange", () => {
    if (!active) return;
    renderRoot();
    if ($("order-detail-dialog")?.open && selected) renderDetail(selected);
    if ($("order-whatsapp-dialog")?.open) {
      if (whatsappStatus) renderWhatsAppStatus(whatsappStatus);
      renderWhatsAppChats();
      renderWhatsAppPlan();
    }
  });

  return {
    enter(view) {
      if (view !== "orders" || !orderState().enabled) {
        if (active) { active = false; ++generation; ++request; ++detailRequest; busy = false; closeOwnedDialogs(); }
        return;
      }
      if (!active) { active = true; ++generation; }
      mount();
      renderRoot();
      load();
    },
    reset() {
      active = false; ++generation; ++request; ++detailRequest; busy = false; closeOwnedDialogs();
      if (mounted) root.replaceChildren();
    },
    refresh: load,
    open: openDetail,
  };
}
