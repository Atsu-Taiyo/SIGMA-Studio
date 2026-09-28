import type { TikzEnvironment, TikzImageSource } from "./model/tikz";
export type { TikzEnvironment, TikzImageSource } from "./model/tikz";

export const EMPTY_TIKZ_ENVIRONMENT: TikzEnvironment = { packages: "", libraries: "", preamble: "" };
export const MAX_TIKZ_SOURCE_LENGTH = 100_000;
export const MAX_TIKZ_ENVIRONMENT_LENGTH = 20_000;

export function isTikzEnvironment(value: unknown): value is TikzEnvironment {
  if (!value || typeof value !== "object") return false;
  const env = value as Record<string, unknown>;
  return ["packages", "libraries", "preamble"].every((key) =>
    typeof env[key] === "string" && env[key].length <= MAX_TIKZ_ENVIRONMENT_LENGTH);
}

export function isTikzImageSource(value: unknown): value is TikzImageSource {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  return typeof input.source === "string" && input.source.length > 0 &&
    input.source.length <= MAX_TIKZ_SOURCE_LENGTH && isTikzEnvironment(input.environment);
}

/** Only consume a complete TikZ snippet, never ordinary prose mentioning a command. */
export function readTikzClipboardSource(text: string): string | null {
  const explicit = text.trim().match(/^```tikz\s*\n([\s\S]*?)\n```$/i);
  if (explicit?.[1].trim()) return explicit[1].trim();
  const source = text.trim().replace(/^```(?:latex|tex)?\s*\n([\s\S]*?)\n```$/i, "$1").trim();
  const uncommented = source.replace(/(?<!\\)%[^\n]*/g, "").trim();
  if (/^\\tikz(?:\s|\[|\{)/.test(uncommented) && /[};]$/.test(uncommented)) return source;
  if (!uncommented.startsWith("\\") || !/\\begin\s*\{(?:tikzpicture|tikzcd|circuitikz)\}/.test(uncommented)) return null;
  if (!/\\end\s*\{(?:tikzpicture|tikzcd|circuitikz|document)\}\s*$/.test(uncommented)) return null;
  return source;
}

/** TikZJax supplies the standalone class. Preserve the user's preamble and document body. */
export function prepareTikzInput(input: TikzImageSource): string {
  const source = input.source.replace(/\\documentclass\s*(?:\[[^\]]*\]\s*)?\{[^}]*\}/g, "");
  const environmentStart = source.search(/\\begin\s*\{(?:tikzpicture|tikzcd|circuitikz)\}|\\tikz(?=\s|\[|\{)/);
  const split = environmentStart < 0 ? 0 : environmentStart;
  const body = /\\begin\s*\{document\}/.test(source)
    ? source
    : `${source.slice(0, split)}\n\\begin{document}\n${source.slice(split)}\n\\end{document}`;
  const { packages, libraries, preamble } = input.environment;
  // Standard arrow tips (Latex, Stealth, ...) must also work for saved images whose
  // environment has no libraries. Load before user definitions without rewriting them.
  return `\\usetikzlibrary{arrows.meta}\n${packages}\n${libraries.trim() ? `\\usetikzlibrary{${libraries}}` : ""}\n${preamble}\n${body}`;
}
