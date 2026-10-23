import { parentPort, workerData } from "node:worker_threads";
import ExcelJS from "exceljs";
import { parse } from "csv-parse/sync";

function check(sheets) {
  if (!sheets.length || sheets.length > 10) throw new Error("Choose a workbook with 1-10 worksheets.");
  for (const sheet of sheets) {
    if (sheet.rows.length > 1100 || sheet.rows.some((row) => row.length > 40)) throw new Error("Each worksheet supports up to 1,100 rows (including headers) and 40 columns.");
    if (sheet.rows.some((row) => row.some((value) => typeof value === "string" && value.length > 5000))) throw new Error("A cell exceeds 5,000 characters.");
  }
  return sheets;
}

try {
  let sheets;
  if (workerData.extension === "csv") {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(workerData.bytes);
    const rows = parse(text, { bom: true, relax_column_count: true, skip_empty_lines: true, max_record_size: 200000, to: 1101 });
    sheets = [{ name: "CSV", rows }];
  } else {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(workerData.bytes));
    if (workbook.worksheets.length > 10) throw new Error("Choose a workbook with up to 10 worksheets.");
    sheets = workbook.worksheets.map((sheet) => {
      if (sheet.rowCount > 1100 || sheet.columnCount > 40) throw new Error("Each worksheet supports up to 1,100 rows and 40 columns.");
      const rows = [];
      for (let index = 1; index <= sheet.rowCount; index++) {
        const row = [];
        for (let column = 1; column <= sheet.columnCount; column++) {
          const cell = sheet.getCell(index, column);
          let value = cell.value;
          if (cell.isMerged && cell.master.address !== cell.address) value = null;
          if (value && typeof value === "object" && ("formula" in value || "sharedFormula" in value)) {
            if (value.result === undefined) throw new Error(`Cell ${sheet.name}!${cell.address} has a formula without a saved result. Recalculate and save in Excel first.`);
            value = value.result;
          }
          if (value instanceof Date) value = value.toISOString();
          else if (value?.error) throw new Error(`Cell ${sheet.name}!${cell.address} contains an Excel error.`);
          else if (value && typeof value === "object") value = cell.text;
          if (typeof value === "number" && Number.isInteger(value) && /^0{2,}$/.test(cell.numFmt || "")) value = String(value).padStart(cell.numFmt.length, "0");
          row.push(value ?? null);
        }
        rows.push(row);
      }
      return { name: sheet.name, rows };
    });
  }
  parentPort.postMessage({ sheets: check(sheets) });
} catch (error) {
  parentPort.postMessage({ error: /worksheet|rows|columns|cell|formula|recalculate/i.test(error.message) ? error.message : "Could not read the file. Choose a valid XLSX or UTF-8 CSV file." });
}
