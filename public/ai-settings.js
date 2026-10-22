export function initAISettings({ api, icons, onSaved, namespace = "", endpoint = "/api/ai", triggerSelector = "[data-ai-settings]" }) {
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

  function error(message = "") {
    $("ai-settings-error").textContent = message;
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
    if (dialog.open) return;
    form.reset();
    loaded = false;
    modelsReady = false;
    options([]);
    error();
    $("ai-key-state").textContent = "";
    $("ai-model-state").textContent = "";
    setBusy(true);
    dialog.showModal();
    try {
      const settings = await api(`${endpoint}/config`);
      provider.value = settings.providerName;
      url.value = settings.baseUrl;
      key.required = !settings.hasApiKey;
      key.placeholder = settings.hasApiKey ? "Leave blank to keep the saved key" : "Enter API key";
      $("ai-key-state").textContent = settings.hasApiKey ? "Key saved on server" : "No key saved";
      options(settings.model ? [settings.model] : [], settings.model);
      $("ai-model-state").textContent = settings.model ? "Saved model" : "";
      loaded = true;
    } catch (cause) { error(cause.message); }
    finally { setBusy(false); if (loaded) provider.focus(); }
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
    $("show-ai-key").setAttribute("aria-label", "Show API key");
    $("show-ai-key").title = "Show API key";
    $("show-ai-key").innerHTML = '<i data-lucide="eye" aria-hidden="true"></i>';
    icons();
  });
  $("show-ai-key").addEventListener("click", () => {
    const visible = key.type === "password";
    key.type = visible ? "text" : "password";
    $("show-ai-key").setAttribute("aria-pressed", String(visible));
    $("show-ai-key").setAttribute("aria-label", visible ? "Hide API key" : "Show API key");
    $("show-ai-key").title = visible ? "Hide API key" : "Show API key";
    $("show-ai-key").innerHTML = `<i data-lucide="${visible ? "eye-off" : "eye"}" aria-hidden="true"></i>`;
    icons();
  });
  for (const input of [url, key]) input.addEventListener("input", () => {
    options([]);
    $("ai-model-state").textContent = "";
    error();
  });
  provider.addEventListener("input", () => error());
  $("load-ai-models").addEventListener("click", async () => {
    if (busy || !loaded || !validCredentials()) return;
    const selected = model.value;
    const body = credentials();
    error();
    setBusy(true);
    $("ai-model-state").textContent = "Loading models...";
    try {
      const result = await api(`${endpoint}/models`, { method: "POST", body: JSON.stringify(body) });
      options(result.models, selected);
      $("ai-model-state").textContent = `${result.models.length} ${result.models.length === 1 ? "model" : "models"} available`;
    } catch (cause) {
      options([]);
      $("ai-model-state").textContent = "";
      error(cause.message);
    } finally { setBusy(false); }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy || !loaded || !modelsReady || !form.reportValidity()) return;
    const body = { ...credentials(), model: model.value };
    error();
    setBusy(true);
    $("save-ai-settings").querySelector("span").textContent = "Saving...";
    try {
      const settings = await api(`${endpoint}/config`, { method: "PUT", body: JSON.stringify(body) });
      onSaved(settings);
      dialog.close();
    } catch (cause) { error(cause.message); }
    finally {
      setBusy(false);
      $("save-ai-settings").querySelector("span").textContent = "Save settings";
    }
  });
  return { open };
}
