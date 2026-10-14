import { fontSizeToOverlaySize, type InlineNode, type OverlayShape, type TextMark } from "@/features/document";
import { pxToPt } from "@/features/document/overlay-text-font";
import { estimateTextWidthEm, svgNumbers, type SvgMatrix } from "@/features/drawing";
import { childrenOf, resolvedAttrs, tagOf, type XmlNode } from "./svg-image-source";

type TextShape = Extract<OverlayShape, { type: "text" }>;
export interface SvgTextMetrics { width: number; height: number; baseline: number }
export type MeasureSvgOverlayText = (shape: TextShape) => SvgTextMetrics | null;
interface Run { text: string; attrs: Record<string, string>; size: number; shift: number }

const GREEK: Record<string, string> = {
  α: "alpha", β: "beta", γ: "gamma", δ: "delta", ε: "epsilon", ζ: "zeta", η: "eta", θ: "theta",
  ι: "iota", κ: "kappa", λ: "lambda", μ: "mu", ν: "nu", ξ: "xi", π: "pi", ρ: "rho", σ: "sigma",
  τ: "tau", υ: "upsilon", φ: "phi", χ: "chi", ψ: "psi", ω: "omega", Γ: "Gamma", Δ: "Delta",
  Θ: "Theta", Λ: "Lambda", Ξ: "Xi", Π: "Pi", Σ: "Sigma", Υ: "Upsilon", Φ: "Phi", Ψ: "Psi", Ω: "Omega",
};
const OPERATORS: Record<string, string> = { "−": "-", "×": "\\times ", "÷": "\\div ", "±": "\\pm ", "≤": "\\le ", "≥": "\\ge ", "≠": "\\ne ", "∞": "\\infty " };
const LETTER = /[A-Za-zα-ωΓΔΘΛΞΠΣΥΦΨΩ]/u;
const SINGLE_VARIABLE = /^[A-Za-zα-ωΓΔΘΛΞΠΣΥΦΨΩ]$/u;
const MATH_CONTENT = /^[A-Za-zα-ωΓΔΘΛΞΠΣΥΦΨΩ0-9\s.,()+\-−*/=<>[\]{}×÷±≤≥≠∞]+$/u;

