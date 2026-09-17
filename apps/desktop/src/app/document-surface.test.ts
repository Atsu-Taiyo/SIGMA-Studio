import path from "node:path";
import { readStylesheet as readFileSync } from "../../tests/helpers/read-stylesheet";

import { describe, expect, it } from "vitest";

import { boxFrameAppliesFontFamily, boxFrameStyleVars, createBoxBlock, resolveBoxFrame } from "@/lib/box-blocks";
import { KYOUTSUU_CHOICE_CLASS, SIGMA_MATHLIVE_MACRO_STYLES } from "@/lib/math-macros";

/**
 * `apps/desktop/src/app/document-surface.css` は「印刷プレビュー / PDF / 埋め込みビューアが
 * 共通で描く紙面の中身」の唯一の出典で、`globals.css` と `packages/viewer/src/styles.css` の
 * 両方が @import する。
 *
 * かつて viewer 側は 1005 行の手写しコピーを持っていて、同期を保証する仕組みがゼロだったため
 * 静かに腐った (`.print-image` / `.print-graph2d` が丸ごと欠落していた)。
 * ここのテストは「文書面のルールが globals.css へ逆流する」= 再びコピーが生まれる入口を塞ぐ。
 */

const appDir = import.meta.dirname;
const globalsCss = readFileSync(path.join(appDir, "globals.css"), "utf8");
const documentSurfaceCss = readFileSync(path.join(appDir, "document-surface.css"), "utf8");
const documentSurfaceCode = stripComments(documentSurfaceCss);

/**
 * globals.css に残ってよい「文書面クラスだけで構成されたルール」。理由なしの例外は作らない。
 */
const GLOBALS_EXCEPTIONS: Record<string, string> = {
  ".print-a4-page":
    "@media print 内の実紙面向け上書き。共有ファイルに @media print を置くとエディタクロームの display:none までビューアに降る",
  ".print-a4-page:last-child": "同上",
  ".text-formatting-mark": "編集記号の非表示は実印刷だけの上書き。共有CSSへ @media print を移さない",
  ".sigma-doc-box-title:empty": "空タイトルのプレースホルダはエディタ専用の入力アフォーダンス",
  ".sigma-doc-box-title:empty::before": "同上 (『タイトル』プレースホルダ)",
  ".sigma-doc-box-title:empty:focus::before": "同上",
  ".box-frame--title-band .sigma-doc-box-title:empty": "同上",
  ".box-frame--notebook-rules .sigma-doc-box-title:empty": "同上",
  ".text-flow-shell":
    "共有ファイルは殻のジオメトリだけを持つ。`cursor: text` は編集アフォーダンスなので"
    + "読み取り専用の埋め込みビューアへ降らせない",
  ".text-flow-editor ::selection":
    "選択ハイライトは編集面だけの装飾",
  ".text-flow-editor:not(:focus-within) ::selection":
    "フォーカスの無い本文のネイティブ選択は描かない。保持選択の Highlight が代わりに描く",
  ".text-flow-editor[data-text-run-span] ::selection":
    "チャンク跨ぎ選択中はネイティブ選択を消し、CSS Custom Highlight だけを見せる",
  ".text-flow-editor[data-box-fragment-span] ::selection":
    "断片跨ぎ選択中もネイティブ選択を消し、CSS Custom Highlight だけを見せる",
  ".text-flow-editor :where(h1, h2, h3, p)":
    "ブロック背景の角丸は編集面の装飾。ジオメトリ (margin) は共有ファイルが持つ",
  ".ProseMirror":
    "エディタ本体の基底クラス。共有ファイルは `.overlay-text-shape .ProseMirror` を持つので"
    + "所有クラス扱いになるが、単独の `.ProseMirror` は文書面ではなく編集面のもの",
  ".print-a4-page .page-running-region":
    "エディタ側 .a4-page-sheet と同一ルールの双子指定。viewer は自前の既定色を持つ (styles-sync.test.ts の INTENTIONAL_OVERRIDES)",
};

/**
 * 文書面クラスと同じ命名接頭辞を持つが、文書面ではないもの (エディタ / 印刷プレビュー画面の
 * クローム)。この接頭辞のクラスを新設するときは「共有ファイルに置く」か「ここに登録する」かを
 * 必ず選ばせる — 放置すると viewer への追従漏れが再発する。
 */
