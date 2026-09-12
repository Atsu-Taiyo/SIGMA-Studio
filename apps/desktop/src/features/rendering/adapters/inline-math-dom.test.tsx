import { Window } from "happy-dom";
import { DEFAULT_MATH_RENDER_ENVIRONMENT } from "@/lib/math-environment";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { renderToStaticMarkup } from "react-dom/server";

import { OverlayTextBlocksView } from "@/components/editor/text-flow/OverlayTextBlocksView";
import { MathEnvironmentValueProvider } from "./react";
import { createInlineMathFrameElement, setInlineMathBodyTex } from "./inline-math-dom";
import { renderMathHtml } from "./math-html";

/**
 * 編集面 (ProseMirror の NodeView) と静的レンダラ (PDF・印刷・viewer) が出す数式 DOM の一致。
 *
 * この 2 つがずれると「編集中と印刷で数式の見た目が違う」になる。PDF パリティの e2e は
 * ピクセル比較で最後に気づく仕組みなので、構造のずれはここで先に落とす。
 */
const windowRef = new Window();

beforeEach(() => {
  (globalThis as { document?: unknown }).document = windowRef.document;
});

afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
});

/** 静的レンダラ (HTML 文字列) が同じ数式に対して出す span を取り出す。 */
function staticMathHtml(tex: string, id: string): string {
  const html = renderToStaticMarkup(
    <MathEnvironmentValueProvider environment={TEST_MATH_ENVIRONMENT}>
      <OverlayTextBlocksView
        blocks={[{
          type: "paragraph",
          id: "inline_math_dom_test_81",
          children: [{ type: "mathInline", display: "inline", id, tex }],
        }]}
      />
    </MathEnvironmentValueProvider>,
  );
  const match = html.match(/<span class="inline-math-node"[\s\S]*<\/span>/);
  if (!match) {
    throw new Error(`数式の span が見つからない: ${html}`);
  }
  return match[0];
}

/** 既定の描画環境 (前文マクロ無し・既定の組版)。ここは DOM の形を見るテスト。 */
const TEST_MATH_ENVIRONMENT = DEFAULT_MATH_RENDER_ENVIRONMENT;

describe("inline math frame", () => {
  it("gives the node view the same element the static renderer describes", () => {
    const tex = String.raw`\frac{1}{2}`;
    const frame = createInlineMathFrameElement(tex, { id: "m1", environment: TEST_MATH_ENVIRONMENT });

    expect(frame.outerHTML).toBe(
      `<span class="inline-math-node" data-sigma-doc-math-inline="" data-id="m1" data-tex="${tex}" title="${tex}">`
      + `<span class="math-preview math-preview-inline" data-empty="false">${renderMathHtml(tex, TEST_MATH_ENVIRONMENT)}</span>`
      + "</span>",
    );
  });

  it("matches the static renderer (HTML string) for the same formula", () => {
    const tex = "x^2";
    const frame = createInlineMathFrameElement(tex, { id: "m2", environment: TEST_MATH_ENVIRONMENT });
    const staticHtml = staticMathHtml(tex, "m2");

    expect(staticHtml).toContain('class="inline-math-node"');
    expect(staticHtml).toContain('data-sigma-doc-math-inline=""');
    expect(staticHtml).toContain('data-id="m2"');
    expect(staticHtml).toContain(`data-tex="${tex}"`);
    expect(staticHtml).toContain(`<span class="math-preview math-preview-inline" data-empty="false">`);
    // 中身 (MathLive の markup) はどちらも同じ生成器から来る。
    expect(frame.innerHTML).toContain(renderMathHtml(tex, TEST_MATH_ENVIRONMENT));
  });

  it("marks an empty formula the same way on both sides", () => {
    const frame = createInlineMathFrameElement("", { id: "m3", environment: TEST_MATH_ENVIRONMENT });
    const body = frame.firstElementChild as HTMLElement;

    expect(body.getAttribute("data-empty")).toBe("true");
    expect(staticMathHtml("", "m3")).toContain('data-empty="true"');
  });

  it("rewrites only the body when the formula changes", () => {
    const frame = createInlineMathFrameElement("x", { id: "m4", environment: TEST_MATH_ENVIRONMENT });
    const body = frame.firstElementChild as HTMLElement;

    setInlineMathBodyTex(body, "y", { environment: TEST_MATH_ENVIRONMENT });

    expect(frame.firstElementChild).toBe(body);
    expect(body.innerHTML).toBe(renderMathHtml("y", TEST_MATH_ENVIRONMENT));
    expect(body.getAttribute("data-empty")).toBe("false");
  });

  it("carries the state classes the editor adds", () => {
    const frame = createInlineMathFrameElement("x", { id: "m5", environment: TEST_MATH_ENVIRONMENT, editing: true, selected: true });

    expect(frame.className).toBe("inline-math-node selected editing");
  });
});
