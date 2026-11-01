/** Only typed paragraph IDs cross this boundary; extensions cannot supply JS or selectors. */
export function documentMeasurementScript(blockIds: string[]): string {
  if (!Array.isArray(blockIds) || blockIds.length > 25_000
    || !blockIds.every(id => typeof id === "string" && id.length > 0 && id.length <= 256)) {
    throw new Error("Invalid document measurement probes");
  }
  return `
    (async () => {
      await document.fonts.ready;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const canvas = document.querySelector('.paged-surface-stage .page-canvas');
      if (!canvas) throw new Error('Document canvas unavailable');
      const origin = canvas.getBoundingClientRect();
      const zoom = Number(getComputedStyle(canvas).getPropertyValue('--editor-zoom')) || 1;
      const context = document.createElement('canvas').getContext('2d');
      const ids = ${JSON.stringify(blockIds)};
      const requested = new Set(ids);
      const paragraphs = new Map();
      // Keep the first match, as querySelector did. Index once instead of scanning
      // the full document for every requested paragraph in a long import.
      if (requested.size) {
        for (const paragraph of canvas.querySelectorAll('p[data-sigma-doc-id]')) {
          const id = paragraph.getAttribute('data-sigma-doc-id');
          if (requested.has(id) && !paragraphs.has(id)) paragraphs.set(id, paragraph);
        }
      }
      const rows = ids.map(id => {
        const paragraph = paragraphs.get(id);
        if (!paragraph) return { id, missing: true };
        const rect = paragraph.getBoundingClientRect(), style = getComputedStyle(paragraph);
        let baseline;
        const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
        for (let node; node = walker.nextNode();) {
          if (!node.textContent.trim() || node.parentElement.closest('.inline-math-node')) continue;
          const font = getComputedStyle(node.parentElement);
          context.font = font.fontStyle + ' ' + font.fontWeight + ' ' + font.fontSize + ' ' + font.fontFamily;
          const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, [...node.textContent][0].length);
          baseline = (range.getBoundingClientRect().top - origin.top) / zoom + context.measureText([...node.textContent][0]).fontBoundingBoxAscent;
          break;
        }
        if (!Number.isFinite(baseline)) {
          const probe = document.createElement('span');
          probe.style.cssText = 'display:inline-block;width:0;height:0;line-height:0;font-size:0;vertical-align:baseline';
          const math = paragraph.querySelector('.inline-math-node');
          if (math) math.after(probe); else paragraph.prepend(probe);
          baseline = (probe.getBoundingClientRect().top - origin.top) / zoom; probe.remove();
        }
        return { id, x: (rect.left-origin.left)/zoom, y: (rect.top-origin.top)/zoom,
          width: rect.width/zoom, height: rect.height/zoom, baseline,
          fontPx: parseFloat(style.fontSize), lineHeight: parseFloat(style.lineHeight),
          marginTop: parseFloat(style.marginTop), marginBottom: parseFloat(style.marginBottom) };
      });
      return { rows };
    })()
  `;
}