function number(value: string | undefined, fallback = 0): number {
  const values = value === undefined ? [fallback] : svgNumbers(value);
  if (values.length !== 1) throw new Error("position list");
  return values[0];
}
export function svgFontSizePx(value: string | undefined, parent: number): number {
  if (value === undefined) return parent;
  const match = /^([\d.]+)(px|pt|em|%)?$/.exec(value);
  if (!match) throw new Error("font size");
  const size = Number(match[1]) * (match[2] === "pt" ? 4 / 3 : match[2] === "em" ? parent : match[2] === "%" ? parent / 100 : 1);
  if (!Number.isFinite(size) || size <= 0 || size > 4096) throw new Error("font size");
  return size;
}
function unsupportedStyle(attrs: Record<string, string>): boolean {
  return ["clip-path", "mask", "marker-start", "marker-mid", "marker-end"].some((key) => attrs[key] && attrs[key] !== "none") ||
    (attrs.stroke !== undefined && attrs.stroke !== "none") || /url\(/.test(attrs.fill ?? "") || attrs.fill === "none" ||
    (attrs["fill-opacity"] !== undefined && Number(attrs["fill-opacity"]) !== 1) ||
    (attrs["letter-spacing"] !== undefined && !["0", "normal"].includes(attrs["letter-spacing"])) ||
    (attrs["text-decoration"] !== undefined && !["none", "underline"].includes(attrs["text-decoration"])) ||
    ["dominant-baseline", "alignment-baseline"].some((key) => attrs[key] && !["auto", "alphabetic"].includes(attrs[key]));
}
function texRun(run: Run): string {
  // SVG text is characters, never executable TeX. Only this bounded alphabet is translated.
  return run.text.replace(/[A-Za-z]+|./gu, (token) => {
    if (/^[A-Za-z]+$/.test(token)) return run.attrs["font-style"] === "italic" ? token : `\\mathrm{${token}}`;
    if (GREEK[token]) return `\\${GREEK[token]} `;
    if (OPERATORS[token]) return OPERATORS[token];
    if (token === "{" || token === "}") return `\\${token}`;
    return token;
  });
}
function mathNode(runs: Run[], createId: () => string): InlineNode {
  let tex = "";
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    if (!run.shift) { tex += texRun(run); continue; }
    let script = texRun(run);
    while (runs[i + 1]?.shift === run.shift) script += texRun(runs[++i]);
    tex += `${run.shift > 0 ? "_" : "^"}{${script}}`;
  }
  return { type: "mathInline", id: createId(), tex: tex.trim(), display: "inline", color: runs[0].attrs.fill,
    semanticRole: tex.includes("=") ? "equation" : SINGLE_VARIABLE.test(runs.map((r) => r.text).join("")) ? "variable" : "expression" };
}
function inlineNodes(runs: Run[], baseSize: number, scale: number, createId: () => string): InlineNode[] | null {
  const text = runs.map((r) => r.text).join("");
  const words = text.match(/[A-Za-z]+/g) ?? [];
  const shortSymbols = words.every((word) => word.length <= 2 || ["sin", "cos", "tan", "log", "ln", "exp"].includes(word));
  const samePaint = runs.every((r) => (r.attrs.fill ?? "black") === (runs[0].attrs.fill ?? "black") &&
    !r.attrs["font-weight"]?.match(/^(bold|[6-9]00)$/) && !r.attrs["text-decoration"]?.includes("underline"));
  const hasScript = runs.some((r) => r.shift !== 0);
  const isFormula = MATH_CONTENT.test(text) && LETTER.test(text) && shortSymbols && samePaint &&
    (hasScript || runs.some((r) => r.attrs["font-style"] === "italic" && SINGLE_VARIABLE.test(r.text.trim())) ||
      /[α-ωΓΔΘΛΞΠΣΥΦΨΩ=<>×÷±≤≥≠+*/]/u.test(text) || /[A-Za-z]\s*\([^)]*[A-Za-z0-9]/.test(text));
  if (isFormula) return runs.every((run) => run.shift || run.size === baseSize) ? [mathNode(runs, createId)] : null;
  // A displaced run without a recognizable formula cannot be represented by normal text marks.
  if (hasScript) return null;
  return runs.map((run): InlineNode => {
    if (run.attrs["font-style"] === "italic" && SINGLE_VARIABLE.test(run.text.trim()) && run.text === run.text.trim() &&
      !run.attrs["font-weight"]?.match(/^(bold|[6-9]00)$/) && !run.attrs["text-decoration"]?.includes("underline")) {
      return { ...mathNode([run], createId), ...(run.size === baseSize ? {} : { fontSize: pxToPt(run.size * scale) }) };
    }
    const marks: TextMark[] = [];
    if (run.attrs["font-style"] === "italic" || run.attrs["font-style"] === "oblique") marks.push("italic");
    if (run.attrs["font-weight"] === "bold" || Number(run.attrs["font-weight"]) >= 600) marks.push("bold");
    if (run.attrs["text-decoration"] === "underline") marks.push("underline");
    return { type: "text", text: run.text, ...(marks.length ? { marks } : {}), color: run.attrs.fill,
      fontFamily: run.attrs["font-family"] ?? "serif", ...(run.size === baseSize ? {} : { fontSize: pxToPt(run.size * scale) }) };
  });
}

