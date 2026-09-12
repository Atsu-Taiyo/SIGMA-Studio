import type { MathRenderEnvironment } from "@/lib/math-environment";

import {
  inlineMathBodyClassName,
  inlineMathNodeClassName,
  inlineMathNodeDataAttributes,
  type InlineMathFrameStateOptions,
} from "./inline-math-frame";
import { renderMathHtml } from "./math-html";

/**
 * 数式 1 つ分の **DOM を実際に組む**唯一の場所 (編集面の ProseMirror NodeView が使う)。
 *
 * 名前 (クラス・属性) は `inline-math-frame.ts`、markup は `math-html.ts` の
 * `renderMathHtml` (無害化の唯一の出口) から来る。静的レンダラは同じ名前を使って
 * 自分の出力形式 (React / HTML 文字列) で組み立てる。
 */
export interface InlineMathBodyElementOptions {
  /** 中身の箱に足すクラス。**アプリ自身のリテラルだけ**を渡すこと (文書由来の文字列は不可)。 */
  className?: string;
  displayMode?: boolean;
  /** 描画環境 (前文マクロ + 組版スタイル)。省略不可 — 一部だけ既定に落ちる経路を作らない。 */
  environment: MathRenderEnvironment;
}

/**
 * 中身だけを DOM で作る。SSR (`document` が無い) では素の TeX を返す — MathLive の markup は
 * ブラウザでしか作れないので、初期 HTML には数式を出さない。
 */
export function createInlineMathBodyElement(
  tex: string,
  { className, displayMode = false, environment }: InlineMathBodyElementOptions,
): HTMLElement | string {
  if (typeof document === "undefined") {
    return displayMode ? `$$${tex}$$` : `$${tex}$`;
  }

  const element = document.createElement("span");
  element.className = inlineMathBodyClassName(displayMode, className);
  element.dataset.empty = tex ? "false" : "true";
  element.innerHTML = renderMathHtml(tex, environment);
  return element;
}

/** 中身を作り直して差し替える (tex が変わったときだけ呼ぶ)。 */
export function setInlineMathBodyTex(
  body: HTMLElement,
  tex: string,
  { environment }: { environment: MathRenderEnvironment },
): void {
  body.dataset.empty = tex ? "false" : "true";
  body.innerHTML = renderMathHtml(tex, environment);
}

export interface InlineMathFrameElementOptions extends InlineMathFrameStateOptions {
  /** 中身の箱に足すクラス (外枠のクラスは `className`)。 */
  bodyClassName?: string;
  displayMode?: boolean;
  id?: string;
  /** 描画環境 (前文マクロ + 組版スタイル)。省略不可 — 一部だけ既定に落ちる経路を作らない。 */
  environment: MathRenderEnvironment;
  title?: string;
}

/** 外枠 + 中身。編集面の NodeView が使う。 */
export function createInlineMathFrameElement(
  tex: string,
  options: InlineMathFrameElementOptions,
): HTMLElement {
  const frame = document.createElement("span");
  frame.className = inlineMathNodeClassName(options);
  for (const [name, value] of Object.entries(inlineMathNodeDataAttributes({
    id: options.id,
    tex,
    title: options.title,
  }))) {
    frame.setAttribute(name, value);
  }
  const body = createInlineMathBodyElement(tex, {
    className: options.bodyClassName,
    displayMode: options.displayMode,
    environment: options.environment,
  });
  if (typeof body === "string") {
    frame.textContent = body;
  } else {
    frame.append(body);
  }
  return frame;
}
