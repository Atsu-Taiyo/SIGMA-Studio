import path from "node:path";
import { readStylesheet as readFileSync } from "../../../../tests/helpers/read-stylesheet";

import { describe, expect, it } from "vitest";

import { TRUSTED_SIGMA_MATH_CLASSES } from "@/lib/math-macros";

import { sanitizeMathMarkup } from "./math-markup";

/**
 * 数式サニタイザの class 許可集合と、アプリのグローバル CSS の衝突を禁じる。
 *
 * `sanitizeMathMarkup` はクラスを**トークン単位の許可制**にしているが、許可されたトークンは
 * 教材の TeX が `\htmlClass{...}` や `\text{<span class=...>}` で**名指しできる**ということでもある。
 * 許可トークンには `overlay` `text` `base` `inner` `fix` `root` `rule` `strut` `smash` `hline`
 * `newline` のような、アプリ側でも普通に使いたくなる素の単語が多数含まれる。
 * もし `globals.css` に `.overlay { position: fixed; inset: 0; z-index: 9999 }` のような
 * **素のグローバル規則**が足されたら、インライン `style` を 1 文字も使わずに画面を覆う偽 UI が
 * 作れてしまう (`.startup-splash` を借りる経路を許可制で塞いだのと同じ穴が、今度は
 * 「許可済みトークン」の側から開く)。
 *
 * したがって不変条件は「教材が名指しできるトークンを含む規則は、数式コンテナ
 * (`.ML__*` / `.katex*` / `.math-preview*`) の中でしか効かないこと」。現時点では衝突 0 件で、
 * このテストは緑のまま入る — 将来その規則が足された瞬間に赤くするのが目的。
 */

const appDir = path.resolve(import.meta.dirname, "../../../app");
const STYLESHEETS = ["globals.css", "document-surface.css", "palette.css"] as const;

/** 数式レンダラが描く木のルート。この中でだけ効く規則なら教材から借りても他へ影響しない。 */
const MATH_CONTAINER_CLASS = /^(?:ML__|katex|math-preview)/;

/**
 * 数式コンテナのトークンか。`\thickboxed` 等の Sigma 自前マクロが出すクラスも数える —
 * これらは `trustSigmaKatexMacro` が信頼する固定集合で、数式 markup の中にしか現れないため、
 * 「そのクラスを名乗れる要素は数式の中にしか作れない」という同じ保証が成り立つ。
 */
function isMathContainerToken(token: string): boolean {
  return MATH_CONTAINER_CLASS.test(token) || TRUSTED_SIGMA_MATH_CLASSES.has(token);
}

/** 画面上の位置と重なり順を動かせる宣言。数式コンテナの規則が持ってはいけない。 */
const POSITIONING_PROPERTY = new Set([
  "position", "inset", "inset-block", "inset-inline", "top", "left", "right", "bottom", "z-index",
]);

