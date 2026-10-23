import assert from "node:assert/strict";

export async function setupAdmin(base) {
  const response = await fetch(`${base}/api/auth/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "test.admin", displayName: "Test Admin", password: "Test-only-password-2026" }),
  });
  assert.equal(response.status, 201);
  const { user } = await response.json();
  return { user, cookie: response.headers.get("set-cookie").split(";")[0] };
}
