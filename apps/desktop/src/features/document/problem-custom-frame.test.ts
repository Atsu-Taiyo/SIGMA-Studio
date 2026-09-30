import { describe, expect, it } from "vitest";

import {
  clampCustomFrameSlice,
  createCustomFrameGeometry,
  cropCustomFrameSvg,
  isCanonicalFrameSvg,
  MAX_CUSTOM_FRAME_SVG_LENGTH,
  normalizeFrameSvg,
  readSvgViewBox,
} from "./problem-custom-frame";

const BASIC = '<svg viewBox="0 0 80 50"><rect x="1" y="1" width="78" height="48" fill="none" stroke="#123456" stroke-width="2"/></svg>';

describe("normalizeFrameSvg", () => {
  it("gives a plain SVG a namespace and an explicit size", () => {
    const result = normalizeFrameSvg(BASIC);
    expect(result).toMatchObject({ ok: true, width: 80, height: 50 });
    if (result.ok) {
      expect(result.svg).toContain('xmlns="http://www.w3.org/2000/svg"');
      expect(result.svg).toContain('width="80" height="50" viewBox="0 0 80 50"');
      expect(isCanonicalFrameSvg(result.svg)).toBe(true);
    }
  });

  it("takes the SVG out of a prolog, a code fence or chatter around it", () => {
    const wrapped = `以下です。\n\`\`\`svg\n<?xml version="1.0"?>\n<!-- frame -->\n${BASIC}\n\`\`\`\nどうぞ`;
    const result = normalizeFrameSvg(wrapped);
    expect(result.ok && result.svg.startsWith("<svg")).toBe(true);
    expect(result.ok && result.svg.endsWith("</svg>")).toBe(true);
  });

  it("falls back to width and height when there is no viewBox", () => {
    expect(normalizeFrameSvg('<svg width="120pt" height="90"><path d="M0 0"/></svg>'))
      .toMatchObject({ ok: true, width: 120, height: 90 });
  });

  it("rejects what it cannot size, and what is not an SVG", () => {
    expect(normalizeFrameSvg("   ")).toEqual({ ok: false, reason: "empty" });
    expect(normalizeFrameSvg("<div>no</div>")).toEqual({ ok: false, reason: "notSvg" });
    expect(normalizeFrameSvg("<svg><rect/></svg>")).toEqual({ ok: false, reason: "noViewBox" });
    expect(normalizeFrameSvg(`<svg viewBox="0 0 10 10">${"<g/>".repeat(MAX_CUSTOM_FRAME_SVG_LENGTH)}</svg>`))
      .toEqual({ ok: false, reason: "tooLarge" });
  });

  it("drops scripts, event handlers and references to anything outside the drawing", () => {
    const hostile = `<svg viewBox="0 0 40 40" onload="alert(1)">
      <script>alert(1)</script>
      <foreignObject><div>hi</div></foreignObject>
      <image href="https://example.com/track.png" width="4" height="4"/>
      <image xlink:href="data:image/png;base64,AAAA" width="4" height="4"/>
      <use href="#local"/>
      <rect width="40" height="40" fill="url(https://example.com/x)" onclick="x()"/>
      <rect id="local" width="1" height="1" style="fill:url(#g)"/>
    </svg>`;
    const result = normalizeFrameSvg(hostile);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.svg).not.toMatch(/script|foreignObject|onload|onclick|example\.com|alert/i);
    expect(result.svg).toContain('href="data:image/png;base64,AAAA"');
    expect(result.svg).toContain('href="#local"');
    expect(result.svg).toContain("url(#g)");
  });

  it("refuses entity tricks", () => {
    expect(normalizeFrameSvg('<svg viewBox="0 0 4 4"><!DOCTYPE x [<!ENTITY a "b">]></svg>'))
      .toMatchObject({ ok: false });
  });

  it("is not canonical when the stored text was not produced by the normalizer", () => {
    expect(isCanonicalFrameSvg(BASIC)).toBe(false);
  });
});

describe("custom frame geometry", () => {
  const drawing = { svg: BASIC, width: 80, height: 50 };

  it("chooses corners of about a quarter of the shorter side", () => {
    expect(createCustomFrameGeometry(drawing)).toMatchObject({ slice: 12.5, borderPx: 16, paddingPx: 12 });
  });

  it("never lets the corners meet in the middle", () => {
    expect(clampCustomFrameSlice(999, 80, 50)).toBe(24);
    expect(clampCustomFrameSlice(0, 80, 50)).toBe(1);
  });

  it("keeps the requested values inside the supported range", () => {
    expect(createCustomFrameGeometry(drawing, { borderPx: 500, paddingPx: -3 }))
      .toMatchObject({ borderPx: 48, paddingPx: 4 });
  });
});

describe("cropCustomFrameSvg", () => {
  const normalized = normalizeFrameSvg(BASIC);
  const frame = normalized.ok ? { svg: normalized.svg, slice: 10 } : { svg: "", slice: 10 };

  it("keeps the whole drawing for a fully closed frame", () => {
    expect(cropCustomFrameSvg(frame, { top: true, bottom: true })).toBe(frame.svg);
  });

  it("cuts away the top and bottom corner bands where the frame stays open", () => {
    const openBottom = readSvgViewBox(cropCustomFrameSvg(frame, { top: true, bottom: false }));
    const openTop = readSvgViewBox(cropCustomFrameSvg(frame, { top: false, bottom: true }));
    const openBoth = readSvgViewBox(cropCustomFrameSvg(frame, { top: false, bottom: false }));
    expect(openBottom).toEqual({ x: 0, y: 0, width: 80, height: 40 });
    expect(openTop).toEqual({ x: 0, y: 10, width: 80, height: 40 });
    expect(openBoth).toEqual({ x: 0, y: 10, width: 80, height: 30 });
  });
});
