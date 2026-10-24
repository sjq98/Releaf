import { AppError } from "./errors.js";

export const FIELD_DEFINITIONS = {
  text: { label: "Text", icon: "type" },
  longtext: { label: "Long text", icon: "align-left" },
  number: { label: "Number", icon: "hash" },
  date: { label: "Date", icon: "calendar-days" },
  datetime: { label: "Date & time", icon: "calendar-clock" },
  select: { label: "Dropdown", icon: "list" },
  checkbox: { label: "Checkbox", icon: "square-check" },
  reference: { label: "Reference", icon: "link-2" },
  attachment: { label: "Attachment", icon: "paperclip" },
};
export const FIELD_TYPES = Object.keys(FIELD_DEFINITIONS);

const fail = (message) => { throw new AppError(400, message); };

export function validateFields(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 40) fail("A table must have 1-40 fields.");
  const ids = new Set();
  const names = new Set();
  return input.map((field) => {
    if (!field || typeof field !== "object" || typeof field.id !== "string" ||
      !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(field.id) || ids.has(field.id)) fail("Field IDs must be valid and unique.");
    ids.add(field.id);
    if (typeof field.name !== "string" || !field.name.trim() || field.name.trim().length > 64) fail("Each field needs a name of 1-64 characters.");
    const name = field.name.trim();
    if (names.has(name.toLowerCase())) fail(`The field name "${name}" is used more than once.`);
    names.add(name.toLowerCase());
    if (!FIELD_TYPES.includes(field.type)) fail(`Unsupported type for "${name}".`);
    if (typeof field.required !== "boolean" || typeof field.unique !== "boolean") fail(`Invalid rules for "${name}".`);
    let options = [];
    if (field.type === "select") {
      if (!Array.isArray(field.options) || !field.options.length || field.options.length > 50 ||
        field.options.some((option) => typeof option !== "string" || !option.trim() || option.trim().length > 100)) {
        fail(`"${name}" needs 1-50 non-empty options, each at most 100 characters.`);
      }
      options = field.options.map((option) => option.trim());
      if (new Set(options.map((option) => option.toLowerCase())).size !== options.length) fail(`"${name}" has duplicate options.`);
    }
    const result = { id: field.id, name, type: field.type, required: field.required, unique: field.unique, options };
    if (field.maxLength != null) {
      if (!["text", "longtext"].includes(field.type) || !Number.isInteger(field.maxLength) ||
          field.maxLength < 1 || field.maxLength > 40000) fail(`Invalid text length limit for "${name}".`);
      result.maxLength = field.maxLength;
    }
    if (field.formula != null) {
      if (field.type !== "number" || typeof field.formula.expression !== "string" ||
          !field.formula.bindings || typeof field.formula.bindings !== "object" || Array.isArray(field.formula.bindings)) fail("Only number fields support a valid formula.");
      result.formula = structuredClone(field.formula);
    }
    if (field.type === "attachment" && field.unique) fail("Attachment fields cannot be unique.");
    if (field.type === "reference") {
      if (!field.reference || typeof field.reference.formId !== "string" || !field.reference.formId ||
        typeof field.reference.fieldId !== "string" || !field.reference.fieldId) fail(`Choose a target table and unique field for "${name}".`);
      result.reference = { formId: field.reference.formId, fieldId: field.reference.fieldId };
    }
    return result;
  });
}

export function validDate(value, withTime = false) {
  const pattern = withTime ? /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/ : /^\d{4}-\d{2}-\d{2}$/;
  if (typeof value !== "string" || !pattern.test(value)) return false;
  const [year, month, day, hour = 0, minute = 0] = value.match(/\d+/g).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute));
  return year >= 1900 && year <= 9999 && date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 && date.getUTCDate() === day && hour < 24 && minute < 60;
}