interface CssRule {
  declarations: Record<string, string>;
  selector: string;
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * この 3 ファイルは CSS ネスト (`&`) を使わないフラットな記述なので、コメント除去と波括弧の
 * 対応付けだけでルールを正確に取り出せる (`document-surface.test.ts` と同じ割り切り)。
 * prelude をスタックで持つのが要点で、深さフラグ 1 本で書くと `@media` の**中の**ルールが
 * すべて `@media …` から始まるものとして捨てられ、門番が静かに空振りする。
 */
function scanRules(css: string): CssRule[] {
  const source = stripComments(css);
  const rules: CssRule[] = [];
  const preludes: string[] = [];
  let buffer = "";
  for (const char of source) {
    if (char === "{") {
      preludes.push(buffer.trim());
      buffer = "";
      continue;
    }
    if (char === "}") {
      const prelude = preludes.pop() ?? "";
      if (prelude && !prelude.startsWith("@")) {
        for (const selector of splitSelectors(prelude)) {
          rules.push({ declarations: parseDeclarations(buffer), selector });
        }
      }
      buffer = "";
      continue;
    }
    buffer += char;
  }
  return rules;
}

/** トップレベルのカンマだけで分割する (`:where(h1, h2)` を 1 本のまま保つ)。 */
function splitSelectors(selectorList: string): string[] {
  const selectors: string[] = [];
  let depth = 0;
  let buffer = "";
  for (const char of selectorList) {
    if (char === "(" || char === "[") {
      depth += 1;
    } else if (char === ")" || char === "]") {
      depth = Math.max(0, depth - 1);
    }
    if (char === "," && depth === 0) {
      selectors.push(buffer.trim());
      buffer = "";
      continue;
    }
    buffer += char;
  }
  if (buffer.trim()) {
    selectors.push(buffer.trim());
  }
  return selectors;
}

function parseDeclarations(body: string): Record<string, string> {
  const declarations: Record<string, string> = {};
  for (const declaration of body.split(";")) {
    const separator = declaration.indexOf(":");
    if (separator > 0) {
      declarations[declaration.slice(0, separator).trim().toLowerCase()] =
        declaration.slice(separator + 1).trim();
    }
  }
  return declarations;
}

function classTokensOf(selector: string): string[] {
  return [...selector.matchAll(/\.(-?[A-Za-z_][A-Za-z0-9_-]*)/g)].map((match) => match[1]);
}

/**
 * セレクタを「祖先の連なり」に落とす。**兄弟結合子 (`+` `~`) は祖先関係を切る** —
 * `.katex + .overlay` の `.overlay` は `.katex` の兄弟であって子孫ではないので、
 * `.katex` を祖先として数えると数式コンテナの外の規則を「scoped」と誤判定する。
 * 兄弟で切ったあとの各区間について、区間内の先行複合セレクタだけを祖先とみなす (安全側)。
 */
function ancestorChains(selector: string): string[][] {
  return selector.split(/\s*[+~]\s*/).map((segment) => segment
    .replace(/\s*>\s*/g, " ")
    .split(/\s+/)
    .filter(Boolean));
}

/** そのトークンが教材の TeX から名指しできるか (= サニタイザが class 属性に残すか)。 */
function isMathReachableToken(token: string): boolean {
  return sanitizeMathMarkup(`<span class="${token}"></span>`).html === `<span class="${token}"></span>`;
}

const RULES = STYLESHEETS.flatMap((file) => (
  scanRules(readFileSync(path.join(appDir, file), "utf8"))
    .map((rule) => ({ ...rule, file }))
));

describe("math class tokens never collide with application CSS", () => {
  it("parses the stylesheets it is supposed to guard", () => {
    // スキャナが壊れて取りこぼせば以下のテストは無条件に緑になる。まずそれを塞ぐ。
    expect(RULES.length).toBeGreaterThan(1000);
    expect(RULES.some((rule) => rule.selector.includes(".ML__"))).toBe(true);
    // `@media` の中の規則も見えていること (深さフラグ 1 本の実装だと全部落ちる)。
    expect(RULES.some((rule) => rule.selector === ".print-a4-page")).toBe(true);
    // セレクタに宣言が混ざっていないこと。
    expect(RULES.every((rule) => !rule.selector.includes(":") || /^[^{]*[.:#[a-zA-Z]/.test(rule.selector))).toBe(true);
    const splash = RULES.find((rule) => rule.selector === ".startup-splash");
    expect(splash?.declarations.position).toBe("fixed");
  });

  it("scopes every rule whose class the material's TeX can name to a math container", () => {
    const collisions = RULES.flatMap((rule) => ancestorChains(rule.selector).flatMap((compounds) => (
      compounds.flatMap((compound, index) => {
        const tokens = classTokensOf(compound);
        // 教材の span が名乗れるのはサニタイザが残すトークンだけ。複合セレクタが 1 つでも
        // 許可外のクラスを要求していれば、その要素を教材側で作ることはできない。
        if (tokens.length === 0 || !tokens.every(isMathReachableToken)) {
          return [];
        }
        // 数式コンテナ自身か、その子孫としてしか効かない規則なら教材から借りても外へ出ない。
        const scoped = compounds.slice(0, index + 1).some((ancestor) => (
          classTokensOf(ancestor).some(isMathContainerToken)
        ));
        return scoped ? [] : [`${rule.file}: ${rule.selector} (.${tokens.join(".")})`];
      })
    )));

    expect(collisions).toEqual([]);
  });

  it("keeps math container rules free of positioning declarations", () => {
    // 数式コンテナ配下の規則は借りられても位置と重なり順を動かせない、が上のテストの前提。
    const positioned = RULES
      .filter((rule) => classTokensOf(rule.selector).some(isMathContainerToken))
      .flatMap((rule) => Object.keys(rule.declarations)
        .filter((property) => POSITIONING_PROPERTY.has(property))
        .map((property) => `${rule.file}: ${rule.selector} { ${property} }`));

    expect(positioned).toEqual([]);
  });
});
