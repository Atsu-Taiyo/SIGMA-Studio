/**
 * Preserve the settled editor's block positions in the inert output document.
 * Chromium rounds normal-flow line metrics differently during print layout;
 * in a long editor this accumulates even though the page window stays fixed.
 * This snapshots measured boxes only: it does not paginate or resolve anchors.
 */
export const SNAPSHOT_PDF_FLOW_SOURCE = `((doc) => {
  const view = doc.defaultView;
  if (!view) return;
  const entries = Array.from(doc.querySelectorAll(".page-flow .ProseMirror")).map((root) => {
    const rect = root.getBoundingClientRect();
    const style = view.getComputedStyle(root);
    // What follows the editor in flow: the next sibling of the editor or of the
    // nearest ancestor it ends (a last child's bottom margin can collapse through
    // unpadded ancestors), else the outermost such ancestor's bottom edge. Each
    // editor answers for its own space only.
    // Out-of-flow siblings (e.g. a column resize handle) do not follow in flow.
    // A margin cannot collapse out of a grid/flex item (an independent column)
    // or past a non-block container, so the walk stops at that item and
    // measures its bottom: the column gets back the space it lost.
    const inFlowNext = (element) => {
      let next = element.nextElementSibling;
      while (next) {
        const s = view.getComputedStyle(next);
        if (s.display !== "none" && s.position !== "absolute" && s.position !== "fixed") return next;
        next = next.nextElementSibling;
      }
      return null;
    };
    const blockFlow = (element) => !element || element.matches(".page-flow")
      || ["block", "list-item"].includes(view.getComputedStyle(element).display);
    let end = root, next = null, parent = null;
    for (;;) {
      next = inFlowNext(end);
      if (next) break;
      const up = end.parentElement;
      if (!up || up.matches(".page-flow") || !blockFlow(up) || !blockFlow(up.parentElement)) { parent = up; break; }
      end = up;
    }
    return {
      root, rect, next, nextRect: next ? next.getBoundingClientRect() : null,
      parent, parentRect: parent ? parent.getBoundingClientRect() : null,
      marginTop: parseFloat(style.marginTop) || 0,
      marginBottom: parseFloat(style.marginBottom) || 0,
      borderLeft: parseFloat(style.borderLeftWidth) || 0,
      borderTop: parseFloat(style.borderTopWidth) || 0,
      children: Array.from(root.children).map((element) => ({ element, rect: element.getBoundingClientRect() })),
    };
  }).filter(({ rect }) => rect.width > 0 && rect.height > 0);

  // Read every box before writing: nested editors and successive flow units
  // must all use the same settled layout.
  for (const { root, rect, borderLeft, borderTop, children } of entries) {
    root.style.position = "relative";
    root.style.boxSizing = "border-box";
    root.style.width = rect.width + "px";
    root.style.height = rect.height + "px";
    for (const { element, rect: child } of children) {
      element.style.position = "absolute";
      element.style.boxSizing = "border-box";
      element.style.margin = "0";
      element.style.left = (child.left - rect.left - borderLeft) + "px";
      element.style.top = (child.top - rect.top - borderTop) + "px";
      element.style.width = child.width + "px";
      element.style.height = child.height + "px";
    }
  }
  // Removing in-flow children changes how margins collapse through each editor
  // (its first/last child's margins no longer reach outside it). Restore the
  // layout itself, not just the paint: walking in document order, give each
  // editor back, as its own margins, exactly the space it lost or gained above
  // and below. Every box after it — problem-number markers, frames, other areas,
  // the next editor — then keeps its settled position. (A relative top offset
  // would only repaint the editor and leave everything around it shifted.)
  for (const entry of entries) {
    const { root, rect, next, nextRect, parent, parentRect, marginTop, marginBottom } = entry;
    const topDelta = rect.top - root.getBoundingClientRect().top;
    if (Math.abs(topDelta) > 0.001) root.style.marginTop = (marginTop + topDelta) + "px";
    const bottomDelta = next && nextRect ? nextRect.top - next.getBoundingClientRect().top
      : parent && parentRect ? parentRect.bottom - parent.getBoundingClientRect().bottom : 0;
    if (Math.abs(bottomDelta) > 0.001) root.style.marginBottom = (marginBottom + bottomDelta) + "px";
  }
  // Any residual (e.g. a horizontal difference) is applied as before.
  for (const { root, rect } of entries) {
    const current = root.getBoundingClientRect();
    root.style.left = ((parseFloat(root.style.left) || 0) + rect.left - current.left) + "px";
    root.style.top = ((parseFloat(root.style.top) || 0) + rect.top - current.top) + "px";
  }
})`;