const DOCUMENT_SURFACE_PREFIXES = [
  "print-",
  "box-frame--",
  "sigma-doc-box-",
  "page-running-",
  "graph2d-",
  "boxed-",
  "math-preview",
  "inline-math-node",
  "rich-inline-content",
  "sigma-underline-run",
  "text-flow-",
] as const;

const EDITOR_CHROME_CLASSES = new Set([
  // Fragment editor wrapper: viewer renders settled blocks without this editing shell.
  "text-flow-fragment-content",
  "boxed-text-icon",
  "boxed-text-menu",
  "boxed-text-menu-button",
  "boxed-text-menu-trigger",
  "boxed-text-padding-label",
  "boxed-text-padding-stepper",
  "boxed-text-style-option",
  "boxed-text-style-options",
  "boxed-text-style-preview",
  "boxed-text-style-preview-double",
  "boxed-text-style-preview-oval",
  "boxed-text-style-preview-thick",
  "boxed-text-toggle-button",
  "boxed-text-toolbar-control",
  "graph2d-block",
  "graph2d-container",
  "graph2d-preview-button",
  "page-running-direct-editor",
  "page-running-direct-flow",
  "page-running-direct-overlay",
  "page-running-edge",
  "page-running-editor-band",
  "page-running-editor-label",
  "print-paper-shimmer",
  "print-paper-shimmer--vertical",
  "print-paper-shimmer-sheet",
  "print-load-error",
  "print-load-pending",
  "print-page",
  "print-page-nav-stack",
  "print-page-stack",
  "print-page-thumbnail-stack",
  "print-page-toolbar",
  "print-preview-toolbar",
  "print-preview-toolbar-actions",
  "print-preview-toolbar-heading",
  "print-preview-toolbar-meta",
  "print-preview-toolbar-meta-shimmer",
  "print-preview-page-nav-button",
  "print-preview-page-nav-item",
  "print-preview-page-nav-label",
  "print-preview-page-nav-paper-selection",
  "print-preview-page-nav-scaler",
  "print-preview-page-nav-viewport",
  "print-preview-page-navigator",
  "print-preview-thumbnail",
  "print-sheet",
  "print-status-toast",
  "print-status-toast-close",
  "print-status-toast-message",
  "print-status-toast-retry",
  "sigma-doc-box-action-button",
  "sigma-doc-box-content",
  // `.text-flow-editor` itself is shared (the body typography the viewer needs); everything else in
  // the family is editing chrome — selection, comments, AI diff/lock states, column and box
  // fragment plumbing.
  "text-flow-ai-lock-notice",
  "text-flow-box-fragment-source",
  "text-flow-change-added",
  "text-flow-change-before",
  "text-flow-change-removing",
  "text-flow-column-block",
  "text-flow-commented-line",
  "text-flow-edit-guard-notice",
  "text-flow-held-selection",
  "text-flow-held-selection-layer",
  "text-flow-selected-line",
  "text-flow-side-selection-gutter",
]);

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

type CssRule = { selectors: string[] };

/**
 * globals.css / document-surface.css を読むためだけの最小 CSS スキャナ。
 * この 2 ファイルは CSS ネスト (`&`) を使わないフラットな記述なので、コメント除去 + 波括弧の
 * 深さ追跡だけで「ルールのセレクタ一覧」を正確に取り出せる。postcss を apps/desktop の
 * 依存に足さずに済ませるための割り切り。
 */
function scanRules(css: string): CssRule[] {
  const withoutComments = stripComments(css);
  const rules: CssRule[] = [];
  let depth = 0;
  let buffer = "";
  for (const char of withoutComments) {
    if (char === "{") {
      if (depth === 0) {
        const prelude = buffer.trim();
        if (prelude && !prelude.startsWith("@")) {
          rules.push({ selectors: splitSelectors(prelude) });
        }
        buffer = "";
      } else if (depth === 1) {
        // at-rule (@media 等) の中身。中の宣言ブロックだけを拾う。
        const prelude = buffer.trim();
        if (prelude && !prelude.startsWith("@")) {
          rules.push({ selectors: splitSelectors(prelude) });
        }
        buffer = "";
      }
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth = Math.max(0, depth - 1);
      buffer = "";
      continue;
    }
    if (depth === 0 || depth === 1) {
      buffer += char;
    }
  }
  return rules;
}

