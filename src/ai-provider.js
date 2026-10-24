function hostnameOf(baseUrl) {
  try { return new URL(baseUrl).hostname.toLowerCase(); }
  catch { return ""; }
}

export function isDeepSeek(config = {}) {
  const provider = typeof config.providerName === "string" ? config.providerName.trim().toLowerCase() : "";
  const hostname = hostnameOf(config.baseUrl);
  return provider === "deepseek" || provider.includes("deepseek") || hostname === "deepseek.com" ||
    hostname.endsWith(".deepseek.com");
}

export function structuredResponseFormat(config, name, schema) {
  if (isDeepSeek(config)) return { type: "json_object" };
  return { type: "json_schema", json_schema: { name, strict: true, schema } };
}

export function jsonOutputInstruction(config, schema) {
  return isDeepSeek(config)
    ? `Return exactly one valid JSON object only. Do not wrap it in Markdown, add commentary, or return an empty response. Required JSON Schema:
${JSON.stringify(schema)}`
    : "";
}
