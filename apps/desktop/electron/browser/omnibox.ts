import { parse } from "tldts";

import { DEFAULT_SEARCH_ENGINE_ID, SEARCH_ENGINES, type SearchEngineId } from "@/lib/browser/in-app-browser-contract";

/**
 * アドレスバーの入力を「開くURL」に解決する。URLか検索語かの判定は自前の正規表現ではなく、
 * Public Suffix List を持つ tldts に任せる (`example.co.jp` は URL、`hello.world` は検索語)。
 */

const SEARCH_URL_TEMPLATES: Record<SearchEngineId, string> = {
  google: "https://www.google.com/search?q=%s",
  duckduckgo: "https://duckduckgo.com/?q=%s",
  bing: "https://www.bing.com/search?q=%s",
  "yahoo-japan": "https://search.yahoo.co.jp/search?p=%s",
};

export type OmniboxResolution =
  | { kind: "empty" }
  | { kind: "url"; url: string }
  | { kind: "search"; url: string; query: string };

const EXPLICIT_SCHEME = /^([a-z][a-z0-9+.-]*):/i;
const HOST_WITH_PORT = /^(?:localhost|\[[0-9a-f:]+\]|(?:\d{1,3}\.){3}\d{1,3}|[a-z0-9-]+(?:\.[a-z0-9-]+)*):\d{1,5}(?:[/?#]|$)/i;
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;

export function findSearchEngine(id: string | null | undefined) {
  const engine = SEARCH_ENGINES.find((candidate) => candidate.id === id)
    ?? SEARCH_ENGINES.find((candidate) => candidate.id === DEFAULT_SEARCH_ENGINE_ID)!;
  return { ...engine, template: SEARCH_URL_TEMPLATES[engine.id] };
}

export function searchUrl(query: string, engineId?: string | null): string {
  return findSearchEngine(engineId).template.replace("%s", encodeURIComponent(query));
}

/** ページとして開いてよい宛先。file: や独自スキームでアプリ内の資源へ届かせない。 */
export function isBrowsableUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function resolveOmniboxInput(input: string, engineId?: string | null): OmniboxResolution {
  const text = input.trim();
  if (!text) return { kind: "empty" };
  const search = (): OmniboxResolution => ({ kind: "search", url: searchUrl(text, engineId), query: text });
  if (/\s/.test(text)) return search();

  // `localhost:3000` は形の上ではスキーム付きに見えるので先に拾う。
  if (HOST_WITH_PORT.test(text)) {
    const url = `${isLocalHost(text) ? "http" : "https"}://${text}`;
    return isBrowsableUrl(url) ? { kind: "url", url } : search();
  }

  const scheme = EXPLICIT_SCHEME.exec(text)?.[1]?.toLowerCase();
  if (scheme) {
    // http(s) 以外 (javascript: / file: / data: など) は開かず、検索語として扱う。
    return (scheme === "http" || scheme === "https") && isBrowsableUrl(text) ? { kind: "url", url: text } : search();
  }

  const { hostname, isIcann, isIp } = parse(text, { allowPrivateDomains: false });
  if (hostname && (isIp || isIcann || isLocalHost(hostname))) {
    const url = `${isLocalHost(hostname) ? "http" : "https"}://${text}`;
    return isBrowsableUrl(url) ? { kind: "url", url } : search();
  }
  return search();
}

function isLocalHost(value: string): boolean {
  const host = value.replace(/^\[|\](?::\d+.*)?$|:\d+(?:[/?#].*)?$|[/?#].*$/g, "");
  return host === "localhost" || host === "::1" || IPV4.test(host) || host.endsWith(".local");
}

/**
 * 入力中の検索候補の取得先。候補はメインプロセスが取得する (レンダラのCSPは外部通信を許さない)。
 * 候補APIを持たない検索エンジンは、同じ形式で返す Google の候補で代用する。
 */
export function suggestionEndpoint(query: string, engineId?: string | null): string {
  const q = encodeURIComponent(query);
  switch (findSearchEngine(engineId).id) {
    case "duckduckgo":
      return `https://duckduckgo.com/ac/?type=list&q=${q}`;
    case "bing":
      return `https://api.bing.com/osjson.aspx?query=${q}`;
    default:
      return `https://suggestqueries.google.com/complete/search?client=firefox&hl=ja&q=${q}`;
  }
}

/** OpenSearch形式 `[query, [候補...]]` から候補だけを取り出す。形が違えば空。 */
export function parseSuggestions(payload: unknown, limit = 8): string[] {
  if (!Array.isArray(payload) || !Array.isArray(payload[1])) return [];
  const seen = new Set<string>();
  for (const entry of payload[1]) {
    if (typeof entry !== "string") continue;
    const text = entry.trim();
    if (text && text.length <= 200) seen.add(text);
    if (seen.size >= limit) break;
  }
  return [...seen];
}
