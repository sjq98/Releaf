import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { AppError } from "./errors.js";

const SESSION_COOKIE = "releaf_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_FAILURE_LIMIT = 10;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const USER_ROLES = new Set(["admin", "user"]);
const USERNAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,31}$/;
let savepointSequence = 0;

function fail(status, message) {
  throw new AppError(status, message);
}

function canonicalUsername(value) {
  if (typeof value !== "string" || !USERNAME_PATTERN.test(value.trim())) {
    throw new AppError(400, "Username must be 3-32 characters using letters, numbers, dots, underscores or hyphens.");
  }
  return value.trim().toLowerCase();
}

function displayName(value) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 80) {
    throw new AppError(400, "Display name must contain 1-80 characters.");
  }
  return value.trim();
}

function passwordValue(value) {
  if (typeof value !== "string" || value.length < 12 || Buffer.byteLength(value, "utf8") > 1024) {
    throw new AppError(400, "Password must contain at least 12 characters and be at most 1,024 bytes.");
  }
  return value;
}

function passwordHash(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, SCRYPT_OPTIONS);
  return `scrypt$16384$8$1$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

function verifyPassword(password, encoded) {
  const [, n, r, p, saltText, hashText] = String(encoded).split("$");
  if (n !== "16384" || r !== "8" || p !== "1" || !saltText || !hashText) return false;
  const salt = Buffer.from(saltText, "base64url");
  const expected = Buffer.from(hashText, "base64url");
  if (salt.length !== 16 || expected.length !== 64) return false;
  const actual = scryptSync(password, salt, expected.length, SCRYPT_OPTIONS);
  return timingSafeEqual(actual, expected);
}

function tokenHash(token) {
  return createHash("sha256").update(token).digest("hex");
}

function newSessionToken() {
  return randomBytes(32).toString("base64url");
}

function parseCookie(header) {
  if (typeof header !== "string") return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(separator + 1).trim();
    return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
  }
  return null;
}

export function sessionCookie(token) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new TypeError("Invalid session token.");
  }
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

export function createAuth(db) {
  const sessionContext = new AsyncLocalStorage();
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'user')), active INTEGER NOT NULL DEFAULT 1,
      password_hash TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS auth_sessions_user ON auth_sessions(user_id);
    CREATE TABLE IF NOT EXISTS auth_login_attempts (
      rate_key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, failures INTEGER NOT NULL
    );
  `);

  const dummyPasswordHash = passwordHash(randomBytes(32).toString("hex"));
  const userFromRow = (row) => row ? {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    active: Boolean(row.active),
  } : null;
  const findUser = (id) => userFromRow(db.prepare("SELECT * FROM auth_users WHERE id = ?").get(id));
  const userByUsername = (username) => db.prepare("SELECT * FROM auth_users WHERE username = ?").get(username);

  function transaction(callback) {
    const savepoint = `auth_${++savepointSequence}`;
    db.exec(`SAVEPOINT ${savepoint}`);
    try {
      const result = callback();
      db.exec(`RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      db.exec(`ROLLBACK TO ${savepoint}`);
      db.exec(`RELEASE ${savepoint}`);
      throw error;
    }
  }

  function createSession(userId) {
    const token = newSessionToken();
    const now = new Date();
    const expires = new Date(now.getTime() + SESSION_TTL_MS);
    db.prepare("INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .run(tokenHash(token), userId, now.toISOString(), expires.toISOString());
    return token;
  }

  function rateKeyFor(rateKey) {
    const value = typeof rateKey === "string" && rateKey.trim() ? rateKey.trim().slice(0, 256) : "unknown-client";
    return tokenHash(value);
  }

  function assertLoginRate(rateKey) {
    const key = rateKeyFor(rateKey);
    const now = Date.now();
    const row = db.prepare("SELECT window_start, failures FROM auth_login_attempts WHERE rate_key = ?").get(key);
    if (row && now - row.window_start < LOGIN_WINDOW_MS && row.failures >= LOGIN_FAILURE_LIMIT) {
      fail(429, "Too many sign-in attempts. Try again in 15 minutes.");
    }
    return key;
  }

  function recordLoginFailure(key) {
    const now = Date.now();
    transaction(() => {
      const row = db.prepare("SELECT window_start, failures FROM auth_login_attempts WHERE rate_key = ?").get(key);
      if (!row || now - row.window_start >= LOGIN_WINDOW_MS) {
        db.prepare(`INSERT INTO auth_login_attempts (rate_key, window_start, failures) VALUES (?, ?, 1)
          ON CONFLICT(rate_key) DO UPDATE SET window_start = excluded.window_start, failures = 1`).run(key, now);
      } else {
        db.prepare("UPDATE auth_login_attempts SET failures = failures + 1 WHERE rate_key = ?").run(key);
      }
    });
  }

  function clearLoginFailures(key) {
    db.prepare("DELETE FROM auth_login_attempts WHERE rate_key = ?").run(key);
  }

  function activeAdminCount() {
    return db.prepare("SELECT COUNT(*) AS count FROM auth_users WHERE role = 'admin' AND active = 1").get().count;
  }

  function getUser(id) {
    const user = findUser(id);
    if (!user) fail(404, "User not found.");
    return user;
  }

  function currentUser() {
    const scoped = sessionContext.getStore();
    if (!scoped) return undefined;
    const user = findUser(scoped.id);
    if (!user?.active) fail(401, "This account is disabled or no longer exists.");
    return user;
  }

  function requireAdmin() {
    const user = currentUser();
    if (user && user.role !== "admin") fail(403, "Administrator access is required.");
    return user;
  }

  return {
    status() {
      const userCount = db.prepare("SELECT COUNT(*) AS count FROM auth_users").get().count;
      return { setupRequired: userCount === 0, user: currentUser() ?? null };
    },

    setup({ username, displayName: name, password } = {}) {
      const normalizedUsername = canonicalUsername(username);
      const normalizedName = displayName(name ?? username);
      const encodedPassword = passwordHash(passwordValue(password));
      return transaction(() => {
        if (db.prepare("SELECT 1 FROM auth_users LIMIT 1").get()) fail(409, "Initial administrator setup has already been completed.");
        const id = randomBytes(16).toString("hex");
        const now = new Date().toISOString();
        db.prepare(`INSERT INTO auth_users (id, username, display_name, role, active, password_hash, created_at, updated_at)
          VALUES (?, ?, ?, 'admin', 1, ?, ?, ?)`).run(id, normalizedUsername, normalizedName, encodedPassword, now, now);
        const sessionToken = createSession(id);
        return { user: getUser(id), sessionToken };
      });
    },

    login({ username, password } = {}, rateKey) {
      const rateKeyHash = assertLoginRate(rateKey);
      let normalizedUsername = "";
      try {
        normalizedUsername = canonicalUsername(username);
      } catch {
        normalizedUsername = "";
      }
      const row = normalizedUsername ? userByUsername(normalizedUsername) : null;
      const candidatePassword = typeof password === "string" && Buffer.byteLength(password, "utf8") <= 1024 ? password : "";
      const matches = verifyPassword(candidatePassword, row?.password_hash ?? dummyPasswordHash);
      if (!row || !row.active || !matches) {
        recordLoginFailure(rateKeyHash);
        fail(401, "Invalid username or password.");
      }
      clearLoginFailures(rateKeyHash);
      return transaction(() => ({ user: userFromRow(row), sessionToken: createSession(row.id) }));
    },

    authenticate(cookieHeader) {
      const token = parseCookie(cookieHeader);
      if (!token) fail(401, "Sign in to continue.");
      const session = db.prepare(`SELECT sessions.token_hash, sessions.expires_at, users.*
        FROM auth_sessions AS sessions JOIN auth_users AS users ON users.id = sessions.user_id
        WHERE sessions.token_hash = ?`).get(tokenHash(token));
      if (!session || !session.active || Date.parse(session.expires_at) <= Date.now()) {
        if (session) db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(session.token_hash);
        fail(401, "Your session has expired. Sign in again.");
      }
      return userFromRow(session);
    },

    logout(cookieHeader) {
      const token = parseCookie(cookieHeader);
      if (token) db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(tokenHash(token));
      return { loggedOut: true };
    },

    changePassword({ currentPassword, password } = {}) {
      const user = currentUser();
      if (!user) fail(401, "Sign in to continue.");
      const candidatePassword = typeof currentPassword === "string" &&
        Buffer.byteLength(currentPassword, "utf8") <= 1024 ? currentPassword : "";
      const nextPassword = passwordValue(password);
      return transaction(() => {
        const row = db.prepare("SELECT * FROM auth_users WHERE id = ?").get(user.id);
        if (!row?.active) fail(401, "This account is disabled or no longer exists.");
        if (!verifyPassword(candidatePassword, row.password_hash)) fail(401, "The current password is incorrect.");
        db.prepare("UPDATE auth_users SET password_hash = ?, updated_at = ? WHERE id = ?")
          .run(passwordHash(nextPassword), new Date().toISOString(), user.id);
        db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(user.id);
        return { user: userFromRow(row), sessionToken: createSession(user.id) };
      });
    },

    listUsers() {
      requireAdmin();
      return db.prepare("SELECT * FROM auth_users ORDER BY username COLLATE NOCASE, id").all().map(userFromRow);
    },

    createUser({ username, displayName: name, password, role } = {}) {
      requireAdmin();
      const normalizedUsername = canonicalUsername(username);
      const normalizedName = displayName(name ?? username);
      const normalizedPassword = passwordHash(passwordValue(password));
      if (!USER_ROLES.has(role)) throw new AppError(400, "Choose the admin or user role.");
      return transaction(() => {
        const id = randomBytes(16).toString("hex");
        const now = new Date().toISOString();
        try {
          db.prepare(`INSERT INTO auth_users (id, username, display_name, role, active, password_hash, created_at, updated_at)
            VALUES (?, ?, ?, ?, 1, ?, ?, ?)`).run(id, normalizedUsername, normalizedName, role, normalizedPassword, now, now);
        } catch (error) {
          if (String(error.message).includes("UNIQUE constraint failed: auth_users.username")) {
            throw new AppError(409, "That username is already in use.");
          }
          throw error;
        }
        return getUser(id);
      });
    },

    updateUser(id, updates = {}) {
      requireAdmin();
      if (typeof id !== "string" || !id) fail(400, "User ID is required.");
      if (!updates || typeof updates !== "object" || Array.isArray(updates) ||
          Object.keys(updates).some((key) => !["displayName", "role", "active", "password"].includes(key))) {
        fail(400, "Invalid user update.");
      }
      return transaction(() => {
        const current = db.prepare("SELECT * FROM auth_users WHERE id = ?").get(id);
        if (!current) fail(404, "User not found.");
        const nextName = Object.hasOwn(updates, "displayName") ? displayName(updates.displayName) : current.display_name;
        const nextRole = Object.hasOwn(updates, "role") ? updates.role : current.role;
        const nextActive = Object.hasOwn(updates, "active") ? updates.active : Boolean(current.active);
        if (!USER_ROLES.has(nextRole)) throw new AppError(400, "Choose the admin or user role.");
        if (typeof nextActive !== "boolean") throw new AppError(400, "Active must be true or false.");
        const demotesLastAdmin = current.role === "admin" && current.active &&
          (nextRole !== "admin" || !nextActive) && activeAdminCount() <= 1;
        if (demotesLastAdmin) fail(409, "At least one active administrator must remain.");
        const changesPassword = Object.hasOwn(updates, "password");
        const nextPasswordHash = changesPassword ? passwordHash(passwordValue(updates.password)) : current.password_hash;
        const now = new Date().toISOString();
        db.prepare(`UPDATE auth_users SET display_name = ?, role = ?, active = ?, password_hash = ?, updated_at = ? WHERE id = ?`)
          .run(nextName, nextRole, nextActive ? 1 : 0, nextPasswordHash, now, id);
        const invalidatesSessions = current.role !== nextRole || Boolean(current.active) !== nextActive || changesPassword;
        if (invalidatesSessions) db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(id);
        return getUser(id);
      });
    },

    getUser,

    assignees() {
      return db.prepare("SELECT id, username, display_name FROM auth_users WHERE active = 1 ORDER BY username COLLATE NOCASE")
        .all().map((row) => ({ id: row.id, username: row.username, displayName: row.display_name }));
    },

    withUser(user, callback) {
      if (typeof callback !== "function") throw new TypeError("withUser requires a callback.");
      if (user == null) return sessionContext.run(undefined, callback);
      const liveUser = getUser(user.id);
      if (!liveUser.active) fail(401, "This account is disabled.");
      return sessionContext.run(liveUser, callback);
    },

    currentUser,

    requireAdmin,

    permissions(user) {
      const isAdmin = user?.active === true && user.role === "admin";
      const isActive = user?.active === true;
      return {
        manageUsers: isAdmin,
        manageForms: isAdmin,
        editRecords: isAdmin,
        manageSettings: isAdmin,
        manageOrders: isActive,
      };
    },
  };
}
