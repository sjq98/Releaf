import { randomUUID } from "node:crypto";
import { AppError } from "./errors.js";

export function createAttachments(db, spaces) {
  db.exec(`CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY, space_id TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL,
    bytes BLOB NOT NULL, images_json TEXT NOT NULL, created_at TEXT NOT NULL
  )`);
  const fail = (message) => { throw new AppError(400, message); };
  function get(id) {
    const row = db.prepare("SELECT * FROM attachments WHERE id = ?").get(id);
    if (!row) throw new AppError(404, "Attachment not found.");
    return { id: row.id, spaceId: row.space_id, name: row.name, mime: row.mime,
      bytes: Buffer.from(row.bytes), images: JSON.parse(row.images_json), createdAt: row.created_at };
  }
  return {
    get,
    upload(body) {
      const spaceId = spaces.get(body.spaceId ?? "default").id;
      const file = body.file;
      if (!file || typeof file.name !== "string" || !file.name.trim() || file.name.length > 200 ||
          typeof file.data !== "string" || file.data.length > 14000000 || !/^[a-zA-Z0-9+/]*={0,2}$/.test(file.data)) fail("Choose an attachment up to 10 MB.");
      const bytes = Buffer.from(file.data, "base64");
      if (!bytes.length || bytes.length > 10 * 1024 * 1024) fail("Choose a nonempty attachment up to 10 MB.");
      let mime;
      if (bytes.subarray(0, 5).toString() === "%PDF-") mime = "application/pdf";
      else if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) mime = "image/png";
      else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mime = "image/jpeg";
      else fail("Attachments support PDF, PNG, and JPEG files.");
      let images = mime === "application/pdf" ? body.images ?? [] : [`data:${mime};base64,${bytes.toString("base64")}`];
      if (!Array.isArray(images) || images.length > 6 || images.some((image) => typeof image !== "string" ||
          image.length > 2000000 || !/^data:image\/(?:jpeg|png);base64,[a-zA-Z0-9+/]+=*$/.test(image))) fail("Provide up to 6 rendered image pages, each up to 1.5 MB.");
      const id = randomUUID(), name = file.name.replace(/[\\/\x00-\x1f]/g, "_");
      db.prepare("INSERT INTO attachments VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, spaceId, name, mime, bytes, JSON.stringify(images), new Date().toISOString());
      return { id, spaceId, name, mime, size: bytes.length, pages: images.length };
    },
    info(id) { const { bytes, images, ...file } = get(id); return { ...file, size: bytes.length, pages: images.length }; },
  };
}
