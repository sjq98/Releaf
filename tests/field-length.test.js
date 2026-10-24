import test from "node:test";
import assert from "node:assert/strict";
import { validateFields, normalizeValues } from "../src/field-types.js";

const field = (extra = {}) => ({
  id: "source", name: "Source", type: "longtext", required: false, unique: false, ...extra,
});

test("text length metadata preserves long order source without widening existing defaults", () => {
  const fields = validateFields([field({ maxLength: 40000 })]);
  assert.equal(fields[0].maxLength, 40000);
  assert.equal(normalizeValues({ source: "a".repeat(40000) }, fields).source.length, 40000);
  assert.throws(() => normalizeValues({ source: "a".repeat(40001) }, fields), { status: 400 });
  assert.throws(() => normalizeValues({ source: "a".repeat(5001) }, validateFields([field()])), { status: 400 });
});

test("text length metadata rejects unsafe or inapplicable limits", () => {
  for (const maxLength of [0, -1, 40001, 1.5, "200"]) {
    assert.throws(() => validateFields([field({ maxLength })]), { status: 400 });
  }
  assert.throws(() => validateFields([field({ type: "number", maxLength: 100 })]), { status: 400 });
});
