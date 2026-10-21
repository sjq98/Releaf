import { AppError } from "./errors.js";
import { createMeetingAI } from "./meeting-ai.js";

function normalizeURL(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 2048) throw new AppError(400, "Enter a valid API base URL.");
  let url;
  try { url = new URL(value.trim()); }
  catch { throw new AppError(400, "Enter a valid API base URL."); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && local)) || url.username || url.password || url.search || url.hash) {
    throw new AppError(400, "Use an HTTPS API base URL without credentials, query parameters or fragments. HTTP is allowed only for local providers.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/(?:chat\/completions|models)$/, "");
  return url.toString().replace(/\/+$/, "");
}

export function createAIConfig({ store, env = process.env, fetchImpl = fetch, timeoutMs = 15000 }) {
  function current() {
    return store.getAIConfig() || {
      providerName: env.AI_PROVIDER_NAME || (env.AI_API_KEY || env.OPENAI_API_KEY ? "Environment provider" : ""),
      baseUrl: (env.AI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, ""),
      apiKey: env.AI_API_KEY || env.OPENAI_API_KEY || "",
      model: env.AI_MODEL || "",
    };
  }

  function publicConfig() {
    const { providerName, baseUrl, apiKey, model } = current();
    return { providerName, baseUrl, model, hasApiKey: Boolean(apiKey), configured: Boolean(apiKey && model),
      source: store.getAIConfig() ? "saved" : "environment" };
  }

  function credentials(body) {
    if (typeof body?.providerName !== "string" || !body.providerName.trim() || body.providerName.trim().length > 80) {
      throw new AppError(400, "Enter a provider name of 1-80 characters.");
    }
    const baseUrl = normalizeURL(body.baseUrl);
    if (body.apiKey !== undefined && typeof body.apiKey !== "string") throw new AppError(400, "Enter a valid API key.");
    let apiKey = body.apiKey?.trim() || "";
    if (!apiKey) {
      const saved = current();
      let savedURL;
      try { savedURL = normalizeURL(saved.baseUrl); } catch { /* Invalid environment URLs cannot receive a saved key. */ }
      if (savedURL === baseUrl) apiKey = saved.apiKey;
    }
    if (!apiKey || apiKey.length > 8192 || /[^\x21-\x7e]/.test(apiKey)) {
      throw new AppError(400, "Enter an API key. A saved key can only be reused with the same API base URL.");
    }
    return { providerName: body.providerName.trim(), baseUrl, apiKey };
  }

  async function fetchModels(config) {
    try {
      const response = await fetchImpl(`${config.baseUrl}/models`, {
        method: "GET", headers: { Authorization: `Bearer ${config.apiKey}`, Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs), redirect: "error",
      });
      if (!response.ok) {
        const detail = response.status === 401 || response.status === 403 ? "The provider rejected the API key."
          : response.status === 404 ? "The models endpoint was not found. Check the API base URL."
            : response.status === 429 ? "The provider rate limit was reached. Try again later."
              : `The provider returned HTTP ${response.status}.`;
        throw new AppError(502, detail);
      }
      const result = await response.json();
      if (!Array.isArray(result?.data) || result.data.length > 10000) throw new AppError(502, "The provider did not return an OpenAI-compatible model list.");
      const models = [...new Set(result.data.filter((item) => typeof item?.id === "string" && item.id.trim() && item.id.length <= 200).map((item) => item.id))].sort();
      if (!models.length) throw new AppError(502, "No models were returned for this API key.");
      return { models };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(502, error.name === "TimeoutError" ? "Loading models timed out. Check the provider URL and try again."
        : "Could not load models. Check the provider connection, API base URL and model-list format.");
    }
  }

  return {
    publicConfig,
    get status() {
      const { configured, model, providerName } = publicConfig();
      return { configured, model: configured ? model : null, providerName };
    },
    async models(body) { return fetchModels(credentials(body)); },
    async save(body) {
      const config = credentials(body);
      if (typeof body.model !== "string" || !body.model.trim() || body.model.length > 200) throw new AppError(400, "Select a model from the provider.");
      const { models } = await fetchModels(config);
      if (!models.includes(body.model)) throw new AppError(400, "The selected model is no longer available. Reload the provider's model list.");
      store.saveAIConfig({ ...config, model: body.model });
      return publicConfig();
    },
    async extract(input) {
      const config = current();
      const ai = createMeetingAI({ env: { AI_API_KEY: config.apiKey, AI_MODEL: config.model, AI_BASE_URL: config.baseUrl }, fetchImpl });
      return ai.extract(input);
    },
  };
}
