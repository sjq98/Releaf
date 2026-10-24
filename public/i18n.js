import { zh } from "/locales/zh.js";

const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
let language = "en";
try { language = localStorage.getItem("releaf.language") === "zh" ? "zh" : "en"; } catch {}
export const getLanguage = () => language;
export const getLocale = () => language === "zh" ? "zh-CN" : "en-GB";

export function t(message) {
  const text = String(message ?? "");
  if (language === "en") return text;
  if (text.trim() && text !== text.trim()) return text.replace(text.trim(), t(text.trim()));
  if (Object.hasOwn(zh, text)) return zh[text];
  for (const [pattern, replacement] of patterns) if (pattern.test(text)) return text.replace(pattern, replacement);
  return text;
}

const patterns = [
  [/^(\d+) files$/, "$1 个文件"],
  [/^(\d+) tasks$/, "$1 项任务"],
  [/^AI provider returned HTTP (\d+)\. No records were saved\.$/, "AI 供应商返回 HTTP $1，未保存任何记录。"],
  [/^This product uses (.+)\. Choose that unit or clear the product filter\.$/, "该商品使用 $1 单位，请选择此单位或清除商品筛选。"],
  [/^View (.+)$/, "查看 $1"],
  [/^Product was not found: (.+)$/, "未找到商品：$1"],
  [/^Product is ambiguous: (.+)$/, "存在同名商品，请使用商品编码：$1"],
  [/^Warehouse was not found: (.+)$/, "未找到仓库：$1"],
  [/^Warehouse is ambiguous: (.+)$/, "存在同名仓库，请使用仓库编码：$1"],
  [/^Unit does not match the product: (.+)$/, "单位不匹配，商品单位为：$1"],
  [/^(\d+) notification rules$/, "$1 条通知规则"],
  [/^Insufficient warehouse stock: (.+)\.$/, "库存不足：$1。"],
  [/^Remove (C\d+) from the expression before deleting it\.$/, "请先从逻辑表达式中移除 $1，再删除该子条件。"],
  [/^Remove field (\d+)$/, "移除字段 $1"], [/^Revoke (.+)$/, "撤销 $1"], [/^(.+) access$/, "$1 的访问权限"],
  [/^(\d+) errors?$/, "$1 个错误"], [/^(\d+) discrepancies$/, "$1 处差异"], [/^(\d+) matched$/, "$1 项一致"], [/^(\d+) open$/, "$1 项待处理"],
  [/^(\d+) existing records$/, "$1 条现有记录"], [/^(\d+) records with visible value changes$/, "$1 条记录的可见值发生变化"],
  [/^Affected visible values \((\d+) of (\d+)\)$/, "受影响的可见值（$1 / $2）"], [/^All changes, including automations \((\d+)\)$/, "全部变更，含自动化（$1）"],
  [/^(\d+) records?$/, "$1 条记录"], [/^(\d+) fields?$/, "$1 个字段"], [/^(\d+) events?$/, "$1 条变更"],
  [/^(\d+) tables?$/, "$1 张表单"], [/^(\d+) options?$/, "$1 个选项"], [/^(\d+) candidates?$/, "$1 个候选事项"],
  [/^(\d+) lines?$/, "$1 行"], [/^(\d+) pages?$/, "$1 页"], [/^(\d+) models?$/, "$1 个模型"],
  [/^(\d+) rows?$/, "$1 行"], [/^(\d+) materials?$/, "$1 种原材料"], [/^(\d+) movements?$/, "$1 条库存变动"], [/^(\d+) models? available$/, "$1 个可用模型"],
  [/^Page (\d+)$/, "第 $1 页"], [/^Reading page (\d+) \/ (\d+)$/, "正在读取第 $1 / $2 页"], [/^(\d+) receipt lines \/ (\d+) document lines selected$/, "已选 $1 行收货记录 / $2 行单据"],
  [/^Version (.+)$/, "版本 $1"], [/^Last synced (.+)$/, "上次同步 $1"], [/^Result: (.+)$/, "结果：$1"],
  [/^Preview: (.+)$/, "预览：$1"], [/^Run: (.+)$/, "运行：$1"], [/^Edit (.+)$/, "编辑 $1"], [/^Delete (.+)$/, "删除 $1"],
  [/^Remove (.+)$/, "移除 $1"], [/^Open (.+)$/, "打开 $1"], [/^Expand (.+)$/, "展开 $1"],
  [/^Collapse (.+)$/, "收起 $1"], [/^New in (.+)$/, "在 $1 中新建"], [/^Insert (.+)$/, "插入 $1"],
  [/^Preview (.+)$/, "预览 $1"], [/^Run (.+)$/, "运行 $1"], [/^Provider default: (.+)$/, "供应商默认模型：$1"],
  [/^Field (\d+) name$/, "字段 $1 的名称"], [/^Field (\d+) type$/, "字段 $1 的类型"],
  [/^Move field (\d+) up$/, "上移字段 $1"], [/^Move field (\d+) down$/, "下移字段 $1"],
  [/^Move (.+)$/, "移动 $1"],
  [/^(.+) required$/, "$1 必填"], [/^(.+) unique$/, "$1 唯一"], [/^(.+) formula$/, "$1 的公式"],
  [/^(.+) options$/, "$1 的选项"], [/^(.+) target table$/, "$1 的引用表单"], [/^(.+) unique field$/, "$1 的唯一字段"],
  [/^Unknown condition: (.+)\.$/, "不存在的子条件：$1。"],
  [/^(\d+) document lines saved\.$/, "已保存 $1 行单据记录。"], [/^(\d+) action items saved\.$/, "已保存 $1 个待办事项。"],
];

