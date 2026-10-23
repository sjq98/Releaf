import { AppError } from "./errors.js";

const fail = (message) => { throw new AppError(400, message); };

export function compileConditions(builder) {
  if (!builder || !Array.isArray(builder.conditions) || builder.conditions.length > 30 ||
      typeof builder.expression !== "string" || builder.expression.length > 2000) fail("Use up to 30 saved conditions and a valid logical expression.");
  const conditions = new Map();
  for (const item of builder.conditions) {
    if (!item || !/^C[1-9]\d{0,3}$/.test(item.id) || conditions.has(item.id) || !item.condition || item.condition.op) fail("Saved conditions need distinct IDs such as C1 and a single comparison.");
    conditions.set(item.id, item.condition);
  }
  const expression = builder.expression.trim();
  if (!expression) {
    if (conditions.size) fail("Combine the saved conditions in the logical expression.");
    return null;
  }
  const tokens = expression.match(/C[1-9]\d*|AND\b|OR\b|NOT\b|[()]|\S+/gi) ?? [];
  if (tokens.length > 150) fail("The logical expression is too long.");
  let position = 0;
  const peek = () => tokens[position]?.toUpperCase();
  function term(depth = 0) {
    if (depth > 10) fail("Use at most 10 levels of condition nesting.");
    const token = peek();
    position++;
    if (token === "NOT") return { op: "NOT", conditions: [term(depth + 1)] };
    if (token === "(") {
      const result = expressionOr(depth + 1);
      if (peek() !== ")") fail("A closing parenthesis is missing.");
      position++;
      return result;
    }
    if (!token || token === ")" || token === "AND" || token === "OR") fail("Expected a condition ID, NOT, or an opening parenthesis.");
    if (!conditions.has(token)) fail(`Unknown condition: ${token}.`);
    return structuredClone(conditions.get(token));
  }
  function combine(op, items) {
    if (items.length > 30) fail("Use up to 30 conditions in one logical group.");
    return items.length === 1 ? items[0] : { op, conditions: items };
  }
  function expressionAnd(depth) {
    const items = [term(depth)];
    while (peek() === "AND") { position++; items.push(term(depth)); }
    return combine("AND", items);
  }
  function expressionOr(depth) {
    const items = [expressionAnd(depth)];
    while (peek() === "OR") { position++; items.push(expressionAnd(depth)); }
    return combine("OR", items);
  }
  const result = expressionOr(0);
  if (position !== tokens.length) fail("Separate condition IDs with AND or OR and check the parentheses.");
  return result;
}

export function conditionBuilderFrom(condition) {
  const conditions = [];
  function visit(item) {
    if (!item) return "";
    if (item.op === "NOT") return `NOT (${visit(item.conditions[0])})`;
    if (item.op) return `(${item.conditions.map(visit).join(` ${item.op} `)})`;
    const id = `C${conditions.length + 1}`;
    conditions.push({ id, condition: structuredClone(item) });
    return id;
  }
  const expression = visit(condition);
  return { conditions, expression };
}
