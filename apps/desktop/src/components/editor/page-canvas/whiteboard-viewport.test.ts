import { readStylesheet as readFileSync } from "../../../../tests/helpers/read-stylesheet";

import { describe, expect, it } from "vitest";

/**
 * ホワイトボードのビューポート契約。
 *
 * 「無限キャンバス」なので紙モードの額縁（左右38px・下36px）も縦スクロールも持たず、
 * 高さは `.workspace` が既に確定させたグリッド行そのものになる。この契約は CSS だけで
 * 表現されるため、`overlay-bleed.test.ts` と同じ手法（globals.css を読んで規則の中身を
 * 文字列アサートする）で固定する。紙モードへ漏れないことも同時に見る。
 */
const styles = readFileSync(new URL("../../../app/globals.css", import.meta.url), "utf8");
const editorShellSource = readFileSync(new URL("../EditorShell.tsx", import.meta.url), "utf8");
const commentDockSource = readFileSync(new URL("../CommentDock.tsx", import.meta.url), "utf8");

function ruleBody(selector: string): string {
  const start = styles.indexOf(selector);
  expect(start, `globals.css に規則が無い: ${selector}`).toBeGreaterThanOrEqual(0);
  return styles.slice(start, styles.indexOf("}", start) + 1);
}

describe("whiteboard viewport contract", () => {
  it("strips the paper frame and the canvas scrollbar in whiteboard mode", () => {
    const whiteboardCanvas = ruleBody('.editor-canvas[data-whiteboard="true"] {');

    expect(whiteboardCanvas).toContain("padding: 0;");
    expect(whiteboardCanvas).toContain("overflow: hidden;");
    expect(whiteboardCanvas).toContain("background: var(--surface-soft);");
  });

  it("leaves the paper-mode frame exactly as it was", () => {
    const paperCanvas = ruleBody("\n.editor-canvas {");

    expect(paperCanvas).toContain("padding: 0 38px 36px;");
    expect(paperCanvas).toContain("overflow: auto;");
  });

  it("takes the whiteboard viewport height from the workspace grid row", () => {
    const whiteboardPageMode = ruleBody(".page-mode.whiteboard-mode {");

    expect(whiteboardPageMode).toContain("height: 100%;");
    // 100vh からクローム高を引くマジックナンバーの再混入を禁じる回帰ガード。
    expect(whiteboardPageMode).not.toContain("100vh");
    expect(whiteboardPageMode).not.toContain("min-height");
  });

  it("drops the 480px floor that pushed the whiteboard past its viewport", () => {
    expect(ruleBody(".page-stack.whiteboard-page-stack {")).not.toContain("min-height");
    expect(ruleBody(".page-canvas.whiteboard-page-canvas {")).not.toContain("min-height");
  });

  it("does not draw the browser focus outline as a finite whiteboard edge", () => {
    expect(ruleBody(".page-canvas.whiteboard-page-canvas:focus {")).toContain("outline: none;");
  });

  it("insets both docks so they do not stick to the frameless edge", () => {
    expect(ruleBody('.editor-canvas[data-whiteboard="true"] .ai-task-dock-root {'))
      .toContain("margin-left: var(--space-lg);");
    expect(ruleBody('.editor-canvas[data-whiteboard="true"] .comment-dock-root {'))
      .toContain("--comment-dock-right-inset: var(--space-lg);");
  });

  it("leaves the comment dock inset to CSS so no inline style outranks it", () => {
    // インラインの custom property 宣言は属性セレクタの規則より必ず強い。
    // ここで払い出すと上のホワイトボード規則が黙って無効化される。
    expect(commentDockSource).not.toContain("--comment-dock-right-inset");
  });

  it("marks the editor canvas so the whiteboard rules can target it", () => {
    // 失敗時に EditorShell 全文を吐かせないよう、`.editor-canvas` の props だけを切り出す。
    const canvasStart = editorShellSource.indexOf("className={`editor-canvas ");
    expect(canvasStart, "EditorShell に .editor-canvas の section が無い").toBeGreaterThanOrEqual(0);
    const canvasProps = editorShellSource.slice(canvasStart, canvasStart + 400);

    expect(canvasProps).toContain('data-whiteboard={isWhiteboardDocument ? "true" : undefined}');
  });
});
