/** Whole-formula text formatting stays in canonical TeX, rather than unsupported math marks. */
export function readMathTextFormat(tex: string): { tex: string; bold: boolean; italic: boolean } {
  let bold = false;
  let italic = false;
  while (true) {
    const match = /^\\(boldsymbol|mathit)\{/.exec(tex);
    if (!match) break;
    let depth = 1;
    let end = match[0].length;
    for (; end < tex.length; end += 1) {
      if (tex[end] === "\\") {
        end += 1;
        continue;
      }
      if (tex[end] === "{") depth += 1;
      if (tex[end] === "}" && --depth === 0) break;
    }
    if (depth !== 0 || end !== tex.length - 1) break;
    bold ||= match[1] === "boldsymbol";
    italic ||= match[1] === "mathit";
    tex = tex.slice(match[0].length, -1);
  }
  return { tex, bold, italic };
}

export function writeMathTextFormat(tex: string, marks: readonly { type: string | { name: string } }[] = []): string {
  const has = (name: string) => marks.some((mark) => (typeof mark.type === "string" ? mark.type : mark.type.name) === name);
  if (has("italic")) tex = `\\mathit{${tex}}`;
  if (has("bold")) tex = `\\boldsymbol{${tex}}`;
  return tex;
}
