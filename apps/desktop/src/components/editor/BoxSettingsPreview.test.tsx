// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { PrintBoxBlock } from "@/components/print/print-static-blocks";
import type { BoxBlockNode } from "@/features/document";
import { BoxSettingsPreview, BOX_PREVIEW_ID_PREFIX } from "./BoxSettingsPreview";
import { HeadingNumberingProvider } from "./text-flow/HeadingNumberingContext";
import { ProblemNumberingProvider } from "./text-flow/ProblemNumberingContext";

it("keeps problem and heading numbers while isolating preview measurement IDs", () => {
  const box: BoxBlockNode = {
    type: "boxBlock", id: "box", styleId: "fancybox", title: [], blocks: [
      { type: "section", id: "section", title: "見出し" },
      { type: "problem", id: "problem", tags: [], lead: [], prompt: [{ type: "paragraph", id: "prompt", children: [{ type: "text", text: "問題文" }] }], solution: [], hints: [] },
    ],
  };
  const render = (preview: boolean) => renderToStaticMarkup(
    <ProblemNumberingProvider numbers={new Map([["problem", 7]])}>
      <HeadingNumberingProvider numbers={new Map([["section", "2.3"]])}>
        {preview ? <BoxSettingsPreview box={box} title={[]} body={box.blocks} /> : <PrintBoxBlock block={box} columnGapMm={8} />}
      </HeadingNumberingProvider>
    </ProblemNumberingProvider>,
  );
  const parse = (html: string) => { const node = document.createElement("div"); node.innerHTML = html; return node; };
  const paper = parse(render(false));
  const preview = parse(render(true));
  expect(paper.querySelector(".print-problem-number")?.textContent).toContain("7");
  expect(preview.querySelector(".print-problem-number")?.textContent).toBe(paper.querySelector(".print-problem-number")?.textContent);
  expect(preview.querySelector(".heading-number-prefix")?.textContent).toBe("2.3 ");
  expect(preview.querySelector(".print-box-body")?.textContent).toBe(paper.querySelector(".print-box-body")?.textContent);
  for (const node of preview.querySelectorAll("[data-sigma-doc-id]")) expect(node.getAttribute("data-sigma-doc-id")).toMatch(new RegExp(`^${BOX_PREVIEW_ID_PREFIX}`));
});
