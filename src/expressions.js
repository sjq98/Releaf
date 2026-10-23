import jsep from "jsep";
import Decimal from "decimal.js";
import { AppError } from "./errors.js";

const D = Decimal.clone({ precision: 40 });
const fail = (message) => { throw new AppError(400, message); };
const functions = new Set(["SUM", "COUNT", "MIN", "MAX", "ROUND", "ABS", "COALESCE", "IF"]);
const binary = new Set(["+", "-", "*", "/", "%", "==", "!=", ">", ">=", "<", "<=", "&&", "||"]);
const cache = new Map();
const numeric = (value) => {
  if (typeof value !== "number" || !Number.isFinite(value)) fail("Formula arithmetic requires numeric values.");
  return new D(value);
};

export function parseFormula(formula) {
  if (!formula || typeof formula.expression !== "string" || !formula.expression.trim() ||
      formula.expression.length > 2000 || !formula.bindings || typeof formula.bindings !== "object" ||
      Array.isArray(formula.bindings) || Object.keys(formula.bindings).length > 60) fail("Choose fields and enter a valid formula.");
  const key = JSON.stringify(formula);
  if (cache.has(key)) return cache.get(key);
  let tree;
  try { tree = jsep(formula.expression); } catch (error) { fail(`Invalid formula: ${error.message}`); }
  let nodes = 0;
  function check(node, depth = 0) {
    if (++nodes > 200 || depth > 20) fail("This formula is too complex.");
    if (node.type === "Literal") {
      if (node.value !== null && !["number", "boolean", "string"].includes(typeof node.value)) fail("Unsupported formula value.");
    } else if (node.type === "Identifier") {
      if (!Object.hasOwn(formula.bindings, node.name)) fail(`Unknown formula variable "${node.name}". Choose a field first.`);
    } else if (node.type === "BinaryExpression" && binary.has(node.operator)) {
      check(node.left, depth + 1); check(node.right, depth + 1);
    } else if (node.type === "UnaryExpression" && ["+", "-", "!"].includes(node.operator)) check(node.argument, depth + 1);
    else if (node.type === "CallExpression" && node.callee.type === "Identifier" && functions.has(node.callee.name) && node.arguments.length <= 40) {
      node.arguments.forEach((argument) => check(argument, depth + 1));
    } else fail("Only selected fields, constants, operators and approved formula functions are supported.");
  }
  check(tree);
  if (cache.size > 500) cache.clear();
  cache.set(key, tree);
  return tree;
}

export function evaluateFormula(formula, resolve) {
  const tree = parseFormula(formula);
  function run(node) {
    if (node.type === "Literal") return node.value;
    if (node.type === "Identifier") return resolve(formula.bindings[node.name]) ?? null;
    if (node.type === "UnaryExpression") {
      const value = run(node.argument);
      return node.operator === "!" ? !value : value == null ? null : numeric(value).times(node.operator === "-" ? -1 : 1).toNumber();
    }
    if (node.type === "BinaryExpression") {
      const a = run(node.left);
      if (node.operator === "&&") return Boolean(a) && Boolean(run(node.right));
      if (node.operator === "||") return Boolean(a) || Boolean(run(node.right));
      const b = run(node.right);
      if (node.operator === "==") return a === b;
      if (node.operator === "!=") return a !== b;
      if (a == null || b == null) return null;
      if ([">", ">=", "<", "<="].includes(node.operator)) return { ">": a > b, ">=": a >= b, "<": a < b, "<=": a <= b }[node.operator];
      const x = numeric(a), y = numeric(b);
      if (["/", "%"].includes(node.operator) && y.isZero()) fail("Formula division by zero.");
      const result = { "+": () => x.plus(y), "-": () => x.minus(y), "*": () => x.times(y), "/": () => x.div(y), "%": () => x.mod(y) }[node.operator]();
      if (!result.isFinite() || result.abs().gt(1e15)) fail("Formula result is outside the supported numeric range.");
      return result.toNumber();
    }
    const name = node.callee.name;
    if (name === "IF") {
      if (node.arguments.length !== 3) fail("IF requires three arguments.");
      return run(node.arguments[0]) ? run(node.arguments[1]) : run(node.arguments[2]);
    }
    const args = node.arguments.map(run);
    if (name === "COALESCE") return args.find((value) => value != null) ?? null;
    const values = args.flat();
    if (name === "COUNT") return values.filter((value) => value != null).length;
    if (["SUM", "MIN", "MAX"].includes(name)) {
      const numbers = values.filter((value) => value != null).map(numeric);
      if (!numbers.length) return name === "SUM" ? 0 : null;
      return (name === "SUM" ? numbers.reduce((a, b) => a.plus(b), new D(0)) : name === "MIN" ? D.min(...numbers) : D.max(...numbers)).toNumber();
    }
    if (args[0] == null) return null;
    if (name === "ABS" && args.length === 1) return numeric(args[0]).abs().toNumber();
    if (name === "ROUND" && args.length >= 1 && args.length <= 2 && Number.isInteger(args[1] ?? 0) && Math.abs(args[1] ?? 0) <= 12) {
      const places = args[1] ?? 0;
      return numeric(args[0]).div(new D(10).pow(-places)).toDecimalPlaces(0).times(new D(10).pow(-places)).toNumber();
    }
    fail(`Invalid arguments for ${name}.`);
  }
  return run(tree);
}

export function validateFieldFormulas(fields) {
  const done = new Set(), active = new Set(), order = [];
  function visit(field) {
    if (done.has(field.id)) return;
    if (active.has(field.id)) fail(`Circular formula dependency at "${field.name}".`);
    active.add(field.id);
    if (field.formula) {
      parseFormula(field.formula);
      for (const binding of Object.values(field.formula.bindings)) {
        if (!binding || !["record", "aggregate"].includes(binding.scope)) fail("Field formulas must select fields from this form.");
        const source = fields.find((item) => item.id === binding.fieldId);
        if (!source || source.type !== "number") fail(`"${field.name}" requires an existing numeric formula input.`);
        if (binding.scope === "aggregate" && source.formula) fail("Aggregate inputs must be manually entered numeric fields.");
        visit(source);
      }
      order.push(field);
    }
    active.delete(field.id); done.add(field.id);
  }
  fields.forEach(visit);
  return order;
}

export function calculateFields(fields, values, records = []) {
  const result = { ...values };
  for (const field of validateFieldFormulas(fields)) {
    try {
      result[field.id] = evaluateFormula(field.formula, (binding) =>
        binding.scope === "aggregate" ? records.map((record) => record.values[binding.fieldId] ?? null) : result[binding.fieldId]);
      if (result[field.id] != null && (typeof result[field.id] !== "number" || !Number.isFinite(result[field.id]) || Math.abs(result[field.id]) > 1e15)) fail("A calculated number field must produce a valid number.");
      if (field.required && result[field.id] == null) fail(`${field.name} is required.`);
    } catch (error) { throw new AppError(400, error.message, { [field.id]: error.message }); }
  }
  return result;
}