export function normalizeField(field, input) {
  if (field.type === "checkbox") {
    if (input === null || input === undefined || input === "") {
      if (!field.required) return null;
      input = false;
    }
    if (typeof input !== "boolean") throw new Error("Enter a true or false value.");
    if (field.required && input !== true) throw new Error(`${field.name} must be checked.`);
    return input;
  }
  if (input === null || input === undefined || input === "") {
    if (field.required) throw new Error(`${field.name} is required.`);
    return null;
  }
  if (field.type === "text" || field.type === "longtext") {
    const max = field.maxLength ?? (field.type === "text" ? 1000 : 5000);
    if (typeof input !== "string" || input.trim().length > max) throw new Error(`Enter text with at most ${max} characters.`);
    const text = input.trim();
    if (!text && field.required) throw new Error(`${field.name} is required.`);
    return text || null;
  }
  if (field.type === "number") {
    if (typeof input !== "number" || !Number.isFinite(input) || Math.abs(input) > 1e15) throw new Error("Enter a valid number between -1e15 and 1e15.");
  } else if (field.type === "date" || field.type === "datetime") {
    if (!validDate(input, field.type === "datetime")) throw new Error(`Enter a valid ${field.type === "date" ? "date" : "date and time"} (year 1900-9999).`);
  } else if (field.type === "select") {
    if (typeof input !== "string" || !field.options.includes(input)) throw new Error("Select one of the available options.");
  } else if (field.type === "reference") {
    if (typeof input !== "string" || !/^[a-zA-Z0-9-]{1,64}$/.test(input)) throw new Error("Select a record from the referenced table.");
  } else if (field.type === "attachment") {
    if (!Array.isArray(input) || input.length > 10 || input.some((id) => typeof id !== "string" || !/^[a-zA-Z0-9-]{1,64}$/.test(id))) throw new Error("Choose up to 10 uploaded files.");
    if (!input.length) {
      if (field.required) throw new Error(`${field.name} is required.`);
      return null;
    }
  }
  return input;
}

export function normalizeValues(input, fields, previous = {}, creating = false) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AppError(400, "Record values must be a JSON object.");
  const ids = new Set(fields.map((field) => field.id));
  if (Object.keys(input).some((id) => !ids.has(id))) throw new AppError(400, "The record contains an unknown field. Reload the table and try again.");
  const values = Object.assign(Object.create(null), previous);
  const errors = Object.create(null);
  for (const field of fields) {
    try {
      if (field.formula) {
        if (Object.hasOwn(input, field.id) && input[field.id] != null) throw new Error("This field is calculated automatically.");
        values[field.id] = previous[field.id] ?? null;
        continue;
      }
      const previousValue = Object.hasOwn(previous, field.id) ? previous[field.id] : null;
      const value = Object.hasOwn(input, field.id) ? input[field.id] : Object.hasOwn(previous, field.id) ? previousValue : field.type === "checkbox" ? false : null;
      values[field.id] = normalizeField(field, value);
    } catch (error) { errors[field.id] = error.message; }
  }
  if (Object.keys(errors).length) throw new AppError(400, "Please check the highlighted fields.", errors);
  return values;
}

export function displayValue(field, value) {
  if (value === null || value === undefined || value === "") return "Not set";
  if (field.type === "checkbox") return value ? "Yes" : "No";
  if (field.type === "attachment") return `${value.length} file${value.length === 1 ? "" : "s"}`;
  if (field.type === "number") return new Intl.NumberFormat("en-GB", { maximumFractionDigits: 12 }).format(value);
  if (field.type === "date" || field.type === "datetime") {
    const [date, time] = String(value).split("T");
    const [year, month, day] = date.split("-");
    return `${day}/${month}/${year}${time ? `, ${time}` : ""}`;
  }
  return String(value);
}

export function inputValue(field, input) {
  if (field.type === "checkbox") return input.tagName === "SELECT" ? input.value === "" ? null : input.value === "true" : input.checked;
  if (field.type === "attachment") return JSON.parse(input.dataset.files || "[]");
  if (field.type === "number") return input.value === "" ? null : Number(input.value);
  return input.value || null;
}
