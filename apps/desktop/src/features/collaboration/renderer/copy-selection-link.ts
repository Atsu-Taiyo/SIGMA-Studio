export async function copySelectionLink(url: string, label: string): Promise<void> {
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard.write) {
    const link = document.createElement("a");
    link.href = url;
    link.textContent = label;
    try {
      await navigator.clipboard.write([new ClipboardItem({
        "text/plain": new Blob([url], { type: "text/plain" }),
        "text/html": new Blob([link.outerHTML], { type: "text/html" }),
      })]);
      return;
    } catch { /* Plain-text editors and older hosts still receive the complete URL. */ }
  }
  await navigator.clipboard.writeText(url);
}
