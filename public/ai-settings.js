import { html, uiText, setUIText, uiAttributes, t, setUIAttribute } from "/i18n.js";
export function initAISettings({ api, icons, onSaved, canManage = () => true, namespace = "", endpoint = "/api/ai", triggerSelector = "[data-ai-settings]" }) {
  const $ = (id) => document.getElementById(namespace + id);
  const dialog = $("ai-settings-dialog");
  const form = $("ai-settings-form");
  const provider = $("ai-provider-name");
  const url = $("ai-base-url");
  const key = $("ai-api-key");
  const model = $("ai-model");
  let busy = false;
  let loaded = false;
  let modelsReady = false;
  let sequence = 0;

  function error(message = "") {
    setUIText($("ai-settings-error"), message);
    $("ai-settings-error").hidden = !message;
  }

  function setBusy(value) {
    busy = value;
    form.querySelectorAll("input,button").forEach((element) => { element.disabled = value; });
    model.disabled = value || !modelsReady;
    $("save-ai-settings").disabled = value || !modelsReady;
    $("ai-settings-form").setAttribute("aria-busy", String(value));
  }

  function options(models, selected = "") {
    model.replaceChildren(new Option("Select a model", ""));
    setUIText(model.options[0], "Select a model");
    for (const id of models) model.add(new Option(id, id));
    model.value = models.includes(selected) ? selected : "";
    modelsReady = models.length > 0;
    setBusy(busy);
  }

  function credentials() {
    return { providerName: provider.value.trim(), baseUrl: url.value.trim(), apiKey: key.value };
  }

  function validCredentials() {
    return [provider, url, key].every((input) => input.reportValidity());
  }

  async function open() {
    if (!canManage() || dialog.open) return;
    const request = ++sequence;
    form.reset();
    loaded = false;
    modelsReady = false;
    options([]);
    error();
    setUIText($("ai-key-state"), "");
    setUIText($("ai-model-state"), "");
    setBusy(true);
    dialog.showModal();
    try {
      const settings = await api(`${endpoint}/config`);
      if (request !== sequence || !canManage()) return;
      provider.value = settings.providerName;
      url.value = settings.baseUrl;
      key.required = !settings.hasApiKey;
      setUIAttribute(key, "placeholder", settings.hasApiKey ? "Leave blank to keep the saved key" : "Enter API key");
      setUIText($("ai-key-state"), settings.hasApiKey ? "Key saved on server" : "No key saved");
      options(settings.model ? [settings.model] : [], settings.model);
      setUIText($("ai-model-state"), settings.model ? "Saved model" : "");
      loaded = true;
    } catch (cause) { if (request === sequence) error(cause.message); }
    finally { if (request === sequence) { setBusy(false); if (loaded) provider.focus(); } }
  }

  function reset() {
    sequence++;
    busy = false; loaded = false; modelsReady = false;
    if (dialog.open) dialog.close();
    form.reset(); options([]); error();
    setUIText($("ai-key-state"), ""); setUIText($("ai-model-state"), "");
    setUIText($("save-ai-settings").querySelector("span"), "Save settings");
  }
  function close() { if (!busy) dialog.close(); }
  document.querySelectorAll(triggerSelector).forEach((button) => button.addEventListener("click", open));
  $("close-ai-settings").addEventListener("click", close);
  $("cancel-ai-settings").addEventListener("click", close);
  dialog.addEventListener("cancel", (event) => { if (busy) event.preventDefault(); });
  dialog.addEventListener("close", () => {
    key.value = "";
    key.type = "password";
    $("show-ai-key").setAttribute("aria-pressed", "false");
    setUIAttribute($("show-ai-key"), "aria-label", "Show API key");
    setUIAttribute($("show-ai-key"), "title", "Show API key");
    $("show-ai-key").innerHTML = html`<i data-lucide="eye" aria-hidden="true"></i>`;
    icons();
  });
  $("show-ai-key").addEventListener("click", () => {
    const visible = key.type === "password";
    key.type = visible ? "text" : "password";
    $("show-ai-key").setAttribute("aria-pressed", String(visible));
    setUIAttribute($("show-ai-key"), "aria-label", visible ? "Hide API key" : "Show API key");
    setUIAttribute($("show-ai-key"), "title", visible ? "Hide API key" : "Show API key");
    $("show-ai-key").innerHTML = html`<i data-lucide="${visible ? "eye-off" : "eye"}" aria-hidden="true"></i>`;
    icons();
  });
  for (const input of [url, key]) input.addEventListener("input", () => {
    options([]);
    setUIText($("ai-model-state"), "");
    error();
  });
  provider.addEventListener("input", () => error());
  $("load-ai-models").addEventListener("click", async () => {
    if (!canManage() || busy || !loaded || !validCredentials()) return;
    const request = sequence;
    const selected = model.value;
    const body = credentials();
    error();
    setBusy(true);
    setUIText($("ai-model-state"), "Loading models...");
    try {
      const result = await api(`${endpoint}/models`, { method: "POST", body: JSON.stringify(body) });
      if (request !== sequence || !canManage()) return;
      options(result.models, selected);
      setUIText($("ai-model-state"), `${result.models.length} ${result.models.length === 1 ? "model" : "models"} available`);
    } catch (cause) {
      if (request !== sequence) return;
      options([]);
      setUIText($("ai-model-state"), "");
      error(cause.message);
    } finally { if (request === sequence) setBusy(false); }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!canManage() || busy || !loaded || !modelsReady || !form.reportValidity()) return;
    const request = sequence;
    const body = { ...credentials(), model: model.value };
    error();
    setBusy(true);
    setUIText($("save-ai-settings").querySelector("span"), "Saving...");
    try {
      const settings = await api(`${endpoint}/config`, { method: "PUT", body: JSON.stringify(body) });
      if (request !== sequence || !canManage()) return;
      onSaved?.(settings);
      dialog.close();
    } catch (cause) { if (request === sequence) error(cause.message); }
    finally {
      if (request === sequence) {
        setBusy(false);
        setUIText($("save-ai-settings").querySelector("span"), "Save settings");
      }
    }
  });
  return { open, reset };
}
