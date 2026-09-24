import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import postcss, { type Root, type Rule } from "postcss";
import { describe, expect, it } from "vitest";

/**
 * The viewer used to carry a hand-written copy of every document-surface rule in
 * `apps/desktop/src/app/globals.css`. Nothing kept the two in sync, so the copy rotted
 * (`.print-image` / `.print-graph2d` were missing entirely and 59 of 171 selectors had drifted).
 *
 * The copy is gone: both hosts now `@import` `apps/desktop/src/app/document-surface.css`.
 * These tests keep it that way.
 */

const SHARED_IMPORT_SPECIFIER = "../../../apps/desktop/src/app/document-surface.css";

const sourceRoot = import.meta.dirname;
const viewerCssPath = path.join(sourceRoot, "styles.css");
const sharedCssPath = path.resolve(sourceRoot, SHARED_IMPORT_SPECIFIER);
const distCssPath = path.resolve(sourceRoot, "../dist/styles.css");

const viewerCss = readFileSync(viewerCssPath, "utf8");
const sharedCss = readFileSync(sharedCssPath, "utf8");

/**
 * Selectors the viewer deliberately re-declares after the shared import. Every entry needs a
 * reason: an unexplained duplicate is exactly the drift this file exists to prevent. The
 * `unregistered`/`stale` assertions below keep this list honest in both directions.
 */
const INTENTIONAL_OVERRIDES: Record<string, string> = {
  ".print-a4-page":
    "埋め込みビューアは紙面に影を落とし、背景/文字色を公開変数 --sigma-viewer-paper / --sigma-viewer-ink から取る",
  ".print-page-overlay-layer":
    "読み取り専用ビューアでは図形レイヤの操作を完全に殺す (pointer-events / user-select)",
  ".page-running-overlay-preview": "同上 (ヘッダー/フッターの図形プレビュー)",
  ".print-page-overlay-layer svg": "同上",
  ".page-running-region": "ビューアにはエディタ側の文字色コンテキストが無いので既定色を与える",
  ".print-list":
    "ビューア独自のぶら下げ幅。既知の viewer↔PDF パリティ差 (デスクトップ側は UA 既定の 40px) で、"
    + "揃えるかどうかは別途判断する。ここで外すと viewer のリストが 13.6px ずれる",
  ".page-running-region :is(ul, ol)":
    "同上。ヘッダー/フッターの本文が本文レンダラに統合され `.print-list` が付かなくなったので、"
    + "同じぶら下げ幅を region スコープでも与える (viewer 内で本文とヘッダーが食い違わないように)",
};

function parse(css: string): Root {
  return postcss.parse(css);
}

function isInsideKeyframes(rule: Rule): boolean {
  let parent: Rule["parent"] = rule.parent;
  while (parent) {
    if (parent.type === "atrule" && /keyframes$/i.test(parent.name)) {
      return true;
    }
    parent = "parent" in parent ? (parent.parent as Rule["parent"]) : undefined;
  }
  return false;
}

function normalize(selector: string): string {
  return selector.trim().replace(/\s+/g, " ");
}

/** `packages/viewer/scripts/build.mjs` prefixes every selector with `.sigma-viewer `. */
function unscope(selector: string): string {
  return normalize(selector).replace(/^\.sigma-viewer\s+/, "");
}

function selectorsOf(css: string, options: { unscope: boolean }): string[] {
  const found: string[] = [];
  parse(css).walkRules((rule) => {
    if (isInsideKeyframes(rule)) {
      return;
    }
    for (const selector of rule.selectors) {
      found.push(options.unscope ? unscope(selector) : normalize(selector));
    }
  });
  return found;
}

const sharedSelectors = new Set(selectorsOf(sharedCss, { unscope: false }));
const viewerSelectors = selectorsOf(viewerCss, { unscope: true });

describe("viewer styles are derived from the shared document surface", () => {
  it("imports apps/desktop/src/app/document-surface.css", () => {
    expect(viewerCss).toContain(`@import "${SHARED_IMPORT_SPECIFIER}";`);
  });

  it("does not silently redefine a selector the shared file already owns", () => {
    const unregistered = [
      ...new Set(
        viewerSelectors.filter(
          (selector) =>
            sharedSelectors.has(selector) && !(selector in INTENTIONAL_OVERRIDES),
        ),
      ),
    ].sort();
    expect(unregistered).toEqual([]);
  });

  it("keeps the intentional-override list free of stale entries", () => {
    const viewerSelectorSet = new Set(viewerSelectors);
    const stale = Object.keys(INTENTIONAL_OVERRIDES)
      .filter(
        (selector) => !sharedSelectors.has(selector) || !viewerSelectorSet.has(selector),
      )
      .sort();
    expect(stale).toEqual([]);
  });
});

