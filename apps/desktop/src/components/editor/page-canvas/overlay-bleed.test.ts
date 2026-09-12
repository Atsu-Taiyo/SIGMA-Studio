import { readStylesheet as readFileSync } from "../../../../tests/helpers/read-stylesheet";

import { describe, expect, it } from "vitest";

import { resolveOverlayBleed } from "./overlay-bleed";

describe("resolveOverlayBleed", () => {
  it("returns the exact larger horizontal overflow for symmetric bleed", () => {
    expect(resolveOverlayBleed({ left: 90.25, right: 42.5, top: 18.75 })).toEqual({
      x: 90.25,
      top: 18.75,
    });
  });

  it("uses the right overflow when it is larger", () => {
    expect(resolveOverlayBleed({ left: 12, right: 64, top: 0 })).toEqual({
      x: 64,
      top: 0,
    });
  });

  it("clamps non-overflow values to zero", () => {
    expect(resolveOverlayBleed({ left: -1, right: 0, top: -12 })).toEqual({
      x: 0,
      top: 0,
    });
  });

  it("keeps the measured canvas page-sized inside the expanded event surface", () => {
    const editorSource = readFileSync(
      new URL("../OverlayCanvasEditorClient.tsx", import.meta.url),
      "utf8",
    );
    const styles = readFileSync(
      new URL("../../../app/globals.css", import.meta.url),
      "utf8",
    );
    const surfaceStart = editorSource.indexOf("ref={bleedSurfaceRef}");
    const canvasStart = editorSource.indexOf("ref={canvasRef}", surfaceStart);
    const firstCanvasChild = editorSource.indexOf("<input", canvasStart);
    const eventSurfaceProps = editorSource.slice(surfaceStart, canvasStart);
    const canvasProps = editorSource.slice(canvasStart, firstCanvasChild);
    const pagePointStart = editorSource.indexOf("const pagePointFromClient");
    const pagePointSource = editorSource.slice(
      pagePointStart,
      editorSource.indexOf("const focusOverlayCanvas", pagePointStart),
    );
    const surfaceStyleStart = styles.indexOf(".overlay-canvas-bleed-surface {");
    const surfaceStyles = styles.slice(
      surfaceStyleStart,
      styles.indexOf("}", surfaceStyleStart) + 1,
    );
    const canvasStyleStart = styles.indexOf("\n.overlay-canvas-editor {") + 1;
    const canvasStyles = styles.slice(canvasStyleStart, styles.indexOf("}", canvasStyleStart) + 1);
    const whiteboardStyleStart = styles.indexOf(".whiteboard-canvas > .overlay-canvas-bleed-surface,");
    const whiteboardStyles = styles.slice(
      whiteboardStyleStart,
      styles.indexOf("}", whiteboardStyleStart) + 1,
    );

    expect(surfaceStart).toBeGreaterThanOrEqual(0);
    expect(canvasStart).toBeGreaterThan(surfaceStart);
    expect(firstCanvasChild).toBeGreaterThan(canvasStart);
    expect(eventSurfaceProps).toContain('className="overlay-canvas-bleed-surface"');
    expect(eventSurfaceProps).toContain("onPointerDown={handleCanvasPointerDown}");
    expect(eventSurfaceProps).toContain("onPointerMove={handlePointerMove}");
    expect(eventSurfaceProps).toContain("onPointerUp={handlePointerUp}");
    expect(eventSurfaceProps).toContain("tabIndex={-1}");
    expect(canvasProps).toContain('"overlay-canvas-editor"');
    expect(canvasProps).toContain('currentTool.kind === "insert" ? "inserting" : ""');
    expect(canvasProps).not.toContain("onPointerDown=");
    expect(editorSource).not.toContain("overlay-page-coordinate-space");
    expect(editorSource).not.toContain("canvasRef.current?.setPointerCapture");
    expect(editorSource).toContain("bleedSurfaceRef.current?.setPointerCapture");
    expect(pagePointSource).toContain("* canvasWidthRef.current");
    expect(pagePointSource).toContain("* canvasHeightRef.current");
    expect(pagePointSource).not.toContain("bleedValues");

    expect(surfaceStyles).toContain("position: absolute;");
    expect(surfaceStyles).toContain(
      "inset: calc(var(--overlay-bleed-top, 0) * -1) calc(var(--overlay-bleed-x, 0) * -1) 0;",
    );
    expect(surfaceStyles).toContain("touch-action: none;");
    expect(surfaceStyles).toContain("user-select: none;");
    expect(canvasStyles).toContain("position: absolute;");
    expect(canvasStyles).toContain("left: var(--overlay-bleed-x, 0);");
    expect(canvasStyles).toContain("right: var(--overlay-bleed-x, 0);");
    expect(canvasStyles).toContain("top: var(--overlay-bleed-top, 0);");
    expect(canvasStyles).toContain("bottom: 0;");
    expect(whiteboardStyleStart).toBeGreaterThanOrEqual(0);
    expect(whiteboardStyles).toContain(".whiteboard-canvas > .overlay-canvas-bleed-surface > .overlay-canvas-editor");
    expect(whiteboardStyles).toContain("inset: 0;");
    expect(whiteboardStyles).toContain("width: 100%;");
    expect(whiteboardStyles).toContain("height: 100%;");
  });

  it("keeps whiteboard viewport chrome outside the zoomed world transform", () => {
    const styles = readFileSync(
      new URL("../../../app/globals.css", import.meta.url),
      "utf8",
    );
    const stackStyleStart = styles.indexOf(".page-stack.whiteboard-page-stack {");
    const stackStyles = styles.slice(stackStyleStart, styles.indexOf("}", stackStyleStart) + 1);
    const worldStyleStart = styles.indexOf(".whiteboard-canvas {");
    const worldStyles = styles.slice(worldStyleStart, styles.indexOf("}", worldStyleStart) + 1);

    expect(stackStyleStart).toBeGreaterThanOrEqual(0);
    expect(stackStyles).toContain("transform: none;");
    expect(stackStyles).not.toContain("--editor-zoom");
    expect(worldStyles).toContain("scale(var(--whiteboard-zoom, 1))");
  });
});
