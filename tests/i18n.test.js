import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = (await readFile(new URL("../public/i18n.js", import.meta.url), "utf8"))
  .replace('"/locales/zh.js"', JSON.stringify(new URL("../public/locales/zh.js", import.meta.url).href));

test("localized templates mark UI labels but never translate interpolated business names and values", async () => {
  const { html, uiText } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const rendered = html`<label>Name</label><h3>${"Save"}</h3><option value="${"Name"}">${"Name"}</option><button title="Edit ${"Save"}">Save</button>`;
  assert.match(rendered, /i18n:Name/);
  assert.match(rendered, /<h3>Save<\/h3>/);
  assert.match(rendered, /<option value="Name">Name<\/option>/);
  assert.match(rendered, /data-i18n-title="Edit Save"/);
  assert.match(uiText('<script>alert("x")</script>'), /&lt;script&gt;/);
  assert.doesNotMatch(uiText('<script>alert("x")</script>'), /<script>/);
});

test("translated option labels retain their original API values", async () => {
  const { html } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  assert.match(html`<option>Open</option>`, /<option value="Open">/);
  assert.match(html`<option value="updated">Record updated</option>`, /value="updated"/);
});

test("Chinese UI preserves custom values, expressions and option identifiers", async () => {
  const chinese = source.replace('let language = "en";', 'let language = "zh";');
  const { html, t } = await import(`data:text/javascript;base64,${Buffer.from(chinese).toString("base64")}`);
  const rendered = html`<label>Name</label><h3>${"Save"}</h3><option>${"Cancel"}</option><option>Open</option><textarea>${"C1 AND NOT C2"}</textarea><button title="Edit ${"Save"}">Save</button>`;
  assert.match(rendered, /名称/);
  assert.match(rendered, /<h3>Save<\/h3>/);
  assert.match(rendered, /<option value="Cancel">Cancel<\/option>/);
  assert.match(rendered, /<option value="Open">.*待处理/);
  assert.match(rendered, /<textarea>C1 AND NOT C2<\/textarea>/);
  assert.match(rendered, /title="编辑 Save"/);
  assert.match(html`<input aria-label="Field ${2} name">`, /aria-label="字段 2 的名称"/);
  assert.match(html`<button aria-label="Move field ${2} up">`, /aria-label="上移字段 2"/);
  assert.match(html`<button title="Edit ${"__RELEAF_UI_SLOT_2__"}">`, /title="编辑 __RELEAF_UI_SLOT_2__"/);
  assert.equal(t("Remove C2 from the expression before deleting it."), "请先从逻辑表达式中移除 C2，再删除该子条件。");
  assert.equal(t("Record created"), "新增记录时");
  assert.equal(t("Record updated"), "修改记录时");
  assert.equal(t("Record deleted"), "删除记录时");
  assert.equal(t("Add action"), "新增操作");
  assert.equal(t("No rules for this trigger"), "此触发时机下暂无规则");
  assert.equal(t("No runs for this form"), "此表单暂无运行记录");
});
