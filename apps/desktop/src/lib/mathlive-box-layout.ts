/** MathLive 0.109 BoxAtom's inline-block baseline depends on its last child.
 * Empty/phantom answer boxes can consequently rise through a radical's rule.
 * Keep its measured dimensions, but synthesize the baseline at the box bottom
 * and lower that baseline by its measured depth. No TeX/document edits needed.
 */
export const MATHLIVE_BOX_LAYOUT_CLASS = "sigma-math-box-layout";

export function normalizeMathLiveBoxStyle(style: string): string | null {
  const declarations = new Map(style.split(";").filter(Boolean).map((declaration) => {
    const colon = declaration.indexOf(":");
    return [declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim()];
  }));
  const em = (property: string) => {
    const value = declarations.get(property) ?? "";
    return /^-?\d+(?:\.\d+)?em$/.test(value) ? parseFloat(value) : NaN;
  };
  const padding = em("padding-left");
  const alignment = em("vertical-align");
  if (!Number.isFinite(padding) || !Number.isFinite(alignment)
    || declarations.get("position") !== "relative") return null;
  // BoxAtom's original alignment is body.depth + 2 * padding.
  declarations.set("vertical-align", `${Number((padding - alignment).toFixed(4))}em`);
  declarations.set("top", "0");
  declarations.set("margin-top", "0");
  return [...declarations].map(([key, value]) => `${key}:${value}`).join(";");
}

export function normalizeMathLiveBoxMarkup(markup: string): string {
  return markup.replace(
    /<span([^<>]*?)style="([^"]*)"([^<>]*?)>(<span\b[^<>]*class="ML__box"[^<>]*>)/g,
    (match, before: string, style: string, after: string, frame: string) => {
      if (!/\bborder:/.test(frame) || `${before}${after}`.includes(MATHLIVE_BOX_LAYOUT_CLASS)) return match;
      const normalized = normalizeMathLiveBoxStyle(style);
      if (!normalized) return match;
      const attributes = `${before}${after}`;
      const classes = /class="([^"]*)"/;
      const withClass = classes.test(attributes)
        ? attributes.replace(classes, `class="$1 ${MATHLIVE_BOX_LAYOUT_CLASS}"`)
        : `${attributes} class="${MATHLIVE_BOX_LAYOUT_CLASS}"`;
      return `<span${withClass} style="${normalized}">${frame}`;
    },
  );
}
