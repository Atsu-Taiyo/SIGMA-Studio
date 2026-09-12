import type { Element as HastElement, Root as HastRoot, RootContent } from "hast";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import latex from "highlight.js/lib/languages/latex";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import r from "highlight.js/lib/languages/r";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scheme from "highlight.js/lib/languages/scheme";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { createLowlight } from "lowlight";

/**
 * コードブロックの色分け。
 *
 * **色は保存しない。** SigmaDoc が持つのは本文と（あれば）言語だけで、トークンは毎回ここで
 * 引き直す派生値。リストマーカーの字体継承と同じ考え方で、これにより編集中の ProseMirror・
 * 静的描画・印刷/PDF・埋め込みビューアが「同じ関数から同じ色」を出せる。
 *
 * 言語は全部入りではなく下の一覧に絞ってある。highlight.js の `common` は 37 言語あり、
 * 埋め込みビューア (packages/viewer) もこの経路を通るので、載せる分だけ配布物が太る。
 * 増やすときはここに 1 行足すだけでよい。
 */

/** 選べる言語。`value` は highlight.js の登録名そのもので、`data-code-language` にも出る。 */
export type CodeBlockLanguageOption =
  | { value: string; label: string; labelKey?: never }
  | { value: string; label?: never; labelKey: "codeBlock.languageName.plaintext" | "codeBlock.languageName.shell" };

export const CODE_BLOCK_LANGUAGES: ReadonlyArray<CodeBlockLanguageOption> = [
  { value: "plaintext", labelKey: "codeBlock.languageName.plaintext" },
  { value: "python", label: "Python" },
  { value: "javascript", label: "JavaScript" },
  { value: "typescript", label: "TypeScript" },
  { value: "java", label: "Java" },
  { value: "c", label: "C" },
  { value: "cpp", label: "C++" },
  { value: "csharp", label: "C#" },
  { value: "go", label: "Go" },
  { value: "rust", label: "Rust" },
  { value: "ruby", label: "Ruby" },
  { value: "php", label: "PHP" },
  { value: "swift", label: "Swift" },
  { value: "kotlin", label: "Kotlin" },
  { value: "r", label: "R" },
  { value: "scheme", label: "Scheme" },
  { value: "sql", label: "SQL" },
  { value: "bash", labelKey: "codeBlock.languageName.shell" },
  { value: "json", label: "JSON" },
  { value: "yaml", label: "YAML" },
  { value: "xml", label: "HTML / XML" },
  { value: "css", label: "CSS" },
  { value: "markdown", label: "Markdown" },
  { value: "latex", label: "TeX" },
];

const lowlight = createLowlight({
  bash,
  c,
  cpp,
  csharp,
  css,
  go,
  java,
  javascript,
  json,
  kotlin,
  latex,
  markdown,
  php,
  python,
  r,
  ruby,
  rust,
  scheme,
  sql,
  swift,
  typescript,
  xml,
  yaml,
});

const REGISTERED_LANGUAGES = new Set(CODE_BLOCK_LANGUAGES.map((option) => option.value));

/** 色分けを持たない言語。選べるが、highlight.js には登録しない (トークンが出ないだけ)。 */
export const PLAIN_CODE_LANGUAGE = "plaintext";

/**
 * 自動判定を始める最小の長さ。
 *
 * 数文字では highlight.js の判定が打鍵のたびに揺れ、色がちらつく。ある程度書けてから
 * 色が付き始めるほうが落ち着いて見える、という理由だけの閾値。
 */
const AUTO_DETECT_MIN_LENGTH = 24;

/**
 * 教材本文の応答性を優先して色分けを止める上限。
 *
 * highlight.js は入力全体を同期的に解析し、編集面では得られた token ごとに ProseMirror の
 * Decoration も作る。数千行のログや生成コードを貼ったときまで全文を解析すると、打鍵のたびに
 * UI スレッドを長時間ふさいでしまう。上限を超えてもコード本文・言語・印刷内容は一切変えず、
 * 派生表示である色分けだけを省略する。
 */
export const MAX_HIGHLIGHT_CODE_LENGTH = 100_000;
export const MAX_HIGHLIGHT_CODE_LINES = 2_000;

/**
 * 自動判定を採用する下限の確信度。
 *
 * highlight.js の relevance は短い断片だと 2〜4 程度にしかならない (実測: 3行の JavaScript で 4、
 * 2行の Python で 3、`a = 1` で 0)。高くしすぎると普通のコードにまったく色が付かないので、
 * 「言語らしさが 1 つも無い」を弾く高さに置く。
 */
const AUTO_DETECT_MIN_RELEVANCE = 2;

/**
 * 自動判定の候補。**選べる言語の一覧より狭い**のが要点。
 *
 * 登録した 23 言語すべてを候補にすると外れる。実測では `function add(a, b) { … }` が CSS と
 * 判定された — 波括弧のブロックだけを見ると CSS にも見えるため。候補を「よく使う・互いに
 * 見分けのつく」ものへ絞ると、同じ入力が JavaScript に落ち着く。
 *
 * この一覧に無い言語は「選べば使えるが、自動では選ばれない」。似た言語同士 (Java と
 * JavaScript など) の取り違えは残るが、その 2 つは色の付き方もほぼ同じなので実害が小さい。
 */
const AUTO_DETECT_SUBSET = [
  "python",
  "javascript",
  "typescript",
  "java",
  "c",
  "cpp",
  "sql",
  "bash",
  "json",
  "xml",
  "css",
];

/**
 * 直近の結果。打鍵のたびに文書中の **全部の** コードブロックを引き直すので、変わっていない
 * ブロックまで毎回走らせない (自動判定は候補ぶん走るので特に効く)。
 */