/** Splits a selector list on top-level commas only, so `:where(h1, h2)` stays one selector. */
function splitSelectors(prelude: string): string[] {
  const selectors: string[] = [];
  let depth = 0;
  let buffer = "";
  for (const character of prelude) {
    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
    }
    if (character === "," && depth === 0) {
      selectors.push(buffer);
      buffer = "";
      continue;
    }
    buffer += character;
  }
  selectors.push(buffer);
  return selectors.map((selector) => selector.trim().replace(/\s+/g, " ")).filter(Boolean);
}

/** Declarations of the first rule whose selector list contains `selector`. */
function ruleDeclarations(css: string, selector: string): Record<string, string> {
  const withoutComments = stripComments(css);
  let index = 0;
  while (index < withoutComments.length) {
    const open = withoutComments.indexOf("{", index);
    if (open < 0) {
      break;
    }
    const close = withoutComments.indexOf("}", open);
    const prelude = withoutComments.slice(index, open).trim();
    if (!prelude.startsWith("@") && splitSelectors(prelude).includes(selector)) {
      return Object.fromEntries(
        withoutComments
          .slice(open + 1, close)
          .split(";")
          .map((declaration) => declaration.split(":"))
          .filter((parts) => parts.length >= 2)
          .map(([property, ...value]) => [property.trim(), value.join(":").trim()]),
      );
    }
    index = close + 1;
  }
  throw new Error(`no rule for "${selector}"`);
}