describe("the shared document surface stays compatible with the viewer build", () => {
  // `packages/viewer/scripts/build.mjs` rewrites every selector to live under `.sigma-viewer`.
  // Each construct below survives that rewrite in a way that breaks the embedding host.
  it("declares no CSS variables on :root (the viewer supplies its own)", () => {
    const rootSelectors = selectorsOf(sharedCss, { unscope: false }).filter((selector) =>
      /^(?::root|html|body)(?=$|[\s>+~.#:[])/i.test(selector),
    );
    expect(rootSelectors).toEqual([]);
  });

  it("uses no leading `*` selector (build.mjs turns it into `.sigma-viewer *`)", () => {
    // `.foo > *` is fine — it keeps its ancestor. A selector that *starts* with `*` would be
    // rewritten to `.sigma-viewer *`, which no longer matches `.sigma-viewer` itself.
    const universal = selectorsOf(sharedCss, { unscope: false }).filter((selector) =>
      /^\*(?=$|[\s>+~.#:[])/.test(selector),
    );
    expect(universal).toEqual([]);
  });

  it("contains no @media print / @page / @import", () => {
    const atRules: string[] = [];
    parse(sharedCss).walkAtRules((atRule) => {
      if (/^(?:page|import)$/i.test(atRule.name)) {
        atRules.push(`@${atRule.name} ${atRule.params}`.trim());
      }
      if (/^media$/i.test(atRule.name) && /\bprint\b/.test(atRule.params)) {
        atRules.push(`@media ${atRule.params}`);
      }
    });
    expect(atRules).toEqual([]);
  });

  it("scopes every rule under .sigma-viewer once bundled", () => {
    // Mirrors the guard in build.mjs: a selector that cannot be scoped would leak out of the
    // embedded viewer. Attribute-only selectors are fine — they get the descendant prefix.
    const unscopable = selectorsOf(sharedCss, { unscope: false }).filter((selector) =>
      /^:(?:root|host)/i.test(selector),
    );
    expect(unscopable).toEqual([]);
  });
});

describe("viewer stylesheet size", () => {
  // Guard against the tempting regression of `@import`-ing all of globals.css (~380KB / 18k lines)
  // instead of the document surface: the embedded viewer bundle would grow ~10x.
  // 0.469.2 (2969786): authored CSS is 72,849 bytes. Since 2a6fa62 the shared
  // surface gained 4,904 bytes for nested box scoping, rounded split frames,
  // corner fill geometry and choice-marker parity. These are document styles,
  // not desktop chrome. Keep only 879 bytes of headroom; dist stays at 128 KiB.
  // globals.css (約 380KB) を丸ごと import すると手書き分が一気に 8 倍以上になるので手前で止める。
  const MAX_AUTHORED_CSS_BYTES = 72 * 1024;
  const MAX_DIST_CSS_BYTES = 128 * 1024;

  it("keeps the authored CSS (viewer + shared document surface) small", () => {
    const authoredBytes = Buffer.byteLength(viewerCss) + Buffer.byteLength(sharedCss);
    expect(authoredBytes).toBeLessThan(MAX_AUTHORED_CSS_BYTES);
  });

  it("never imports globals.css wholesale", () => {
    // dist の実測ガードは dist が無い checkout では回らないので、肥大化の入口そのものを塞ぐ。
    const imports = [...viewerCss.matchAll(/@import\s+"([^"]+)"/g)].map((match) => match[1]);
    expect(imports).toEqual([
      "katex/dist/katex.min.css",
      "mathlive/static.css",
      SHARED_IMPORT_SPECIFIER,
    ]);
  });

  it("keeps the built dist/styles.css small when it has been built", () => {
    let distBytes: number | null = null;
    try {
      distBytes = statSync(distCssPath).size;
    } catch {
      distBytes = null;
    }
    if (distBytes === null) {
      // `npm run viewer:build` has not run in this checkout; the authored-size guard above still
      // applies. Nothing to assert here.
      return;
    }
    expect(distBytes).toBeLessThan(MAX_DIST_CSS_BYTES);
  });
});
