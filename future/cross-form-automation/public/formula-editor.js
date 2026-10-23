import { html, uiText, setUIText, uiAttributes, t } from "/i18n.js";
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

export function initFormulaEditor({ api, icons, getState }) {
  const dialog = document.createElement("dialog");
  dialog.className = "modal formula-dialog";
  dialog.innerHTML = html`<div class="modal-heading"><h2>Edit formula</h2><button type="button" class="icon-button" data-formula-close title="Close formula" aria-label="Close formula"><i data-lucide="x"></i></button></div>
    <div class="formula-picker"><label class="input-field"><span class="builder-label">Form</span><select id="formula-table"></select></label><label class="input-field"><span class="builder-label">Record scope</span><select id="formula-scope"></select></label><label class="input-field"><span class="builder-label">Field</span><select id="formula-field"></select></label><button type="button" class="icon-button" id="formula-insert" title="Insert field" aria-label="Insert field"><i data-lucide="plus"></i></button></div>
    <div class="formula-operators">${["+", "-", "*", "/", "%", "(", ")"].map((op) => html`<button type="button" data-formula-token="${op}" title="Insert ${op}">${op}</button>`).join("")}<select id="formula-function" aria-label="Insert function"><option value="">Function</option>${["SUM", "COUNT", "MIN", "MAX", "ROUND", "ABS", "COALESCE", "IF"].map((fn) => html`<option>${fn}</option>`).join("")}</select><input type="number" id="formula-number" step="any" aria-label="Numeric constant" placeholder="Number"><button class="icon-button" type="button" id="formula-insert-number" title="Insert number" aria-label="Insert number"><i data-lucide="plus"></i></button></div>
    <label class="input-field"><span class="builder-label">Expression</span><textarea class="formula-expression" id="formula-expression" rows="3" maxlength="2000" spellcheck="false"></textarea></label><div id="formula-bindings" class="formula-bindings"></div>
    <div id="formula-sample" class="formula-sample"></div><div id="formula-result" role="status"></div><div id="formula-error" class="form-error" role="alert" hidden></div>
    <div class="modal-actions"><button type="button" class="icon-button" id="formula-clear" title="Remove formula" aria-label="Remove formula"><i data-lucide="eraser"></i></button><button type="button" class="button button-secondary" id="formula-test"><i data-lucide="play"></i><span>Test</span></button><button type="button" class="button button-primary" id="formula-save"><i data-lucide="check"></i><span>Use formula</span></button></div>`;
  document.body.append(dialog);
  const $ = (id) => dialog.querySelector(`#formula-${id}`);
  let config, formula;
  const table = () => config.forms.find((form) => form.id === $("table").value);
  const error = (message = "") => { $("error").hidden = !message; setUIText($("error"), message); };
  function scopes() {
    const selected = table();
    const items = config.mode === "field" ? [["record", "Current record"], ["aggregate", "All records"]]
      : selected.id === config.sourceForm.id ? [["source", "Trigger: after"], ["before", "Trigger: before"], ...(selected.id === config.targetForm?.id ? [["target", "Current target"], ["output", "AI output"]] : []), ["lookup", "Latest record"], ["aggregate", "All records"]]
        : selected.id === config.targetForm?.id ? [["target", "Current target"], ["output", "AI output"], ["lookup", "Latest record"], ["aggregate", "All records"]]
          : [["lookup", "Latest record"], ["aggregate", "All records"]];
    $("scope").innerHTML = items.filter(([key]) => config.ai || key !== "output").map(([key, label]) => html`<option value="${key}">${uiText(label)}</option>`).join("");
    $("field").innerHTML = selected.fields.filter((field) => field.id !== config.fieldId && field.type === "number").map((field) => html`<option value="${field.id}">${esc(field.name)}</option>`).join("");
  }
  function bindings() {
    $("bindings").innerHTML = Object.entries(formula.bindings).map(([symbol, binding]) => {
      const form = config.forms.find((form) => form.id === binding.formId) ?? config.sourceForm;
      const field = form?.fields.find((field) => field.id === binding.fieldId);
      return html`<span class="formula-binding"><strong>${esc(symbol)}</strong><span>${esc(form?.name)} / ${esc(field?.name ?? binding.fieldId)} (${esc(binding.scope)})</span><button type="button" class="icon-button" data-remove-binding="${esc(symbol)}" title="Remove binding" aria-label="Remove ${esc(symbol)}"><i data-lucide="x"></i></button></span>`;
    }).join("");
    icons();
  }
  function insert(text) {
    const input = $("expression"), position = input.selectionStart;
    input.setRangeText(text, position, input.selectionEnd, "end"); input.focus(); error();
  }
  $("table").onchange = scopes;
  $("insert").onclick = () => {
    if (!$("field").value) return;
    let number = 1;
    while (formula.bindings[`v${number}`]) number++;
    const symbol = `v${number}`, scope = $("scope").value;
    formula.bindings[symbol] = { scope, fieldId: $("field").value, formId: table().id };
    if (scope === "aggregate" && config.mode !== "field") formula.bindings[symbol].aggregate = "SUM";
    insert(scope === "aggregate" && config.mode === "field" ? `SUM(${symbol})` : symbol);
    bindings();
  };
  $("function").onchange = () => { if ($("function").value) insert(`${$("function").value}(`); $("function").value = ""; };
  $("insert-number").onclick = () => { if ($("number").value !== "") insert($("number").value); };
  dialog.addEventListener("click", (event) => {
    const token = event.target.closest("[data-formula-token]"), remove = event.target.closest("[data-remove-binding]");
    if (token) insert(token.dataset.formulaToken);
    if (remove) { delete formula.bindings[remove.dataset.removeBinding]; bindings(); }
    if (event.target.closest("[data-formula-close]")) dialog.close();
  });
  $("clear").onclick = () => { config.onSave(null); dialog.close(); };
  $("test").onclick = async () => {
    error();
    try {
      formula.expression = $("expression").value;
      let result;
      if (config.mode === "field") {
        const fields = structuredClone(config.sourceForm.fields);
        fields.find((field) => field.id === config.fieldId).formula = formula;
        const values = Object.fromEntries([...$("sample").querySelectorAll("[data-sample]")].map((input) => [input.dataset.sample, input.value === "" ? null : Number(input.value)]));
        result = (await api("/api/formulas/preview", { method: "POST", body: JSON.stringify({ formId: config.sourceForm.id, recordId: getState().records[0]?.id, fields, values }) })).values[config.fieldId];
      } else result = (await api("/api/expressions/preview", { method: "POST", body: JSON.stringify({ formId: config.sourceForm.id, targetFormId: config.targetForm?.id, formula }) })).value;
      setUIText($("result"), `Result: ${result == null ? "Not set" : result}`);
    } catch (failure) { error(failure.message); }
  };
  $("save").onclick = () => {
    if (!$("expression").value.trim()) return error("Enter a formula or remove it.");
    formula.expression = $("expression").value;
    config.onSave(structuredClone(formula)); dialog.close();
  };
  return {
    open(options) {
      config = options;
      config.forms = options.mode === "field" ? [options.sourceForm] : getState().forms;
      formula = structuredClone(options.formula ?? { expression: "", bindings: {} });
      $("table").innerHTML = config.forms.map((form) => html`<option value="${form.id}">${esc(form.name)}</option>`).join("");
      $("table").value = options.sourceForm.id;
      $("table").disabled = config.mode === "field";
      $("expression").value = formula.expression;
      setUIText($("result"), ""); error(); scopes(); bindings();
      $("sample").innerHTML = config.mode === "field" ? options.sourceForm.fields.filter((field) => field.type === "number" && !field.formula && field.id !== options.fieldId).map((field) =>
        html`<label class="input-field"><span class="builder-label">${esc(field.name)}</span><input type="number" step="any" data-sample="${field.id}" value="${getState().records[0]?.values[field.id] ?? ""}"></label>`).join("") : "";
      dialog.showModal(); icons();
    },
  };
}
