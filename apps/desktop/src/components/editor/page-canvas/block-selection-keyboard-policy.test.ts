// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";

import { shouldHandleBlockSelectionDelete } from "./block-selection-keyboard-policy";

describe("shouldHandleBlockSelectionDelete", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("lets body-block selection handle an unclaimed Delete key", () => {
    const bodySurface = document.createElement("div");
    bodySurface.tabIndex = -1;
    document.body.append(bodySurface);
    bodySurface.focus();

    expect(shouldHandleBlockSelectionDelete({
      defaultPrevented: false,
      activeElement: document.activeElement,
      hasOverlayDestructiveSelection: false,
    })).toBe(true);
  });

  it("handles Delete when the overlay is focused without selected shapes", () => {
    const overlaySurface = document.createElement("div");
    overlaySurface.className = "overlay-canvas-bleed-surface";
    overlaySurface.tabIndex = -1;
    document.body.append(overlaySurface);
    overlaySurface.focus();

    expect(shouldHandleBlockSelectionDelete({
      defaultPrevented: false,
      activeElement: document.activeElement,
      hasOverlayDestructiveSelection: false,
    })).toBe(true);
  });

  it("yields when the focused overlay has selected shapes", () => {
    const overlaySurface = document.createElement("div");
    overlaySurface.className = "overlay-canvas-bleed-surface";
    overlaySurface.tabIndex = -1;
    document.body.append(overlaySurface);
    overlaySurface.focus();

    expect(shouldHandleBlockSelectionDelete({
      defaultPrevented: false,
      activeElement: document.activeElement,
      hasOverlayDestructiveSelection: true,
    })).toBe(false);
  });

  it("also yields when focus is within the overlay surface", () => {
    const overlaySurface = document.createElement("div");
    overlaySurface.className = "overlay-canvas-bleed-surface";
    const overlayControl = document.createElement("button");
    overlaySurface.append(overlayControl);
    document.body.append(overlaySurface);
    overlayControl.focus();

    expect(shouldHandleBlockSelectionDelete({
      defaultPrevented: false,
      activeElement: document.activeElement,
      hasOverlayDestructiveSelection: true,
    })).toBe(false);
  });

  it("yields when an earlier keyboard handler already claimed the event", () => {
    expect(shouldHandleBlockSelectionDelete({
      defaultPrevented: true,
      activeElement: document.body,
      hasOverlayDestructiveSelection: false,
    })).toBe(false);
  });

  it("supports continuous Delete: shape first, then blocks on the next press", () => {
    const overlaySurface = document.createElement("div");
    overlaySurface.className = "overlay-canvas-bleed-surface";
    overlaySurface.tabIndex = -1;
    document.body.append(overlaySurface);
    overlaySurface.focus();

    expect(shouldHandleBlockSelectionDelete({
      defaultPrevented: false,
      activeElement: document.activeElement,
      hasOverlayDestructiveSelection: true,
    })).toBe(false);

    expect(shouldHandleBlockSelectionDelete({
      defaultPrevented: false,
      activeElement: document.activeElement,
      hasOverlayDestructiveSelection: false,
    })).toBe(true);
  });
});
