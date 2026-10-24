import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store.js";

const expectedNames = {
  warehouses: "Warehouses", products: "Products", stock: "Stock",
  inbound: "Inbound Requests", inboundLines: "Inbound Request Lines",
  outbound: "Outbound Requests", outboundLines: "Outbound Request Lines",
};
const legacy = {
  warehouses: ["仓库信息", ["仓库编码", "仓库名称", "仓库地址", "负责人", "备注"]],
  products: ["商品表", ["商品编码", "商品名称", "商品图片", "商品分类", "规格型号", "单位", "备注", "启用"]],
  stock: ["库存表", ["商品", "商品名称", "当前库存数量", "库存下限", "商品编码", "仓库", "商品图片", "商品分类", "规格型号", "单位", "期初库存数量", "库存标识"]],
  inbound: ["入库单", ["入库单号", "入库状态", "入库类型", "入库仓库", "入库总量", "申请人", "申请日期", "审批人", "入库日期", "入库拍照", "备注", "流程发起人", "流程状态", "流程进度", "流程启动时间", "流程结束时间"]],
  inboundLines: ["入库明细", ["所属入库单", "入库状态", "入库日期", "入库产品", "入库数量", "备注"]],
  outbound: ["出库单", ["出库单号", "出库状态", "出库类型", "出库仓库", "出库总量", "申请人", "申请日期", "审批人", "出库日期", "备注", "流程发起人", "流程状态", "流程进度", "流程启动时间", "流程结束时间"]],
  outboundLines: ["出库明细", ["所属出库单", "出库状态", "出库日期", "出库产品", "出库数量", "备注"]],
};
const legacyNodes = {
  "Warehouse Management": "仓储管理", "Inventory Management": "库存管理",
  "Inbound Management": "入库管理", "Outbound Management": "出库管理", "System Settings": "系统配置",
};
const formsFor = (store, tables) => Object.fromEntries(Object.entries(tables).map(([role, id]) => [role, store.getForm(id)]));

test("new warehouse forms, fields and navigation labels use English defaults", t => {
  const store = createStore(":memory:");
  t.after(() => store.close());
  for (const spaceId of ["default", store.spaces.create("Second warehouse").id]) {
    const { tables } = store.warehouse.ensureTables(spaceId);
    for (const [role, form] of Object.entries(formsFor(store, tables))) {
      assert.equal(form.name, expectedNames[role]);
      assert.equal(form.fields.length, legacy[role][1].length);
      for (const field of form.fields) assert.match(field.name, /^[\x20-\x7E]+$/);
    }
    for (const node of store.spaces.tree(spaceId)) assert.match(node.name, /^[\x20-\x7E]+$/);
    assert.equal(store.getForm(tables.stock).fields.find(f => f.id === "product").name, "Product");
    assert.equal(store.getForm(tables.stock).fields.find(f => f.id === "minimum").name, "Minimum Quantity");
    assert.equal(store.getForm(tables.inboundLines).fields.find(f => f.id === "document").name, "Inbound Request");
  }
});

test("saved Chinese warehouse labels migrate without changing records, references, history or unrelated forms", t => {
  const folder = mkdtempSync(join(tmpdir(), "releaf-warehouse-labels-")), filename = join(folder, "forms.sqlite");
  let store = createStore(filename);
  t.after(() => { store.close(); rmSync(folder, { recursive: true, force: true }); });
  const { tables } = store.warehouse.ensureTables();
  const warehouse = store.warehouse.state().warehouses[0];
  const product = store.warehouse.catalog({ role: "products", values: { code: "P1", name: "面粉", unit: "kg" } });
  let document = store.warehouse.createDocument({
    kind: "inbound", values: { warehouse: warehouse.id, applicant: "Applicant", approver: "Manager", notes: "保留原始备注" },
    lines: [{ product: product.id, quantity: 8 }], submit: true,
  });
  for (const action of ["approve", "post"]) {
    document = store.warehouse.transition(document.record.id, { action, version: document.record.version, actor: "Manager" });
  }
  const custom = store.createForm({ name: "库存表", fields: [{ id: "note", name: "备注", type: "text", required: false, unique: false }] });
  const unrelated = store.spaces.createNode({ name: "仓储管理" });
  const expected = formsFor(store, tables), originalTree = store.spaces.tree();
  const records = store.database.prepare("SELECT * FROM records ORDER BY rowid").all();
  const fingerprint = store.warehouse.fingerprint("default");
  for (const [role, form] of Object.entries(expected)) {
    const [name, labels] = legacy[role];
    const fields = form.fields.map((f, index) => ({ ...f, name: labels[index] }));
    store.database.prepare("UPDATE forms SET name = ?, fields_json = ? WHERE id = ?").run(name, JSON.stringify(fields), form.id);
    store.spaces.renameForm(form.id, name);
  }
  for (const node of originalTree) {
    if (Object.hasOwn(legacyNodes, node.name)) {
      store.database.prepare("UPDATE navigation_nodes SET name = ? WHERE id = ?").run(legacyNodes[node.name], node.id);
    }
  }
  store.close();
  store = createStore(filename);
  assert.deepEqual(store.warehouse.tableIds(), tables);
  for (const [role, form] of Object.entries(formsFor(store, tables))) {
    assert.equal(form.name, expected[role].name);
    assert.deepEqual(form.fields, expected[role].fields);
    assert.equal(form.version, expected[role].version + 1);
  }
  assert.deepEqual(store.spaces.tree(), originalTree);
  assert.equal(store.spaces.node(unrelated.id).name, "仓储管理");
  assert.equal(store.getForm(custom.id).name, "库存表");
  assert.equal(store.getForm(custom.id).fields[0].name, "备注");
  assert.deepEqual(store.database.prepare("SELECT * FROM records ORDER BY rowid").all(), records);
  assert.deepEqual(store.warehouse.fingerprint("default"), fingerprint);
  assert.equal(store.getRecord(warehouse.id).values.name, warehouse.values.name);

  const migrated = formsFor(store, tables);
  store.warehouse.ensureTables();
  assert.deepEqual(formsFor(store, tables), migrated);
  store.close();
  store = createStore(filename);
  assert.deepEqual(formsFor(store, tables), migrated);
  assert.deepEqual(store.warehouse.fingerprint("default"), fingerprint);
});