/** SVG labels become canonical overlay text with native inline math where the notation is clear. */
export function svgTextToOverlay(node: XmlNode, attrs: Record<string, string>, matrix: SvgMatrix,
  createId: () => string, measure?: MeasureSvgOverlayText): TextShape | null {
  try {
    if (unsupportedStyle(attrs) || attrs.visibility === "hidden" || attrs["baseline-shift"]) return null;
    const scale = Math.hypot(matrix[0], matrix[1]), scaleY = Math.hypot(matrix[2], matrix[3]);
    if (scale <= 0 || Math.abs(scale - scaleY) > scale * 1e-7 || Math.abs(matrix[0] * matrix[2] + matrix[1] * matrix[3]) > scale * scale * 1e-7) return null;
    const baseSize = svgFontSizePx(attrs["font-size"], 16);
    const runs: Run[] = [];
    let dy = 0;
    const read = (element: XmlNode, inherited: Record<string, string>, parentSize: number, baselineShift = 0) => {
      if (tagOf(element) === "#text") {
        const text = String(element["#text"]).replace(/[\t\r\n]/g, " ");
        if (text) runs.push({ text, attrs: inherited, size: parentSize, shift: dy + baselineShift });
        return;
      }
      if (tagOf(element) !== "tspan") throw new Error("text child");
      const own = resolvedAttrs(element), next = { ...inherited, ...own }, size = svgFontSizePx(own["font-size"], parentSize);
      if (["x", "y", "dx", "transform"].some((key) => own[key] !== undefined) || unsupportedStyle(next) ||
        (own.opacity && own.opacity !== "1") || ["display", "visibility", "text-anchor"].some((key) => own[key] !== undefined)) throw new Error("positioned text");
      dy += number(own.dy);
      const shift = own["baseline-shift"] === "sub" ? size * 0.3 : own["baseline-shift"] === "super" ? -size * 0.5 :
        own["baseline-shift"] && own["baseline-shift"] !== "baseline" ? number(own["baseline-shift"]) * -1 : 0;
      childrenOf(element).forEach((child) => read(child, next, size, baselineShift + shift));
    };
    childrenOf(node).forEach((child) => read(child, attrs, baseSize));
    const preserveSpace = attrs["xml:space"] === "preserve";
    if (!preserveSpace) {
      let previousSpace = true;
      for (const run of runs) run.text = run.text.replace(/\s+/g, " ").split("").filter((char) => {
        const keep = char !== " " || !previousSpace;
        previousSpace = char === " ";
        return keep;
      }).join("");
      const last = runs.findLast((run) => run.text);
      if (last) last.text = last.text.trimEnd();
    }
    const nonempty = runs.filter((r) => r.text);
    if (!nonempty.length || nonempty.some((r) => r.shift && (r.size > baseSize * 0.9 || Math.abs(r.shift) > baseSize * 0.8))) return null;
    const children = inlineNodes(nonempty, baseSize, scale, createId);
    if (!children) return null;
    const anchor = attrs["text-anchor"] ?? "start";
    if (!["start", "middle", "end"].includes(anchor)) return null;
    const fontSize = pxToPt(baseSize * scale), fontHeight = fontSize * 4 / 3;
    const estimatedWidth = Math.max(8, nonempty.reduce((w, r) => w + estimateTextWidthEm(r.text) * r.size * scale, 0) + 2);
    const shape: TextShape = { id: createId(), type: "text", x: 0, y: 0, rotation: 0,
      props: { w: estimatedWidth, h: Math.ceil(fontHeight), color: attrs.fill === "currentColor" ? attrs.color ?? "black" : attrs.fill ?? "black",
        fontSize, size: fontSizeToOverlaySize(fontSize), blocks: [{ id: createId(), type: "paragraph", lineHeight: "1",
          align: anchor === "middle" ? "center" : anchor === "end" ? "right" : "left", children }] } };
    const measured = measure?.(shape);
    const metrics = measured && [measured.width, measured.height, measured.baseline].every(Number.isFinite) && measured.width > 0 && measured.height > 0
      ? measured : { width: estimatedWidth, height: Math.ceil(fontHeight), baseline: fontHeight * 0.8 };
    const w = Math.max(8, metrics.width), h = Math.max(fontHeight, metrics.height);
    const x = number(attrs.x) + number(attrs.dx), y = number(attrs.y) + number(attrs.dy);
    const baseline = { x: matrix[0] * x + matrix[2] * y + matrix[4], y: matrix[1] * x + matrix[3] * y + matrix[5] };
    const angle = Math.atan2(matrix[1], matrix[0]), mirrorY = matrix[0] * matrix[3] - matrix[1] * matrix[2] < 0 ? -1 : 1;
    const offsetX = anchor === "middle" ? 0 : anchor === "end" ? -w / 2 : w / 2;
    const offsetY = (h / 2 - metrics.baseline) * mirrorY;
    return { ...shape, x: baseline.x + Math.cos(angle) * offsetX - Math.sin(angle) * offsetY - w / 2,
      y: baseline.y + Math.sin(angle) * offsetX + Math.cos(angle) * offsetY - h / 2,
      rotation: angle, ...(mirrorY < 0 ? { flipY: true } : {}), props: { ...shape.props, w, h } };
  } catch { return null; }
}
