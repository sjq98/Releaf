import { html, uiText, uiAttributes, t, getLocale } from "/i18n.js";

const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const icon = name => `<i data-lucide="${name}" aria-hidden="true"></i>`;
const number = value => value == null ? "-" : new Intl.NumberFormat(getLocale(), Math.abs(value) > 0 && Math.abs(value) < 0.001 ? { maximumSignificantDigits: 4 } : { maximumFractionDigits: 3 }).format(value);
const month = value => new Intl.DateTimeFormat(getLocale(), { year: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${value}-01T00:00:00Z`));
const option = (value, label, selected) => `<option value="${esc(value)}"${value === selected ? " selected" : ""}>${esc(label)}</option>`;
const reference = (formId, recordId, label) => html`<a class="reference-link" data-reference href="?formId=${esc(formId)}&recordId=${esc(recordId)}#records">${esc(label)}</a>`;
const PAGE_SIZE = 12;

export function initInventoryDashboard({ api, icons, getState, showView, toast }) {
  const root = document.getElementById("view-inventory-dashboard");
  let report = null, selection = {}, spaceId = null, sequence = 0, busy = false;
  let warningPage = 0, reportPage = 0, lowOnly = false, charts = [];
  const active = () => getState().user && getState().view === "inventory-dashboard";
  const current = () => getState();
  const disposeCharts = () => { charts.forEach(chart => chart.destroy()); charts = []; };

  function paging(id, page, total) {
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    return html`<div class="inventory-pagination"><span>${esc(number(total))} ${uiText("rows")}</span><div><button type="button" class="icon-button" data-dashboard-page="${id}" data-page="${page - 1}" ${page < 1 ? "disabled" : ""} ${uiAttributes("Previous page")}>${icon("chevron-left")}</button><span>${page + 1} / ${pages}</span><button type="button" class="icon-button" data-dashboard-page="${id}" data-page="${page + 1}" ${page + 1 >= pages ? "disabled" : ""} ${uiAttributes("Next page")}>${icon("chevron-right")}</button></div></div>`;
  }

  function stockRows() {
    return report.warnings.filter(row => !lowOnly || row.isLow);
  }

  function monthlyRows() {
    return [...report.reportRows].sort((a, b) => b.month.localeCompare(a.month) || a.code.localeCompare(b.code) || a.warehouseName.localeCompare(b.warehouseName));
  }

  function warningTable() {
    const rows = stockRows();
    warningPage = Math.min(warningPage, Math.max(0, Math.ceil(rows.length / PAGE_SIZE) - 1));
    return html`<div class="inventory-table-scroll"><table class="data-table inventory-warning-table" aria-label="Stock alerts"><thead><tr><th>Product</th><th>Warehouse</th><th class="inventory-numeric">Current stock</th><th class="inventory-numeric">Minimum stock</th><th class="inventory-numeric">Shortage</th><th>Stock status</th></tr></thead><tbody>${rows.slice(warningPage * PAGE_SIZE, (warningPage + 1) * PAGE_SIZE).map(row => html`<tr class="${row.isLow ? "inventory-low-row" : ""}"><td><div class="inventory-product">${reference(report.tables.stock, row.stockId, row.name)}<small>${esc(row.code)}</small></div></td><td>${esc(row.warehouseName)}</td><td class="inventory-numeric"><strong>${number(row.currentQuantity)}</strong> <small>${esc(row.unit)}</small></td><td class="inventory-numeric">${number(row.minimum)}</td><td class="inventory-numeric ${row.isLow ? "inventory-shortage" : ""}">${row.shortage ? number(row.shortage) : "-"}</td><td><span class="inventory-stock-status ${row.isLow ? "is-low" : ""}">${icon(row.isLow ? "triangle-alert" : "circle-check")}${uiText(row.isLow ? "Below minimum" : "Healthy")}</span></td></tr>`).join("")}</tbody></table>${rows.length ? "" : html`<div class="inventory-empty">${icon("package-check")}<span>${uiText(lowOnly ? "No low-stock items" : "No stock entries yet")}</span></div>`}</div>${paging("warnings", warningPage, rows.length)}`;
  }

  function monthlyTable() {
    const rows = monthlyRows();
    reportPage = Math.min(reportPage, Math.max(0, Math.ceil(rows.length / PAGE_SIZE) - 1));
    return html`<div class="inventory-table-scroll inventory-monthly-scroll"><table class="data-table inventory-monthly-table" aria-label="Monthly inventory report"><thead><tr><th>Product</th><th>Warehouse</th><th>Month</th><th class="inventory-numeric">Opening stock</th><th class="inventory-numeric">Closing stock</th><th class="inventory-numeric" ${uiAttributes("Outbound quantity divided by average opening and closing stock.")}>Turnover rate</th><th class="inventory-numeric" ${uiAttributes("Calendar days in the month divided by turnover rate.")}>Turnover days</th><th class="inventory-numeric">Inbound quantity</th><th class="inventory-numeric">Outbound quantity</th><th class="inventory-numeric" ${uiAttributes("Signed reversal movements in this month.")}>Stock adjustments</th></tr></thead><tbody>${rows.slice(reportPage * PAGE_SIZE, (reportPage + 1) * PAGE_SIZE).map(row => html`<tr><td><div class="inventory-product">${reference(report.tables.products, row.productId, row.name)}<small>${esc(row.code)} / ${esc(row.unit)}</small></div></td><td>${esc(row.warehouseName)}</td><td class="inventory-month">${esc(month(row.month))}</td><td class="inventory-numeric">${number(row.openingQuantity)}</td><td class="inventory-numeric">${number(row.closingQuantity)}</td><td class="inventory-numeric">${row.turnoverRate == null ? "-" : `${number(row.turnoverRate)}x`}</td><td class="inventory-numeric">${number(row.turnoverDays)}</td><td class="inventory-numeric inventory-inbound-value">${number(row.inboundQuantity)}</td><td class="inventory-numeric inventory-outbound-value">${number(row.outboundQuantity)}</td><td class="inventory-numeric">${row.adjustmentQuantity > 0 ? "+" : ""}${number(row.adjustmentQuantity)}</td></tr>`).join("")}</tbody></table>${rows.length ? "" : html`<div class="inventory-empty">${icon("table-2")}<span>No inventory history in this period</span></div>`}</div>${paging("report", reportPage, rows.length)}`;
  }

  function renderCharts() {
    disposeCharts();
    if (!window.Chart) return;
    for (const [kind, color, fill, label] of [
      ["outbound", "#7257c9", "#7257c914", "Outbound quantity"],
      ["inbound", "#14857e", "#14857e14", "Inbound quantity"],
    ]) {
      const canvas = root.querySelector(`#inventory-chart-${kind}`);
      if (!canvas) continue;
      charts.push(new window.Chart(canvas, {
        type: "line",
        data: {
          labels: report.trends.points.map(point => month(point.month)),
          datasets: [{ label: `${t(label)} (${report.trends.unit ?? ""})`, data: report.trends.points.map(point => point[kind]), borderColor: color, backgroundColor: fill, borderWidth: 2, fill: true, tension: 0.28, pointRadius: 3, pointHoverRadius: 5, pointBackgroundColor: "#ffffff", pointBorderWidth: 2 }],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          animation: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? false : { duration: 300 },
          interaction: { intersect: false, mode: "index" },
          plugins: {
            legend: { display: false },
            tooltip: { displayColors: false, backgroundColor: "#30313f", padding: 10, callbacks: { label: context => `${number(context.parsed.y)} ${report.trends.unit ?? ""}` } },
          },
          scales: {
            x: { grid: { display: false }, border: { display: false }, ticks: { color: "#747789", font: { family: "'Segoe UI', Arial, sans-serif", size: 11 }, maxRotation: 0, maxTicksLimit: 6 } },
            y: { beginAtZero: true, border: { display: false }, grid: { color: "#edf0f4", drawTicks: false }, ticks: { color: "#747789", padding: 10, maxTicksLimit: 5, callback: value => number(value), font: { size: 11 } } },
          },
        },
      }));
    }
  }

  function render() {
    if (!report || !active()) return;
    disposeCharts();
    const { filters, available, summary } = report;
    const range = `${month(filters.from)} - ${month(filters.to)}`;
    const total = summary.inventory.find(item => item.unit === filters.unit)?.quantity ?? 0;
    const chart = (kind, heading, label, glyph) => {
      const values = report.trends.points.map(point => point[kind]);
      const sum = values.reduce((a, b) => a + b, 0);
      return html`<section class="inventory-chart-block ${kind}" aria-labelledby="inventory-${kind}-title"><div class="inventory-chart-heading"><h2 id="inventory-${kind}-title">${icon(glyph)}${uiText(heading)}</h2><span class="inventory-chart-unit">${esc(filters.unit)}</span></div><div class="inventory-chart-total"><strong>${number(Number(sum.toPrecision(14)))}</strong><span>${uiText(label)}</span></div><div class="inventory-chart-frame"><canvas id="inventory-chart-${kind}" role="img" aria-label="${t(heading)}" data-i18n-aria-label="${heading}"></canvas></div><details class="inventory-chart-data"><summary>Monthly quantities</summary><table class="data-table"><thead><tr><th>Month</th><th>${uiText(label)}</th></tr></thead><tbody>${report.trends.points.map(point => html`<tr><td>${esc(month(point.month))}</td><td>${number(point[kind])} ${esc(filters.unit)}</td></tr>`).join("")}</tbody></table></details></section>`;
    };
    root.innerHTML = html`<header class="page-heading inventory-heading"><div><div class="eyebrow">${esc(current().space.name)}</div><h1>Inventory analysis</h1><p class="inventory-period">${esc(range)}</p></div><div class="inventory-heading-actions"><button class="button button-secondary" data-dashboard-workflows>${icon("workflow")}<span>Warehouse workflows</span></button><button class="icon-button toolbar-icon" data-dashboard-refresh ${uiAttributes("Refresh dashboard")}>${icon("refresh-cw")}</button></div></header>
      ${report.setupRequired ? html`<div class="empty-state"><span class="empty-mark">${icon("warehouse")}</span><h2>No warehouse system in this Space</h2>${current().permissions.manageForms ? html`<button class="button button-primary" data-dashboard-workflows>${icon("plus")}<span>Set up warehouse</span></button>` : ""}</div>` : html`
      <form class="inventory-filters" id="inventory-filter-form"><label><span>From month</span><input type="month" name="from" required value="${filters.from}" max="${filters.to}" aria-label="From month"></label><label><span>To month</span><input type="month" name="to" required value="${filters.to}" min="${filters.from}" aria-label="To month"></label><label class="inventory-warehouse-filter"><span>Warehouse</span><select name="warehouseId" aria-label="Warehouse"><option value="">All warehouses</option>${available.warehouses.map(row => option(row.id, row.name, filters.warehouseId)).join("")}</select></label><label class="inventory-product-filter"><span>Product</span><select name="productId" aria-label="Product"><option value="">All products</option>${available.products.map(row => option(row.id, `${row.name} (${row.code})`, filters.productId)).join("")}</select></label><label><span>Unit</span><select name="unit" aria-label="Unit">${available.units.map(unit => option(unit, unit, filters.unit)).join("")}</select></label><button type="submit" class="icon-button toolbar-icon inventory-apply" ${uiAttributes("Apply filters")}>${icon("arrow-right")}</button></form>
      <div class="inventory-kpis" aria-label="Inventory overview">
        <div class="inventory-kpi"><span class="inventory-kpi-label">${icon("boxes")}<span>Current stock</span></span><strong>${number(total)} <small>${esc(filters.unit)}</small></strong><span class="inventory-kpi-foot"><span>${number(summary.stockItems)}</span> ${uiText("stock positions")}</span></div>
        <div class="inventory-kpi ${summary.lowStockItems ? "has-alert" : ""}"><span class="inventory-kpi-label">${icon("triangle-alert")}<span>Low-stock items</span></span><strong>${number(summary.lowStockItems)}</strong><span class="inventory-kpi-foot">Current balance</span></div>
        <div class="inventory-kpi"><span class="inventory-kpi-label">${icon("package-plus")}<span>Posted inbound</span></span><strong>${number(summary.inboundDocuments)}</strong><span class="inventory-kpi-foot">Documents in period</span></div>
        <div class="inventory-kpi"><span class="inventory-kpi-label">${icon("package-minus")}<span>Posted outbound</span></span><strong>${number(summary.outboundDocuments)}</strong><span class="inventory-kpi-foot">Documents in period</span></div>
      </div>
      <div class="inventory-trends">${chart("outbound", "Outbound trend", "Outbound quantity", "trending-up")}${chart("inbound", "Inbound trend", "Inbound quantity", "trending-down")}</div>
      <section class="inventory-section" aria-labelledby="inventory-warnings-title"><div class="inventory-section-heading"><div><h2 id="inventory-warnings-title">${icon("bell-ring")}<span>Stock alerts</span><span class="inventory-alert-count">${number(summary.lowStockItems)}</span></h2><span class="inventory-section-meta">Current balance</span></div><div class="inventory-section-actions"><div class="inventory-segment" role="group" aria-label="Stock alert filter"><button type="button" data-dashboard-low="false" aria-pressed="${!lowOnly}">All stock</button><button type="button" data-dashboard-low="true" aria-pressed="${lowOnly}">Low stock</button></div><button class="icon-button" data-table="${report.tables.stock}" ${uiAttributes("View stock")}>${icon("arrow-up-right")}</button></div></div><div id="inventory-warnings-body">${warningTable()}</div></section>
      <section class="inventory-section" aria-labelledby="inventory-report-title"><div class="inventory-section-heading"><div><h2 id="inventory-report-title">${icon("table-properties")}<span>Monthly inventory report</span></h2><span class="inventory-section-meta">${esc(range)}</span></div><button class="icon-button" data-dashboard-export ${uiAttributes("Export report")}>${icon("download")}</button></div><div id="inventory-report-body">${monthlyTable()}</div></section>
      <footer class="inventory-footer"><span>${icon("circle-check")}<span>Posted ledger</span></span><time datetime="${esc(report.updatedAt)}">${esc(new Intl.DateTimeFormat(getLocale(), { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Singapore" }).format(new Date(report.updatedAt)))}</time></footer>`}`;
    icons();
    if (!report.setupRequired) renderCharts();
  }

  async function load() {
    if (!active() || !current().space) return;
    const request = ++sequence, currentSpace = current().space.id;
    if (spaceId !== currentSpace) { selection = {}; report = null; warningPage = reportPage = 0; lowOnly = false; spaceId = currentSpace; }
    const params = new URLSearchParams({ spaceId: currentSpace });
    for (const [key, value] of Object.entries(selection)) if (value) params.set(key, value);
    busy = true;
    root.setAttribute("aria-busy", "true");
    if (!report) root.innerHTML = html`<div class="page-heading"><h1>Inventory analysis</h1></div><div class="inventory-loading" role="status">${icon("loader-circle")}<span>Loading inventory analysis...</span></div>`;
    root.querySelectorAll("[data-dashboard-refresh], .inventory-apply").forEach(control => { control.disabled = true; });
    try {
      const result = await api(`/api/warehouse/dashboard?${params}`);
      if (request !== sequence || !active() || current().space?.id !== currentSpace) return;
      report = result;
      selection = { ...result.filters };
      render();
    } catch (error) {
      if (request !== sequence || !active()) return;
      if (report) toast(error.message, true);
      else root.innerHTML = html`<div class="page-heading"><h1>Inventory analysis</h1></div><div class="inventory-empty" role="alert">${icon("circle-alert")}<span>${uiText(error.message)}</span><button class="button button-secondary" data-dashboard-refresh>${icon("refresh-cw")}<span>Retry</span></button></div>`;
    } finally {
      if (request === sequence) {
        busy = false;
        root.removeAttribute("aria-busy");
        root.querySelectorAll("[data-dashboard-refresh], .inventory-apply").forEach(control => { control.disabled = false; });
        icons();
      }
    }
  }

  function exportReport() {
    const headers = ["Product code", "Product", "Warehouse", "Unit", "Month", "Opening stock", "Closing stock", "Turnover rate", "Turnover days", "Inbound quantity", "Outbound quantity", "Stock adjustments"].map(t);
    const cell = value => {
      let text = String(value ?? "");
      if (typeof value === "string" && /^[\s]*[=+@\-\t\r]/.test(text)) text = `'${text}`;
      return `"${text.replaceAll('"', '""')}"`;
    };
    const rows = monthlyRows().map(row => [row.code, row.name, row.warehouseName, row.unit, row.month, row.openingQuantity, row.closingQuantity, row.turnoverRate, row.turnoverDays, row.inboundQuantity, row.outboundQuantity, row.adjustmentQuantity]);
    const file = new Blob(["\uFEFF", [headers, ...rows].map(row => row.map(cell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(file), link = document.createElement("a");
    link.href = url; link.download = `inventory-${report.filters.from}-${report.filters.to}.csv`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  root.addEventListener("submit", event => {
    event.preventDefault();
    if (busy || !event.target.reportValidity()) return;
    selection = Object.fromEntries(new FormData(event.target));
    warningPage = reportPage = 0;
    load();
  });
  root.addEventListener("change", event => {
    if (event.target.name !== "productId" || !event.target.value) return;
    const product = report?.available.products.find(row => row.id === event.target.value);
    if (product) root.querySelector('[name="unit"]').value = product.unit;
  });
  root.addEventListener("click", event => {
    const target = event.target.closest("button");
    if (!target) return;
    if (target.hasAttribute("data-dashboard-refresh")) load();
    if (target.hasAttribute("data-dashboard-workflows")) showView("warehouse-flows");
    if (target.hasAttribute("data-dashboard-export")) exportReport();
    if (target.hasAttribute("data-dashboard-low")) { lowOnly = target.dataset.dashboardLow === "true"; warningPage = 0; render(); }
    if (target.hasAttribute("data-dashboard-page")) {
      if (target.dataset.dashboardPage === "warnings") warningPage = Number(target.dataset.page);
      else reportPage = Number(target.dataset.page);
      const container = root.querySelector(target.dataset.dashboardPage === "warnings" ? "#inventory-warnings-body" : "#inventory-report-body");
      container.innerHTML = target.dataset.dashboardPage === "warnings" ? warningTable() : monthlyTable();
      icons();
    }
  });
  document.addEventListener("languagechange", () => { if (active()) render(); });

  return {
    enter(view) {
      if (view === "inventory-dashboard") load();
      else { sequence++; busy = false; disposeCharts(); }
    },
    reset() {
      sequence++; busy = false; disposeCharts(); report = null; selection = {}; spaceId = null;
      warningPage = reportPage = 0; lowOnly = false; root.replaceChildren(); root.removeAttribute("aria-busy");
    },
  };
}
