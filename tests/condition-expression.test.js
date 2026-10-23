import test from "node:test";
import assert from "node:assert/strict";
import { compileConditions, conditionBuilderFrom } from "../src/condition-expression.js";
import { createStore } from "../future/cross-form-automation/src/store.js";

const condition = (fieldId, value) => ({ fieldId, operator: "eq", value: { kind: "literal", value } });
const definitions = [
  { id: "C1", condition: condition("quantity", 30) },
  { id: "C2", condition: condition("urgent", true) },
  { id: "C3", condition: condition("blocked", true) },
];
const compile = (expression) => compileConditions({ conditions: definitions, expression });

test("condition expressions respect NOT, AND, OR precedence and explicit parentheses", () => {
  assert.deepEqual(compile("C1 OR C2 AND NOT C3"), { op: "OR", conditions: [definitions[0].condition,
    { op: "AND", conditions: [definitions[1].condition, { op: "NOT", conditions: [definitions[2].condition] }] },
  ] });
  assert.deepEqual(compile("(c1 or C2) and not C3"), { op: "AND", conditions: [
    { op: "OR", conditions: definitions.slice(0, 2).map((item) => item.condition) }, { op: "NOT", conditions: [definitions[2].condition] },
  ] });
  const result = compile("C1");
  result.value.value = 100;
  assert.equal(definitions[0].condition.value.value, 30);
});

test("invalid expressions never silently become unconditional or execute code", () => {
  for (const expression of ["", "C1 C2", "C1 AND", "C1 OR OR C2", "()", "(C1", "C1)", "C4", "C1 && C2", "globalThis.alert(1)", "NOT", "C1 OR true", "NOT ".repeat(12) + "C1"]) {
    assert.throws(() => compile(expression), { status: 400 }, expression);
  }
  assert.equal(compileConditions({ conditions: [], expression: "" }), null);
  assert.throws(() => compileConditions({ conditions: [definitions[0], definitions[0]], expression: "C1" }), { status: 400 });
});

test("existing nested conditions convert to reusable IDs and retain their logic", () => {
  const original = { op: "AND", conditions: [{ op: "OR", conditions: definitions.slice(0, 2).map((item) => item.condition) }, { op: "NOT", conditions: [definitions[2].condition] }] };
  const builder = conditionBuilderFrom(original);
  assert.deepEqual(builder.conditions.map((item) => item.id), ["C1", "C2", "C3"]);
  assert.deepEqual(compileConditions(builder), original);
});

test("saved condition blocks persist and trigger the existing transactional action engine", (t) => {
  const store = createStore(":memory:");
  t.after(() => store.close());
  const field = (id, type) => ({ id, name: id, type, required: false, unique: false, options: [] });
  const source = store.createForm({ name: "Source", fields: [field("quantity", "number"), field("urgent", "checkbox"), field("blocked", "checkbox")] });
  const target = store.createForm({ name: "Target", fields: [field("message", "text")] });
  const rule = store.automation.save({ name: "Combined", formId: source.id, trigger: "created", enabled: true,
    conditionBuilder: { conditions: definitions, expression: "(C1 OR C2) AND NOT C3" },
    actions: [{ type: "create", formId: target.id, assignments: { message: { kind: "literal", value: "Saved" } } }],
  });
  assert.equal(store.automation.get(rule.id).conditionBuilder.expression, "(C1 OR C2) AND NOT C3");
  for (const values of [{ quantity: 30, urgent: false, blocked: false }, { quantity: 2, urgent: true, blocked: false }, { quantity: 30, urgent: true, blocked: true }, { quantity: 2, urgent: false, blocked: false }]) {
    store.createRecord(source.id, { schemaVersion: source.version, values });
  }
  assert.equal(store.listRecords(target.id).length, 2);
  assert.throws(() => store.automation.save({ ...rule, condition: null }, rule.id), /do not match/);
  const changed = structuredClone(rule);
  changed.conditionBuilder.conditions[0].condition.fieldId = "missing";
  delete changed.condition;
  assert.throws(() => store.automation.save(changed, rule.id), /invalid field/);
});