// Only explicitly marked UI text is translated. Interpolated business values stay untouched.
export function uiText(message) {
  const text = String(message ?? "");
  return `<!--i18n:${encodeURIComponent(text)}-->${escape(t(text))}<!--/i18n-->`;
}
export function setUIText(element, message) {
  const text = String(message ?? "");
  element.dataset.i18nText = text;
  element.textContent = t(text);
}
export function uiAttributes(message) {
  return `title="${escape(t(message))}" aria-label="${escape(t(message))}" data-i18n-title="${escape(message)}" data-i18n-aria-label="${escape(message)}"`;
}
export function setUIAttribute(element, name, message) {
  element.setAttribute(`data-i18n-${name}`, message);
  element.setAttribute(name, t(message));
}
export function languagePicker() {
  return `<select class="language-select" data-language-picker ${uiAttributes("Language")}><option value="en"${language === "en" ? " selected" : ""}>English</option><option value="zh"${language === "zh" ? " selected" : ""}>中文</option></select>`;
}

export function html(strings, ...values) {
  const slot = (index) => `__RELEAF_UI_SLOT_${index}__`;
  let source = strings.reduce((text, part, index) => text + (index ? slot(index - 1) : "") + part, "");
  source = source.replace(/<option>([^<]+)<\/option>/g, (_, text) => `<option value="${text}">${text}</option>`);
  source = source.replace(/<!--[^]*?-->|<(?:[^>"']|"[^"]*"|'[^']*')*>|[^<]+/g, (part) => {
    if (part.startsWith("<!--")) return part;
    if (part.startsWith("<")) return part.replace(/\b(title|aria-label|placeholder|alt)="([^"]*)"/g, (attribute, name, value) => {
      if (!value.replace(/__RELEAF_UI_SLOT_\d+__/g, "").trim()) return attribute;
      const resolved = value.replace(/__RELEAF_UI_SLOT_(\d+)__/g, (_, index) => values[index] ?? "");
      const translated = slot(values.length);
      values.push(escape(t(resolved)).replaceAll("&amp;", "&"));
      return `${name}="${translated}" data-i18n-${name}="${value}"`;
    });
    return part.split(/(__RELEAF_UI_SLOT_\d+__)/g).map((text) => {
      if (/^__RELEAF_UI_SLOT_\d+__$/.test(text) || !text.trim()) return text;
      const key = text.trim();
      if (!Object.hasOwn(zh, key)) return text;
      return text.replace(key, uiText(key));
    }).join("");
  });
  return source.replace(/__RELEAF_UI_SLOT_(\d+)__/g, (_, index) => values[index] ?? "");
}

function translate(root = document) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
  while (walker.nextNode()) {
    const marker = walker.currentNode;
    if (!marker.data.startsWith("i18n:")) continue;
    const next = marker.nextSibling;
    if (next?.nodeType === Node.TEXT_NODE) next.textContent = t(decodeURIComponent(marker.data.slice(5)));
  }
  for (const element of root.querySelectorAll("[data-i18n-text]")) element.textContent = t(element.dataset.i18nText);
  for (const name of ["title", "aria-label", "placeholder", "alt"]) {
    for (const element of root.querySelectorAll(`[data-i18n-${name}]`)) element.setAttribute(name, t(element.getAttribute(`data-i18n-${name}`)));
  }
}

export function setLanguage(value) {
  language = value === "zh" ? "zh" : "en";
  try { localStorage.setItem("releaf.language", language); } catch {}
  document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  translate();
  document.querySelectorAll("[data-language-picker]").forEach((select) => { select.value = language; });
  document.dispatchEvent(new CustomEvent("languagechange", { detail: { language } }));
}

export function initI18n() {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    if (node.parentElement.closest("script, style, textarea, [data-i18n-skip]")) continue;
    const key = node.textContent.trim();
    if (!Object.hasOwn(zh, key)) continue;
    if (node.parentElement.tagName === "OPTION" && !node.parentElement.hasAttribute("value")) node.parentElement.value = node.parentElement.textContent;
    const marker = document.createComment(`i18n:${encodeURIComponent(node.textContent)}`);
    node.before(marker);
  }
  for (const name of ["title", "aria-label", "placeholder", "alt"]) {
    for (const element of document.querySelectorAll(`[${name}]`)) {
      if (!element.closest("[data-i18n-skip]")) element.setAttribute(`data-i18n-${name}`, element.getAttribute(name));
    }
  }
  document.addEventListener("change", (event) => { if (event.target.matches("[data-language-picker]")) setLanguage(event.target.value); });
  setLanguage(language);
}
