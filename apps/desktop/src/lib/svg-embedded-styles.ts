/**
 * SVG を `<img>` や canvas で描くと、その SVG は文書のスタイルシートもフォントも読めない。
 * `<foreignObject>` の中の HTML (グラフの軸・目盛り、図形の文字、数式) はページの CSS クラスで
 * 線の色や太さ・書体を決めているので、そのまま画像にすると線が消えて白紙になる。
 * ここではページの CSS とフォントを SVG に埋め込み、画像にしても画面と同じに描けるようにする。
 *
 * もう一つの落とし穴: 図形の書き出し (`exportOverlaySvg`) は foreignObject の中の HTML に入れ子の
 * `<svg>` を名前空間なしで書く。紙面に直接入れると HTML のパーサーが SVG の名前空間を補うが、
 * 画像は厳密な XML として読むので、入れ子の `<svg>` が HTML の未知の要素になり何も描かれない。
 * 画像にする前に、名前空間の無い `<svg>` / `<math>` の開始タグへ名前空間を書き足す (`normalizeSvgMarkupForImage`)。
 * (HTML として読み直す方法もあるが、文字列から DOM を組み立てる経路はクリップボードの取り込み 1 か所に固定している。)
 *
 * renderer 専用 (`document.styleSheets` と `document.fonts` を読む)。
 * 印刷のサムネイル (`components/print/rasterize-print-thumbnail.ts`) と、AIへ渡す図形プレビューの
 * PNG (`features/ai-edit/application/ai-chat-attachments.ts`) が同じ手順を使う。
 */

/**
 * 文書のスタイル規則を文字列にする。`@font-face` は SVG の画像からは読めないので外し、
 * 埋め込み済みの写し (`collectEmbeddedFontCss`) で置き換える。
 */
export function collectDocumentCssText(keep: (rule: CSSRule) => boolean = () => true): string {
  const parts: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(rules)) {
      if (typeof CSSFontFaceRule !== "undefined" && rule instanceof CSSFontFaceRule) {
        continue;
      }
      if (keep(rule)) {
        parts.push(rule.cssText);
      }
    }
  }
  return parts.join("\n");
}

// 印刷のサムネイル (全書体) と図形プレビュー (使う書体だけ) が交互に呼んでも作り直さないよう、組み合わせごとに持つ。
const embeddedFontCache = new Map<string, Promise<string>>();
const MAX_EMBEDDED_FONT_CACHE_ENTRIES = 8;

/**
 * この renderer が実際に読み込んだ書体を data URL で埋め込む。サブセットの書体は unicode-range を
 * 多数持つが、画面に出ている文字に要るのは読み込み済みのものだけ。
 * `families` を渡すと、その書体名 (小文字・引用符なし) だけに絞る。
 */
export function collectEmbeddedFontCss(families?: ReadonlySet<string>): Promise<string> {
  const loaded = Array.from(document.fonts ?? [])
    .filter((face) => face.status === "loaded")
    .filter((face) => !families || families.has(normalizeFamily(face.family)));
  const key = loaded.map(faceKey).sort().join(";");
  const cached = embeddedFontCache.get(key);
  if (cached) {
    return cached;
  }
  const wanted = new Set(loaded.map(faceKey));
  const css = (async () => {
    const rules: Promise<string | null>[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let sheetRules: CSSRuleList;
      try {
        sheetRules = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of Array.from(sheetRules)) {
        if (typeof CSSFontFaceRule === "undefined" || !(rule instanceof CSSFontFaceRule)) {
          continue;
        }
        const style = rule.style;
        const family = unquote(style.getPropertyValue("font-family"));
        const weight = style.getPropertyValue("font-weight") || "normal";
        const fontStyle = style.getPropertyValue("font-style") || "normal";
        const range = style.getPropertyValue("unicode-range") || "U+0-10FFFF";
        if (!wanted.has(faceKey({ family, weight, style: fontStyle, unicodeRange: range }))) {
          continue;
        }
        const url = firstFontUrl(style.getPropertyValue("src"), sheet.href ?? document.baseURI);
        if (!url) {
          continue;
        }
        rules.push(readAsDataUrl(url).then((dataUrl) => (
          `@font-face{font-family:"${family}";font-style:${fontStyle};font-weight:${weight};unicode-range:${range};src:url(${dataUrl});}`
        )).catch(() => null));
      }
    }
    return (await Promise.all(rules)).filter(Boolean).join("\n");
  })();
  if (embeddedFontCache.size >= MAX_EMBEDDED_FONT_CACHE_ENTRIES) {
    embeddedFontCache.delete(embeddedFontCache.keys().next().value!);
  }
  embeddedFontCache.set(key, css);
  return css;
}

/** カスタムプロパティは `html` に載っているが、SVG の画像の中には `html` が無い。 */
export function rootCustomPropertyDeclarations(): string {
  const computed = getComputedStyle(document.documentElement);
  let declarations = "";
  for (let index = 0; index < computed.length; index += 1) {
    const name = computed[index];
    if (name.startsWith("--")) {
      declarations += `${name}:${computed.getPropertyValue(name)};`;
    }
  }
  return declarations;
}

