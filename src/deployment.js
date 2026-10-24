import { AppError } from "./errors.js";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const LOCAL_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function deploymentConfig(env = {}) {
  const hosted = env.RENDER === "true" || Boolean(env.RELEAF_PUBLIC_URL);
  if (!hosted) return { hosted: false, host: "127.0.0.1", origin: null };
  let url;
  try {
    url = new URL(env.RELEAF_PUBLIC_URL || env.RENDER_EXTERNAL_URL);
  } catch {
    throw new Error("Set RELEAF_PUBLIC_URL to the HTTPS website URL, or provide Render's RENDER_EXTERNAL_URL.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" ||
      url.search || url.hash || LOCAL_HOSTS.has(url.hostname)) {
    throw new Error("The public workspace URL must be an HTTPS origin without credentials, a path, query or fragment.");
  }
  return { hosted: true, host: "0.0.0.0", origin: url.origin, authority: url.host };
}

export function initializeHostedAdmin(auth, env, config) {
  if (!config.hosted || !auth.status().setupRequired) return;
  if (!env.RELEAF_ADMIN_USERNAME || !env.RELEAF_ADMIN_PASSWORD) {
    throw new Error("First hosted startup requires RELEAF_ADMIN_USERNAME and RELEAF_ADMIN_PASSWORD in the service environment.");
  }
  const { sessionToken } = auth.setup({
    username: env.RELEAF_ADMIN_USERNAME,
    displayName: env.RELEAF_ADMIN_DISPLAY_NAME || env.RELEAF_ADMIN_USERNAME,
    password: env.RELEAF_ADMIN_PASSWORD,
  });
  auth.logout(`releaf_session=${sessionToken}`);
}

export function assertWorkspaceRequest(request, pathname, config) {
  const origin = request.headers.origin;
  const authority = request.headers.host;
  if (config.hosted) {
    if (typeof authority !== "string" || authority.toLowerCase() !== config.authority.toLowerCase()) {
      throw new AppError(403, "Use the configured workspace address.");
    }
    if (origin && origin !== config.origin) throw new AppError(403, "Cross-origin requests are not allowed.");
  } else {
    if (origin && origin !== `http://${authority}`) throw new AppError(403, "Cross-origin requests are not allowed.");
    let hostname;
    try { hostname = new URL(`http://${authority}`).hostname; } catch { /* Rejected below. */ }
    if (!LOCAL_HOSTS.has(hostname)) throw new AppError(403, "Use the local workspace address.");
    if (!pathname.startsWith("/api/agent/") && !LOCAL_ADDRESSES.has(request.socket.remoteAddress)) {
      throw new AppError(403, "Workspace administration is local-only.");
    }
  }
  if (!pathname.startsWith("/api/agent/")) {
    if (request.headers.authorization) throw new AppError(403, "Agent tokens may only access /api/agent/ endpoints.");
    if (request.headers["sec-fetch-site"] === "cross-site") throw new AppError(403, "Cross-site requests are not allowed.");
  }
}
