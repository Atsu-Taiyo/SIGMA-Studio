import { expect, it } from "vitest";
import { embeddedDocumentFontCss } from "./embedded-fonts";

it("loads portable font data and rejects external URLs and CSS injection", () => {
  const css = embeddedDocumentFontCss({ version: 1, shapes: [], assets: {}, extensions: { "sigma.embedded-fonts": [
    { family: "MPro-123", source: "data:font/ttf;base64,AAAA" },
    { family: 'bad"}body{color:red}', source: "data:font/ttf;base64,AAAA" },
    { family: "network", source: "https://example.com/font.ttf" },
  ] } });
  expect(css).toContain('font-family:"MPro-123"');
  expect(css).not.toMatch(/body|network|example\.com/);
});

it("resolves a content-addressed application font without accepting a document URL", () => {
  const id = "a".repeat(64);
  const snapshot = { version: 1 as const, shapes: [], assets: {}, extensions: { "sigma.font-references": [
    { family: "SourceFace-123", resourceId: id, url: "https://example.com/tracker" },
    { family: 'bad"}body{color:red}', resourceId: id },
    { family: "other", resourceId: "../font" },
  ] } };
  expect(embeddedDocumentFontCss(snapshot)).toContain(`sigma-app-font://${id}/`);
  expect(embeddedDocumentFontCss(snapshot, { [id]: `sigma-app-font://${id}/` }))
    .toContain(`font-family:"SourceFace-123";src:url("sigma-app-font://${id}/")`);
  expect(embeddedDocumentFontCss(snapshot, { [id]: "https://example.com/font" })).toBe("");
  expect(embeddedDocumentFontCss(snapshot, { [id]: `sigma-app-font://${"b".repeat(64)}/` })).toBe("");
});
