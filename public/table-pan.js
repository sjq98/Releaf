const TABLE_SURFACES = ".table-clip, .inventory-table-scroll, .data-table";
const SCROLLABLE = /^(auto|scroll|overlay)$/;

export function panScrollChain(chain, deltaX, deltaY) {
  const remaining = { x: deltaX, y: deltaY };
  for (const { element, x, y } of chain) {
    for (const [axis, enabled, offset, size, viewport] of [
      ["x", x, "scrollLeft", "scrollWidth", "clientWidth"],
      ["y", y, "scrollTop", "scrollHeight", "clientHeight"],
    ]) {
      if (!enabled || !remaining[axis]) continue;
      const before = element[offset], maximum = Math.max(0, element[size] - element[viewport]);
      element[offset] = Math.max(0, Math.min(maximum, before + remaining[axis]));
      remaining[axis] -= element[offset] - before;
    }
  }
  return remaining;
}

function scrollChain(surface, doc) {
  const boundary = surface.closest("dialog[open]"), chain = [];
  for (let element = surface; element; element = element.parentElement) {
    const style = doc.defaultView.getComputedStyle(element);
    const x = SCROLLABLE.test(style.overflowX) && element.scrollWidth > element.clientWidth;
    const y = SCROLLABLE.test(style.overflowY) && element.scrollHeight > element.clientHeight;
    if (x || y) chain.push({ element, x, y });
    if (element === boundary) break;
  }
  // A horizontal-only table delegates vertical movement to its modal or page.
  const page = doc.scrollingElement;
  if (!boundary && page && !chain.some(target => target.element === page)) {
    const x = page.scrollWidth > page.clientWidth, y = page.scrollHeight > page.clientHeight;
    if (x || y) chain.push({ element: page, x, y });
  }
  return chain;
}

export function initTablePan(doc = document) {
  const view = doc.defaultView;
  let gesture = null;
  const surfaceFor = target => target?.closest?.(TABLE_SURFACES);

  function reset() {
    const previous = gesture;
    gesture = null;
    doc.documentElement.classList.remove("is-table-panning");
    if (previous?.surface.hasPointerCapture?.(previous.pointerId)) {
      previous.surface.releasePointerCapture(previous.pointerId);
    }
  }

  function start(event) {
    if (event.button !== 1 || event.pointerType !== "mouse") return;
    const surface = surfaceFor(event.target);
    if (!surface) return;
    const chain = scrollChain(surface, doc);
    if (!chain.length) return;
    reset();
    gesture = { surface, chain, pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    event.preventDefault();
    doc.documentElement.classList.add("is-table-panning");
    surface.setPointerCapture(event.pointerId);
  }

  function move(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    if (!(event.buttons & 4) || !gesture.surface.isConnected) return reset();
    event.preventDefault();
    panScrollChain(gesture.chain, gesture.x - event.clientX, gesture.y - event.clientY);
    gesture.x = event.clientX;
    gesture.y = event.clientY;
  }

  function end(event) {
    if (gesture && event.pointerId === gesture.pointerId) reset();
  }

  function preventNative(event) {
    if (event.button === 1 && (gesture || scrollChainForEvent(event).length)) event.preventDefault();
  }

  function scrollChainForEvent(event) {
    const surface = surfaceFor(event.target);
    return surface ? scrollChain(surface, doc) : [];
  }

  const visibility = () => { if (doc.hidden) reset(); };
  const escape = event => { if (event.key === "Escape") reset(); };
  const listeners = [
    [doc, "pointerdown", start], [view, "pointermove", move],
    [view, "pointerup", end], [view, "pointercancel", end], [doc, "lostpointercapture", end],
    [doc, "mousedown", preventNative], [doc, "auxclick", preventNative],
    [view, "blur", reset], [doc, "visibilitychange", visibility], [view, "keydown", escape],
    [doc, "close", reset],
  ];
  for (const [target, type, handler] of listeners) target.addEventListener(type, handler, { capture: true, passive: false });
  return {
    reset,
    destroy() {
      reset();
      for (const [target, type, handler] of listeners) target.removeEventListener(type, handler, true);
    },
  };
}
