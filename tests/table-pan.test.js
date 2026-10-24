import test from "node:test";
import assert from "node:assert/strict";
import { panScrollChain } from "../public/table-pan.js";

function target({ left = 0, top = 0, width = 1000, height = 1000, viewport = 200, x = true, y = true } = {}) {
  return {
    x, y, element: {
      scrollLeft: left, scrollTop: top,
      scrollWidth: width, scrollHeight: height, clientWidth: viewport, clientHeight: viewport,
    },
  };
}

test("table pan moves both axes in either direction", () => {
  const table = target({ left: 150, top: 200 });
  assert.deepEqual(panScrollChain([table], 100, 80), { x: 0, y: 0 });
  assert.equal(table.element.scrollLeft, 250);
  assert.equal(table.element.scrollTop, 280);
  panScrollChain([table], -40, -120);
  assert.equal(table.element.scrollLeft, 210);
  assert.equal(table.element.scrollTop, 160);
});

test("table pan clamps to content bounds and returns only unused movement", () => {
  const table = target({ left: 750, top: 20 });
  assert.deepEqual(panScrollChain([table], 200, -100), { x: 150, y: -80 });
  assert.equal(table.element.scrollLeft, 800);
  assert.equal(table.element.scrollTop, 0);
});

test("horizontal table pan delegates vertical movement to the page", () => {
  const table = target({ x: true, y: false }), page = target({ x: false, y: true });
  assert.deepEqual(panScrollChain([table, page], 120, 70), { x: 0, y: 0 });
  assert.equal(table.element.scrollLeft, 120);
  assert.equal(table.element.scrollTop, 0);
  assert.equal(page.element.scrollLeft, 0);
  assert.equal(page.element.scrollTop, 70);
});

test("nested scroll containers consume movement before passing their remainder outward", () => {
  const inner = target({ left: 790, top: 780 }), outer = target();
  assert.deepEqual(panScrollChain([inner, outer], 50, 60), { x: 0, y: 0 });
  assert.equal(inner.element.scrollLeft, 800);
  assert.equal(inner.element.scrollTop, 800);
  assert.equal(outer.element.scrollLeft, 40);
  assert.equal(outer.element.scrollTop, 40);
  panScrollChain([inner, outer], -10, -15);
  assert.equal(inner.element.scrollLeft, 790);
  assert.equal(inner.element.scrollTop, 785);
  assert.equal(outer.element.scrollLeft, 40);
});

test("table pan uses live content dimensions and preserves fractional positions", () => {
  const table = target({ left: 10.5 });
  panScrollChain([table], 2.25, 0);
  assert.equal(table.element.scrollLeft, 12.75);
  table.element.scrollWidth = 205;
  panScrollChain([table], 20, 0);
  assert.equal(table.element.scrollLeft, 5);
});

test("empty or non-scrollable chains do not consume movement", () => {
  assert.deepEqual(panScrollChain([], 15, -20), { x: 15, y: -20 });
  const table = target({ width: 200, height: 200 });
  assert.deepEqual(panScrollChain([table], 15, -20), { x: 15, y: -20 });
  assert.deepEqual(panScrollChain([target()], 0, 0), { x: 0, y: 0 });
});