/** SVG の `class` 属性に出てくるクラス名。 */
export function collectSvgClassNames(svg: string): Set<string> {
  const names = new Set<string>();
  for (const match of svg.matchAll(/\sclass="([^"]*)"/g)) {
    for (const name of match[1]!.split(/\s+/)) {
      if (name) {
        names.add(name);
      }
    }
  }
  return names;
}

/** 規則のセレクタ (入れ子の規則を含む) に、使われているクラスが一つでも出てくるか。 */
export function cssRuleMentionsClass(cssText: string, classNames: ReadonlySet<string>): boolean {
  const selectorPart = cssText.includes("{") ? cssText : "";
  for (const match of selectorPart.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) {
    if (classNames.has(match[1]!)) {
      return true;
    }
  }
  return false;
}

/** CSS に出てくる書体名 (小文字・引用符なし)。`font-family` と `font` の短縮形の両方を見る。 */
export function collectFontFamilies(css: string): Set<string> {
  const families = new Set<string>();
  for (const match of css.matchAll(/(font-family|font)\s*:\s*([^;}]+)/g)) {
    const parts = match[2]!.split(",");
    parts.forEach((part, index) => {
      let family = part.trim();
      // 短縮形の最初の項目には大きさや太さが前に並ぶので、引用符の外の最後の語句だけを書体名にする。
      if (match[1] === "font" && index === 0) {
        family = family.split(/\s+(?=(?:[^"']|["'][^"']*["'])*$)/).pop() ?? "";
      }
      const normalized = normalizeFamily(family);
      if (normalized) {
        families.add(normalized);
      }
    });
  }
  return families;
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const MATHML_NAMESPACE = "http://www.w3.org/1998/Math/MathML";

/**
 * 名前空間の無い `<svg>` / `<math>` の開始タグに名前空間を書き足す。紙面に直接入れたときに HTML の
 * パーサーが補うものと同じで、画像 (厳密な XML) でも入れ子の SVG・数式が描かれるようになる。
 * 書き出し済みの文字列では `<` は本文や属性の中で `&lt;` になっているので、タグだけに当たる。
 */
export function normalizeSvgMarkupForImage(svg: string): string {
  if (!/^\s*<svg\b/.test(svg)) {
    return svg;
  }
  return svg
    .replace(/<svg\b(?![^>]*\sxmlns\s*=)/g, `<svg xmlns="${SVG_NAMESPACE}"`)
    .replace(/<math\b(?![^>]*\sxmlns\s*=)/g, `<math xmlns="${MATHML_NAMESPACE}"`);
}

/**
 * SVG 文字列を、画像として読んでも紙面と同じに描ける形にする。名前空間を付け直し、使っている
 * クラスの CSS・それが使う書体・ルートのカスタムプロパティを埋め込む。クラスを一つも使わない
 * SVG (属性だけで描く図形) には CSS を足さない。
 */
export async function prepareSvgForImage(source: string): Promise<string> {
  const svg = normalizeSvgMarkupForImage(source);
  const classNames = collectSvgClassNames(svg);
  const openEnd = svg.indexOf(">", svg.indexOf("<svg"));
  if (classNames.size === 0 || openEnd < 0) {
    return svg;
  }
  const rules = collectDocumentCssText((rule) => cssRuleMentionsClass(rule.cssText, classNames));
  const bodyFont = getComputedStyle(document.body).fontFamily;
  const rootDeclarations = rootCustomPropertyDeclarations();
  // 書体は変数 (`--editor-body-font-family` など) 経由でも指定されるので、ルートの値も見る。
  const families = collectFontFamilies([
    rules,
    svg.replace(/&quot;/g, "\""),
    rootDeclarations.replace(/--[\w-]+\s*:/g, "font-family:"),
    `font-family:${bodyFont};`,
  ].join("\n"));
  const fonts = await collectEmbeddedFontCss(families);
  const css = [
    fonts,
    `:root{${rootDeclarations}font-family:${bodyFont};}`,
    rules,
  ].join("\n");
  const style = `<style><![CDATA[${css.replaceAll("]]>", "]]]]><![CDATA[>")}]]></style>`;
  return `${svg.slice(0, openEnd + 1)}${style}${svg.slice(openEnd + 1)}`;
}

function faceKey(face: { family: string; weight: string; style: string; unicodeRange: string }): string {
  return [
    unquote(face.family),
    normalizeWeight(face.weight),
    face.style.trim() || "normal",
    face.unicodeRange.replace(/\s+/g, "").toUpperCase(),
  ].join("|");
}

function normalizeFamily(family: string): string {
  return unquote(family).trim().toLowerCase();
}

function normalizeWeight(weight: string): string {
  const value = weight.trim();
  return value === "normal" ? "400" : value === "bold" ? "700" : value;
}

function unquote(value: string): string {
  return value.trim().replace(/^["']|["']$/g, "");
}

function firstFontUrl(src: string, base: string): string | null {
  const match = /url\(\s*(["']?)([^"')]+)\1\s*\)/.exec(src);
  if (!match) {
    return null;
  }
  try {
    return new URL(match[2], base).href;
  } catch {
    return null;
  }
}

export async function readAsDataUrl(source: string): Promise<string> {
  const response = await fetch(source);
  if (!response.ok) {
    throw new Error("resource");
  }
  return blobToDataUrl(await response.blob());
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("read"));
    reader.readAsDataURL(blob);
  });
}
