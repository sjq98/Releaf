import Decimal from "decimal.js";
import { AppError } from "./errors.js";

export function inventoryQuantity(value, label, allowZero = false) {
  if (typeof value !== "number" || !Number.isFinite(value) || value > 1e12 ||
      (allowZero ? value < 0 : value <= 0) || new Decimal(value).decimalPlaces() > 6) {
    throw new AppError(400, `${label} must be ${allowZero ? "nonnegative" : "positive"}, at most 1e12, with up to 6 decimal places.`);
  }
  return value;
}
