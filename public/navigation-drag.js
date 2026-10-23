export function canDropNavigation(nodes, sourceId, targetId, placement) {
  const source = nodes.find((item) => item.id === sourceId);
  const target = nodes.find((item) => item.id === targetId);
  if (!source || !["before", "after", "inside"].includes(placement)) return false;
  if (targetId === null) return placement === "inside";
  if (!target || target.id === source.id || target.spaceId !== source.spaceId || placement === "inside" && target.kind !== "node") return false;
  const visited = new Set();
  for (let cursor = target; cursor; cursor = nodes.find((item) => item.id === cursor.parentId)) {
    if (cursor.id === sourceId || visited.has(cursor.id)) return false;
    visited.add(cursor.id);
  }
  return true;
}

export function initNavigationDrag({ root, getNodes, onMove, onError, canMove = () => true }) {
  let drag, frame, ghost, saving = false, suppressClickUntil = 0;
  const entry = (id) => [...root.querySelectorAll("[data-tree-entry]")].find((item) => item.dataset.treeEntry === id);
  function clearMarkers() {
    root.querySelectorAll("[data-drop-placement]").forEach((item) => item.removeAttribute("data-drop-placement"));
  }
  function markTarget() {
    clearMarkers();
    drag.drop = null;
    const hit = document.elementFromPoint(drag.x, drag.y);
    const row = hit?.closest("[data-tree-id]");
    const rootDrop = hit?.closest("[data-tree-root-drop]");
    if ((!row && !rootDrop) || !root.contains(row ?? rootDrop)) return;
    const target = row ? getNodes().find((item) => item.id === row.dataset.treeId) : null;
    if (row && !target) return;
    let placement = "inside";
    if (row) {
      const bounds = row.getBoundingClientRect(), ratio = (drag.y - bounds.top) / bounds.height;
      placement = target.kind === "node" && ratio >= 0.25 && ratio <= 0.75 ? "inside" : ratio < 0.5 ? "before" : "after";
    }
    if (!canDropNavigation(getNodes(), drag.id, target?.id ?? null, placement)) return;
    drag.drop = { targetId: target?.id ?? null, placement };
    const marker = placement === "after" ? entry(target.id) : row ?? rootDrop;
    marker?.setAttribute("data-drop-placement", placement);
  }
  function tick() {
    if (!drag?.active) return;
    if (!canMove()) { stop(); return; }
    const bounds = root.getBoundingClientRect();
    if (drag.x >= bounds.left && drag.x <= bounds.right && drag.y >= bounds.top && drag.y <= bounds.bottom) {
      if (drag.y < bounds.top + 32) root.scrollTop -= 8;
      else if (drag.y > bounds.bottom - 32) root.scrollTop += 8;
    }
    ghost.style.left = `${Math.max(4, Math.min(drag.x + 12, innerWidth - ghost.offsetWidth - 4))}px`;
    ghost.style.top = `${Math.max(4, Math.min(drag.y + 12, innerHeight - ghost.offsetHeight - 4))}px`;
    markTarget();
    frame = requestAnimationFrame(tick);
  }
  function stop() {
    if (!drag) return;
    const previous = drag;
    drag = null;
    cancelAnimationFrame(frame);
    ghost?.remove(); ghost = null;
    root.classList.remove("is-tree-dragging");
    root.querySelectorAll(".is-dragging").forEach((item) => item.classList.remove("is-dragging"));
    clearMarkers();
    if (root.hasPointerCapture(previous.pointerId)) root.releasePointerCapture(previous.pointerId);
    if (previous.active) suppressClickUntil = performance.now() + 300;
  }
  async function commit(id, drop, focus = false) {
    if (!canMove() || saving || !canDropNavigation(getNodes(), id, drop.targetId, drop.placement)) return;
    saving = true; root.setAttribute("aria-busy", "true");
    try {
      await onMove(id, drop);
      if (focus) entry(id)?.querySelector("[data-tree-drag]")?.focus();
    } catch (error) { onError(error); }
    finally { saving = false; root.removeAttribute("aria-busy"); }
  }
  root.addEventListener("pointerdown", (event) => {
    if (!canMove() || saving || drag || event.button !== 0 || !event.isPrimary) return;
    const handle = event.target.closest("[data-tree-drag]");
    const label = event.target.closest(".tree-row > .nav-item");
    if (!handle && (!label || event.pointerType !== "mouse")) return;
    const row = (handle ?? label).closest("[data-tree-id]");
    drag = { id: row.dataset.treeId, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, active: false };
  });
  root.addEventListener("pointermove", (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.x = event.clientX; drag.y = event.clientY;
    if (!drag.active && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) >= 5) {
      drag.active = true;
      root.setPointerCapture(event.pointerId);
      root.classList.add("is-tree-dragging");
      entry(drag.id)?.classList.add("is-dragging");
      ghost = document.createElement("div");
      ghost.className = "tree-drag-preview";
      ghost.textContent = getNodes().find((item) => item.id === drag.id)?.name ?? "";
      ghost.setAttribute("aria-hidden", "true");
      document.body.append(ghost);
      tick();
    }
    if (drag.active) { event.preventDefault(); markTarget(); }
  });
  document.addEventListener("pointerup", (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.active) { drag.x = event.clientX; drag.y = event.clientY; markTarget(); }
    const { id, drop, active } = drag;
    stop();
    if (active && drop) void commit(id, drop);
  });
  document.addEventListener("pointercancel", (event) => { if (drag?.pointerId === event.pointerId) stop(); });
  // Touch starts with implicit capture on the handle; transferring it to the nav is not cancellation.
  root.addEventListener("lostpointercapture", (event) => { if (event.target === root && drag?.pointerId === event.pointerId) stop(); });
  window.addEventListener("blur", stop);
  root.addEventListener("dragstart", (event) => { if (drag) event.preventDefault(); });
  root.addEventListener("click", (event) => {
    if (performance.now() < suppressClickUntil || saving && event.target.closest("[data-tree-drag]")) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  }, true);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && drag) { stop(); event.preventDefault(); } });
  root.addEventListener("keydown", (event) => {
    const handle = event.target.closest("[data-tree-drag]");
    if (!canMove() || !handle || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const source = getNodes().find((item) => item.id === handle.dataset.treeDrag);
    if (!source) return;
    const siblings = getNodes().filter((item) => item.parentId === source.parentId && item.spaceId === source.spaceId);
    const direction = event.key === "ArrowUp" ? -1 : 1;
    const target = siblings[siblings.findIndex((item) => item.id === source.id) + direction];
    if (target) void commit(source.id, { targetId: target.id, placement: direction < 0 ? "before" : "after" }, true);
  });
  return { reset: stop };
}
