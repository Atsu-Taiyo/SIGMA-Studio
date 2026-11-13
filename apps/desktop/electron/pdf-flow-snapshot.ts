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
    return {
      root, rect,
      borderLeft: parseFloat(style.borderLeftWidth) || 0,
      borderTop: parseFloat(style.borderTopWidth) || 0,
      children: Array.from(root.children).map((element) => ({ element, rect: element.getBoundingClientRect() })),
    };
  }).filter(({ rect }) => rect.width > 0 && rect.height > 0);

  // Paragraphs are not the whole flow: number frames and area borders belong
  // to their outer units. Absolutizing editor children changes margin collapse
  // and can shrink those units, moving later number frames toward earlier pages.
  // Page windows remove off-page identity attributes, so include every direct
  // flow child rather than querying data-flow-unit-id (the full flow is retained).
  const units = Array.from(doc.querySelectorAll(".page-flow > *")).map((element) => ({
    element, rect: element.getBoundingClientRect(),
  })).filter(({ rect }) => rect.width > 0 && rect.height > 0);
  // Capture all boxes before writing, including nested editors and outer units.
  for (const { element, rect } of units) {
    element.style.boxSizing = "border-box";
    element.style.height = rect.height + "px";
  }

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
  // Restore outer origins before inner editors. These are measured corrections,
  // not another pagination pass; the inert output DOM is the only thing changed.
  for (const { element, rect } of units) {
    const current = element.getBoundingClientRect();
    element.style.position = "relative";
    element.style.left = ((parseFloat(element.style.left) || 0) + rect.left - current.left) + "px";
    element.style.top = ((parseFloat(element.style.top) || 0) + rect.top - current.top) + "px";
  }
  // Removing in-flow children can uncollapse an editor's edge margins. Restore
  // each measured origin, from outer editors to inner ones, without moving siblings.
  for (const { root, rect } of entries) {
    const current = root.getBoundingClientRect();
    root.style.left = ((parseFloat(root.style.left) || 0) + rect.left - current.left) + "px";
    root.style.top = ((parseFloat(root.style.top) || 0) + rect.top - current.top) + "px";
  }
})`;
