import { createHash, randomUUID } from "node:crypto";
import { AppError } from "./errors.js";
import { ACTION_FIELDS, createMeetingAI, validateExtraction, validateMeeting } from "./meeting-ai.js";

export const MEETING_SPACE_ID = "meeting-tasks";
const TASK_FIELDS = [
  ...ACTION_FIELDS,
  { id: "meetingTitle", name: "Meeting title", type: "text", required: false, unique: false, options: [] },
  { id: "meetingDate", name: "Meeting date", type: "date", required: false, unique: false, options: [] },
  { id: "sourceQuote", name: "Source quote", type: "longtext", required: false, unique: false, options: [] },
];
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function createMeetingTasks({ db, store }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meeting_task_workspace (
      space_id TEXT PRIMARY KEY REFERENCES spaces(id), form_id TEXT NOT NULL REFERENCES forms(id)
    );
    CREATE TABLE IF NOT EXISTS meeting_task_imports (
      id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id), form_id TEXT NOT NULL REFERENCES forms(id),
      title TEXT NOT NULL, meeting_date TEXT NOT NULL, text TEXT NOT NULL, content_hash TEXT NOT NULL UNIQUE,
      request_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL, items_json TEXT NOT NULL,
      created_by TEXT, created_at TEXT NOT NULL
    );
  `);
  let extractor;
  const pendingContent = new Map(), pendingKeys = new Map();
  const mapping = () => db.prepare("SELECT * FROM meeting_task_workspace WHERE space_id = ?").get(MEETING_SPACE_ID);
  const parse = row => ({
    id: row.id, spaceId: row.space_id, formId: row.form_id, title: row.title, date: row.meeting_date,
    text: row.text, items: JSON.parse(row.items_json), createdBy: row.created_by, createdAt: row.created_at,
  });
  const byContent = key => db.prepare("SELECT * FROM meeting_task_imports WHERE content_hash = ?").get(key);
  function requireSpace(spaceId) {
    if (spaceId !== MEETING_SPACE_ID || !mapping()) throw new AppError(400, "Choose the Meeting Tasks Space.");
  }
  function isTaskForm(formId) { return mapping()?.form_id === formId; }
  function assertSchema(form, fields = form.fields) {
    if (!isTaskForm(form.id)) return;
    if (TASK_FIELDS.some(core => {
      const next = fields.find(field => field.id === core.id);
      return !next || next.type !== core.type || next.required !== core.required || next.unique !== core.unique ||
        next.formula || JSON.stringify(next.options) !== JSON.stringify(core.options);
    })) throw new AppError(409, "Keep the meeting task core fields and their validation rules.");
  }
  function initialize() {
    if (mapping() || store.spaces.wasDeleted(MEETING_SPACE_ID)) return;
    store.transaction(() => {
      db.prepare("INSERT OR IGNORE INTO spaces (id, name) VALUES (?, ?)").run(MEETING_SPACE_ID, "Meeting Tasks");
      const form = store.createForm({ name: "Tasks", spaceId: MEETING_SPACE_ID, fields: TASK_FIELDS, parentId: null });
      db.prepare("INSERT INTO meeting_task_workspace VALUES (?, ?)").run(MEETING_SPACE_ID, form.id);
    });
  }
  function state(spaceId) {
    return { enabled: spaceId === MEETING_SPACE_ID && Boolean(mapping()), spaceId: MEETING_SPACE_ID,
      formId: mapping()?.form_id ?? null, coreFields: TASK_FIELDS.map(field => field.id) };
  }
  function get(id, spaceId) {
    requireSpace(spaceId);
    const row = db.prepare("SELECT * FROM meeting_task_imports WHERE id = ? AND space_id = ?").get(id, spaceId);
    if (!row) throw new AppError(404, "Meeting import not found.");
    return parse(row);
  }
  function list(spaceId) {
    requireSpace(spaceId);
    return db.prepare("SELECT * FROM meeting_task_imports WHERE space_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 100")
      .all(spaceId).map(row => {
        const item = parse(row);
        return { id: item.id, formId: item.formId, title: item.title, date: item.date, count: item.items.length, createdAt: item.createdAt };
      });
  }
  async function importSummary(body, idempotencyKey = randomUUID()) {
    const user = store.auth.requireAdmin();
    requireSpace(body?.spaceId);
    const meeting = validateMeeting(body);
    if (typeof idempotencyKey !== "string" || !idempotencyKey || idempotencyKey.length > 200) throw new AppError(400, "Invalid idempotency key.");
    const requestKey = hash([user?.id ?? "local", idempotencyKey]);
    const requestHash = hash(meeting), contentHash = hash([body.spaceId, meeting.date, meeting.text]);
    const replay = db.prepare("SELECT * FROM meeting_task_imports WHERE request_key = ?").get(requestKey);
    if (replay) {
      if (replay.request_hash !== requestHash) throw new AppError(409, "This import key was already used for a different summary.");
      return { ...parse(replay), duplicate: true };
    }
    if (pendingKeys.has(requestKey)) {
      const pending = pendingKeys.get(requestKey);
      if (pending.hash !== requestHash) throw new AppError(409, "This import key was already used for a different summary.");
      return { ...await pending.promise, duplicate: true };
    }
    const existing = byContent(contentHash);
    if (existing) return { ...parse(existing), duplicate: true };
    if (pendingContent.has(contentHash)) return { ...await pendingContent.get(contentHash), duplicate: true };
    const form = store.getForm(mapping().form_id);
    assertSchema(form);
    if (!extractor) throw new AppError(503, "AI is not configured. Open AI settings to connect a provider.");
    const promise = (async () => {
      const items = validateExtraction(await extractor.extract(meeting), meeting);
      // AI runs outside the transaction; recheck authorization and schema immediately before the atomic write.
      store.auth.requireAdmin();
      return store.transaction(() => {
        const current = store.getForm(form.id);
        if (current.version !== form.version) throw new AppError(409, "The task table changed during extraction. Import the summary again.");
        const previous = byContent(contentHash);
        if (previous) return { ...parse(previous), duplicate: true };
        const saved = items.map(item => {
          const record = store.createRecord(form.id, { schemaVersion: form.version, values: {
            ...item.values, meetingTitle: meeting.title, meetingDate: meeting.date, sourceQuote: item.evidence,
          } }).record;
          return { ...item, recordId: record.id };
        });
        const id = randomUUID();
        db.prepare(`INSERT INTO meeting_task_imports
          (id, space_id, form_id, title, meeting_date, text, content_hash, request_key, request_hash, items_json, created_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          id, body.spaceId, form.id, meeting.title, meeting.date, meeting.text, contentHash, requestKey, requestHash,
          JSON.stringify(saved), user?.id ?? null, new Date().toISOString(),
        );
        return { ...get(id, body.spaceId), duplicate: false };
      });
    })();
    pendingContent.set(contentHash, promise);
    pendingKeys.set(requestKey, { hash: requestHash, promise });
    try { return await promise; }
    finally { pendingContent.delete(contentHash); pendingKeys.delete(requestKey); }
  }
  return {
    initialize, state, isTaskForm, assertSchema, list, get, importSummary,
    configure(options) { extractor = createMeetingAI(options); },
  };
}