function classesOf(selector: string): string[] {
  return [...selector.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((match) => match[1]);
}

const documentSurfaceRules = scanRules(documentSurfaceCss);
const globalsRules = scanRules(globalsCss);

/** 共有ファイルが所有するクラス名 (修飾子込み)。 */
const ownedClasses = new Set(
  documentSurfaceRules.flatMap((rule) => rule.selectors.flatMap(classesOf)),
);

/**
 * 「文書面そのものを定義しているセレクタ」= 共有ファイルの所有クラスだけでできているセレクタ。
 * 判定はルール単位ではなくセレクタ単位で行う — エディタ側のクラスと 1 つのルールに束ねれば
 * 検査をすり抜けられる、という抜け道を作らないため。束ねたい場合は GLOBALS_EXCEPTIONS に
 * 理由付きで登録する。
 */
function definesDocumentSurface(selector: string): boolean {
  const classes = classesOf(selector);
  return classes.length > 0 && classes.every((className) => ownedClasses.has(className));
}

describe("document-surface.css is the single source for the printable document surface", () => {
  it("is imported by globals.css", () => {
    expect(globalsCss).toContain('@import "./document-surface.css";');
  });

  it("owns something (the scanner really parsed the shared file)", () => {
    expect(documentSurfaceRules.length).toBeGreaterThan(100);
    expect(ownedClasses.has("print-paragraph")).toBe(true);
    expect(ownedClasses.has("box-frame--corner")).toBe(true);
  });

  it("keeps globals.css from redefining rules the shared file owns", () => {
    const leaked = [
      ...new Set(
        globalsRules
          .flatMap((rule) => rule.selectors)
          .filter(
            (selector) =>
              definesDocumentSurface(selector) && !(selector in GLOBALS_EXCEPTIONS),
          ),
      ),
    ].sort();
    expect(leaked).toEqual([]);
  });

  it("keeps the globals.css exception list free of stale entries", () => {
    const globalsSelectors = new Set(globalsRules.flatMap((rule) => rule.selectors));
    const stale = Object.keys(GLOBALS_EXCEPTIONS)
      .filter((selector) => !globalsSelectors.has(selector))
      .sort();
    expect(stale).toEqual([]);
  });

  it("forces every new document-surface-prefixed class to pick a home", () => {
    // 文書面なら document-surface.css、エディタ / 印刷プレビュー画面のクロームなら
    // EDITOR_CHROME_CLASSES へ。どちらでもない新設クラスはここで落ちる。
    const undecided = [
      ...new Set(
        globalsRules
          .flatMap((rule) => rule.selectors)
          .flatMap(classesOf)
          .filter(
            (className) =>
              DOCUMENT_SURFACE_PREFIXES.some((prefix) => className.startsWith(prefix)) &&
              !ownedClasses.has(className) &&
              !EDITOR_CHROME_CLASSES.has(className),
          ),
      ),
    ].sort();
    expect(undecided).toEqual([]);
  });

  it("keeps the editor-chrome allow list free of stale entries", () => {
    const globalsClasses = new Set(
      globalsRules.flatMap((rule) => rule.selectors).flatMap(classesOf),
    );
    const stale = [...EDITOR_CHROME_CLASSES]
      .filter((className) => !globalsClasses.has(className))
      .sort();
    expect(stale).toEqual([]);
  });
});

describe("the running region keeps the list geometry it had under .print-list", () => {
  // The header/footer body moved to the block renderer the document body uses, which emits plain
  // `<ul>/<ol>`. Without this rule the list margin fell back to the UA default (2px → 16px) on the
  // page canvas, in the PDF and in the viewer. It is region-scoped on purpose: the body editor
  // deliberately keeps the UA defaults, so `.text-flow-editor ul` would move every list.
  it("mirrors .print-list's block geometry", () => {
    const printList = ruleDeclarations(documentSurfaceCss, ".print-list");
    const runningList = ruleDeclarations(documentSurfaceCss, ".page-running-region :is(ul, ol)");

    expect(runningList).toEqual(printList);
  });

  it("mirrors the nested-list reset", () => {
    expect(ruleDeclarations(documentSurfaceCss, ".page-running-region :is(ul, ol) :is(ul, ol)"))
      .toEqual(ruleDeclarations(documentSurfaceCss, ".print-list .print-list"));
  });
});

describe("document-surface.css stays embeddable", () => {
  // packages/viewer/scripts/build.mjs が全セレクタを `.sigma-viewer` 配下へ書き換えるため、
  // 以下は埋め込み先を壊す。viewer 側 (styles-sync.test.ts) と両側から縛る。
  it("declares no :root / html / body rule", () => {
    const hostSelectors = documentSurfaceRules
      .flatMap((rule) => rule.selectors)
      .filter((selector) => /^(?::root|html|body)(?=$|[\s>+~.#:[])/i.test(selector));
    expect(hostSelectors).toEqual([]);
  });

  it("declares no @page rule and no @media print block", () => {
    expect(documentSurfaceCode).not.toMatch(/@page\b/);
    expect(documentSurfaceCode).not.toMatch(/@media[^{]*\bprint\b/);
  });

  it("declares no @import (the shared file must stay a leaf)", () => {
    expect(documentSurfaceCode).not.toMatch(/@import\b/);
  });
});


/**
 * cornerbox の font-family 打ち消し。
 *
 * `.box-frame--corner` は本文とタイトルに `font-family: inherit` を宣言する。詳細度 0-2-0 で、
 * `.sigma-doc-box-body { font-family: var(--sigma-doc-box-body-font-family, inherit) }` (0-1-0) に
 * 勝つ。つまり cornerbox は `frame` に明朝を保存していても**その書体では描かれない**。
 *
 * ツールバーの「この位置の書体」表示 (`resolveEffectiveFontFamily`) はこの事実に依存しており、
 * `lib/box-blocks.ts` の `boxFrameAppliesFontFamily` がそれを一箇所で表明している。
 * **ここの CSS を変えるなら、あの関数も同時に見直すこと** — 片方だけ動かすとこのブロックか
 * `box-blocks.test.ts` の `boxFrameAppliesFontFamily` テストのどちらかが赤くなる。
 */
describe("cornerbox の font-family 打ち消しと boxFrameAppliesFontFamily は対で決まる", () => {
  const NEUTRALIZED_SELECTORS = [
    ".box-frame--corner .sigma-doc-box-body",
    ".box-frame--corner .sigma-doc-box-title",
    ".box-frame--corner .print-box-body",
    ".box-frame--corner .print-box-title",
  ];

  /** Every top-level rule, with its selectors and its declarations. */
  const parsedRules = [...stripComments(documentSurfaceCss).matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((match) => ({
      selectors: splitSelectors(match[1]),
      declarations: Object.fromEntries(
        match[2]
          .split(";")
          .map((declaration) => declaration.split(":"))
          .filter((parts) => parts.length >= 2)
          .map(([property, ...value]) => [property.trim(), value.join(":").trim()]),
      ) as Record<string, string>,
    }))
    .filter((rule) => !rule.selectors.some((selector) => selector.startsWith("@")));

  const fontFamilyFor = (selector: string): string | undefined => parsedRules
    .filter((rule) => rule.selectors.includes(selector))
    .map((rule) => rule.declarations["font-family"])
    .filter((value): value is string => value !== undefined)
    .at(-1);

  it("neutralizes font-family on the corner frame's title and body", () => {
    for (const selector of NEUTRALIZED_SELECTORS) {
      expect(fontFamilyFor(selector), selector).toBe("inherit");
    }
  });

  it("lets the frame's own custom property through on every other frame", () => {
    // 打ち消しが cornerbox 限定であること。ここが崩れると `boxFrameAppliesFontFamily` の
    // 「cornerbox だけ false」という前提も崩れる。
    expect(fontFamilyFor(".sigma-doc-box-body")).toBe("var(--sigma-doc-box-body-font-family, inherit)");
    expect(fontFamilyFor(".sigma-doc-box-title")).toBe("var(--sigma-doc-box-title-font-family, inherit)");
  });

  it("neutralizes font-family for no frame class other than the corner one", () => {
    const neutralizingFrameClasses = new Set(
      parsedRules
        .filter((rule) => rule.declarations["font-family"] === "inherit")
        .flatMap((rule) => rule.selectors)
        .flatMap((selector) => selector.match(/\.box-frame--[\w-]+/g) ?? [])
        .map((className) => className.slice(1)),
    );

    expect([...neutralizingFrameClasses].sort()).toEqual(["box-frame--corner"]);
  });

  it("agrees with the predicate the toolbar reads", () => {
    const cornerbox = resolveBoxFrame(createBoxBlock("cornerbox"));
    expect(boxFrameAppliesFontFamily("cornerbox", cornerbox)).toBe(false);
    expect(boxFrameAppliesFontFamily("fancybox", resolveBoxFrame(createBoxBlock("fancybox")))).toBe(true);
  });
});

/**
 * 「枠の矩形を落とすと、枠が消えるのではなくセグメントの border に戻る」という主張の根拠。
 *
 * `boxed-text-run-height.ts` の `reconcileBoxedRunHeightState` は、計測したときの文書形状が
 * 変わったコンテナの `frames` を捨てる。捨ててよいと言い切れるのは、`.boxed-run-framed` が
 * 外れた瞬間に下の打ち消しも外れて `.boxed-text` が自分の border を描き直すからで、その
 * 打ち消しはこの 2 つのルールでしか成立していない。**片方でも消えたら「落としても枠は残る」
 * という前提が崩れるので、ここで両方の存在を固定する** (learnings: コードが CSS に対して
 * 持つ主張は、対でテストを置く)。
 */
/**
 * タイトルに地色を敷く 2 つの装飾が、コード側の主張と対で成り立っていることの固定。
 *
 * - 帯の下の罫は `boxFrameStyleVars` が出す `--sigma-doc-box-title-band-rule-width` で引く。
 *   既定は 0 なので、罫を持たない既存の帯箱 (tcolorbox) は線を得ない。
 * - タブは**枠の内側**に収める。ブロックを絶対配置で積む印刷経路 (`PrintPreview`) は
 *   border box しか勘定しないので、上へはみ出した分は前のブロックに重なる。タブの高さを
 *   負の `margin-top` に入れた瞬間にそれが起きるため、`margin-top` は
 *   「パディング + 枠線」だけを打ち消すことをここで固定する。
 */
describe("タイトルの地色", () => {
  it("draws the band rule from the band-rule custom properties", () => {
    const band = ruleDeclarations(
      documentSurfaceCss,
      ".box-frame--title-band .sigma-doc-box-title",
    );
    expect(band["border-bottom"]).toContain("--sigma-doc-box-title-band-rule-width");
    expect(band["border-bottom"]).toContain("--sigma-doc-box-title-band-rule-color");
    expect(boxFrameStyleVars(resolveBoxFrame(createBoxBlock("tcolorbox")))["--sigma-doc-box-title-band-rule-width"]).toBe("0px");
    expect(boxFrameStyleVars(resolveBoxFrame(createBoxBlock("titlebox")))["--sigma-doc-box-title-band-rule-width"]).toBe("1.2px");
  });

  it("keeps the title tab inside the frame", () => {
    const tab = ruleDeclarations(
      documentSurfaceCss,
      ".box-frame--title-tab .sigma-doc-box-title",
    );
    expect(tab.margin).toContain("--sigma-doc-box-padding-top");
    expect(tab.margin).toContain("--sigma-doc-box-border-width");
    // タブの高さは占める場所 (min-height) にだけ効き、負のマージンには入らない。
    expect(tab["min-height"]).toContain("--sigma-doc-box-title-tab-height");
    expect(tab.margin).not.toContain("--sigma-doc-box-title-tab-height");
    // 箱そのものへ余白を足すルールも持たない (足すと「はみ出しを外で確保する」形に戻る)。
    expect(documentSurfaceCode).not.toMatch(/(^|[};])\s*\.box-frame--title-tab\s*\{/);
  });
});

describe("枠レイヤを落とすとセグメントの border に戻る", () => {
  it("draws the run frame from the boxed-text border custom properties", () => {
    const frame = ruleDeclarations(documentSurfaceCss, ".boxed-run-frame");
    expect(frame.border).toContain("--boxed-text-border-width");
    expect(frame.border).toContain("--boxed-text-border-style");
    expect(frame.border).toContain("--boxed-text-border-color");
  });

  it("only neutralizes the segment border while the container is framed", () => {
    const framed = ruleDeclarations(
      documentSurfaceCss,
      '.boxed-run-framed .boxed-text[data-boxed-run-height-target="true"]',
    );
    expect(framed["border-color"]).toBe("transparent");
    expect(framed.outline).toBe("0");

    const segment = ruleDeclarations(
      documentSurfaceCss,
      '.boxed-text[data-boxed-run-height-target="true"]',
    );
    expect(segment.border).toContain("--boxed-text-border-color");
  });

  it("draws each double-box rule at the same width as the ordinary frame", () => {
    const double = ruleDeclarations(
      documentSurfaceCss,
      '[data-sigma-doc-boxed-variant="double"]',
    );

    expect(double["--boxed-text-border-width"]).toBe("1px");
    expect(double["--boxed-text-border-style"]).toBe("solid");
    expect(double.outline).toContain("1px solid");
    expect(double["outline-offset"]).toBe("-3px");
  });

  it("keeps the doubleboxed math-rule gap equal to the ordinary rule width", () => {
    const doubleboxed = ruleDeclarations(
      documentSurfaceCss,
      ".sigma-doubleboxed .fbox",
    );

    expect(doubleboxed["border-width"]).toBe("1px !important");
    expect(doubleboxed.outline).toBe("1px solid currentColor");
    expect(doubleboxed["outline-offset"]).toBe("-3px");
  });

  it("keeps thick and outer-thick math boxes visually distinct", () => {
    const thick = ruleDeclarations(
      documentSurfaceCss,
      ".sigma-thickboxed .fbox",
    );
    const outerThick = ruleDeclarations(
      documentSurfaceCss,
      ".sigma-outerthick-doubleboxed .fbox",
    );

    expect(thick["border-width"]).toBe("2px !important");
    expect(thick.outline).toBeUndefined();
    expect(outerThick["border-width"]).toBe("2px !important");
    expect(outerThick.outline).toBe("1px solid currentColor");
    expect(outerThick["outline-offset"]).toBe("-4px");
  });

  it("keeps the Common Test choice oval identical in static and editable math", () => {
    const selector = `.${KYOUTSUU_CHOICE_CLASS}`;
    const staticChoice = ruleDeclarations(documentSurfaceCss, selector);
    const editableChoice = ruleDeclarations(SIGMA_MATHLIVE_MACRO_STYLES, selector);
    const staticText = ruleDeclarations(
      documentSurfaceCss,
      `${selector} > .ML__text`,
    );
    const editableText = ruleDeclarations(
      SIGMA_MATHLIVE_MACRO_STYLES,
      `${selector} > .ML__text`,
    );

    expect(staticChoice).toEqual(editableChoice);
    expect(staticText).toEqual(editableText);
    expect(staticChoice["block-size"]).toBe("1.3em");
    expect(staticChoice["inline-size"]).toBe("0.96em");
    expect(staticChoice.border).toBe("0.095em solid currentColor");
    expect(staticChoice["border-radius"]).toBe("50%");
    expect(staticChoice["font-variant-numeric"]).toBe("tabular-nums");
    expect(staticChoice["vertical-align"]).toBe("-0.12em");
    expect(staticText["font-size"]).toBe("1.1em");
  });
});