const highlightCache = new Map<string, CodeHighlightToken[]>();
const HIGHLIGHT_CACHE_LIMIT = 64;

/** 読めない言語は `undefined` (＝自動判定) に落とす。未知の値で色が消えるだけで、本文は残る。 */
export function normalizeCodeLanguage(value: unknown): string | undefined {
  return typeof value === "string" && REGISTERED_LANGUAGES.has(value) ? value : undefined;
}

export interface CodeHighlightToken {
  /** このトークンが覆う文字数。位置合わせに使うので、必ず元の文字列の長さと一致させる。 */
  length: number;
  /** `hljs-keyword` などの class。色の付かない地の文は `undefined`。 */
  className?: string;
}

/**
 * コード文字列をトークン列に分ける。トークンの `length` の総和は必ず `code.length` と等しい。
 *
 * 呼び出し側 (ProseMirror の装飾・静的描画) はこの長さだけを見て位置を割り出すので、
 * 「編集中と印刷で色の付く範囲が違う」ということが起きない。
 */
export function highlightCode(code: string, language?: string): CodeHighlightToken[] {
  if (!shouldHighlightCode(code)) {
    return code.length > 0 ? [{ length: code.length }] : [];
  }
  const cacheKey = `${language ?? ""}\u0000${code}`;
  const cached = highlightCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const tree = highlightTree(code, language);
  const tokens: CodeHighlightToken[] = [];
  if (tree) {
    collectTokens(tree.children, undefined, tokens);
  } else if (code.length > 0) {
    tokens.push({ length: code.length });
  }
  const merged = mergeAdjacentTokens(tokens);

  if (highlightCache.size >= HIGHLIGHT_CACHE_LIMIT) {
    // 打鍵ごとに 1 件増えるだけなので、古い順に落とせば足りる。
    highlightCache.delete(highlightCache.keys().next().value as string);
  }
  highlightCache.set(cacheKey, merged);
  return merged;
}

/** 自動判定が選んだ言語。明示指定があればそれをそのまま返す。判定できなければ `undefined`。 */
export function detectCodeLanguage(code: string, language?: string): string | undefined {
  const normalized = normalizeCodeLanguage(language);
  if (normalized) {
    return normalized;
  }
  if (!shouldHighlightCode(code)) {
    return undefined;
  }
  return autoDetect(code)?.language;
}

/** 色分けのために巨大な一時木・Decoration 集合を作ってよい大きさか。 */
export function shouldHighlightCode(code: string): boolean {
  if (code.length > MAX_HIGHLIGHT_CODE_LENGTH) {
    return false;
  }

  let lines = 1;
  for (let index = 0; index < code.length; index += 1) {
    if (code.charCodeAt(index) === 10 && ++lines > MAX_HIGHLIGHT_CODE_LINES) {
      return false;
    }
  }
  return true;
}

function highlightTree(code: string, language: string | undefined): HastRoot | undefined {
  const normalized = normalizeCodeLanguage(language);
  if (normalized === PLAIN_CODE_LANGUAGE) {
    return undefined;
  }
  if (normalized) {
    try {
      return lowlight.highlight(normalized, code);
    } catch {
      // 登録漏れなど。色が付かないだけで本文は無傷。
      return undefined;
    }
  }
  return autoDetect(code)?.tree;
}

function autoDetect(code: string): { tree: HastRoot; language: string } | undefined {
  if (code.trim().length < AUTO_DETECT_MIN_LENGTH) {
    return undefined;
  }
  try {
    const tree = lowlight.highlightAuto(code, { subset: AUTO_DETECT_SUBSET });
    const language = tree.data?.language;
    const relevance = tree.data?.relevance ?? 0;
    if (typeof language !== "string" || relevance < AUTO_DETECT_MIN_RELEVANCE) {
      return undefined;
    }
    return { tree, language };
  } catch {
    return undefined;
  }
}

/**
 * hast を平らなトークン列にする。
 *
 * highlight.js は入れ子で色を付ける (文字列の中の埋め込み式など)。一番内側の class を採るのは、
 * CSS 側が 1 要素 1 色でしか塗れないため — 入れ子のまま出しても外側の色が見えることはない。
 */
function collectTokens(
  nodes: readonly RootContent[],
  inheritedClassName: string | undefined,
  out: CodeHighlightToken[],
): void {
  for (const node of nodes) {
    if (node.type === "text") {
      if (node.value.length > 0) {
        out.push({ length: node.value.length, className: inheritedClassName });
      }
      continue;
    }
    if (node.type === "element") {
      collectTokens(node.children, elementClassName(node) ?? inheritedClassName, out);
    }
  }
}

function elementClassName(node: HastElement): string | undefined {
  const className = node.properties?.className;
  if (!Array.isArray(className)) {
    return undefined;
  }
  const first = className.find((entry) => typeof entry === "string" && entry.length > 0);
  return typeof first === "string" ? first : undefined;
}

function mergeAdjacentTokens(tokens: readonly CodeHighlightToken[]): CodeHighlightToken[] {
  const merged: CodeHighlightToken[] = [];
  for (const token of tokens) {
    const previous = merged[merged.length - 1];
    if (previous && previous.className === token.className) {
      previous.length += token.length;
      continue;
    }
    merged.push({ ...token });
  }
  return merged;
}

/**
 * トークン列を「開始位置つき」に直す。位置で切る側 (装飾・静的描画) が毎回書かずに済むように。
 */
export function codeHighlightRanges(
  code: string,
  language?: string,
): Array<{ from: number; to: number; className: string }> {
  const ranges: Array<{ from: number; to: number; className: string }> = [];
  let offset = 0;
  for (const token of highlightCode(code, language)) {
    if (token.className) {
      ranges.push({ from: offset, to: offset + token.length, className: token.className });
    }
    offset += token.length;
  }
  return ranges;
}
