import { describe, expect, it } from "vitest";

import { isBrowsableUrl, parseSuggestions, resolveOmniboxInput, searchUrl, suggestionEndpoint } from "./omnibox";

describe("resolveOmniboxInput", () => {
  it("treats empty input as nothing to open", () => {
    expect(resolveOmniboxInput("   ")).toEqual({ kind: "empty" });
  });

  it("opens things that look like a real domain over https", () => {
    expect(resolveOmniboxInput("example.com")).toEqual({ kind: "url", url: "https://example.com" });
    expect(resolveOmniboxInput("www.mext.go.jp/a/b?x=1")).toEqual({ kind: "url", url: "https://www.mext.go.jp/a/b?x=1" });
    expect(resolveOmniboxInput("  geogebra.org  ")).toEqual({ kind: "url", url: "https://geogebra.org" });
  });

  it("keeps an explicit http or https URL as typed", () => {
    expect(resolveOmniboxInput("http://example.com/a")).toEqual({ kind: "url", url: "http://example.com/a" });
    expect(resolveOmniboxInput("HTTPS://Example.com")).toMatchObject({ kind: "url" });
  });

  it("uses http for localhost, IP addresses and .local hosts", () => {
    expect(resolveOmniboxInput("localhost:3000")).toEqual({ kind: "url", url: "http://localhost:3000" });
    expect(resolveOmniboxInput("127.0.0.1:8080/x")).toEqual({ kind: "url", url: "http://127.0.0.1:8080/x" });
    expect(resolveOmniboxInput("192.168.0.1")).toEqual({ kind: "url", url: "http://192.168.0.1" });
    expect(resolveOmniboxInput("printer.local")).toEqual({ kind: "url", url: "http://printer.local" });
  });

  it("searches for words, sentences and dotted text whose suffix is not a real TLD", () => {
    expect(resolveOmniboxInput("二次関数 グラフ")).toEqual({
      kind: "search",
      query: "二次関数 グラフ",
      url: "https://www.google.com/search?q=%E4%BA%8C%E6%AC%A1%E9%96%A2%E6%95%B0%20%E3%82%B0%E3%83%A9%E3%83%95",
    });
    expect(resolveOmniboxInput("hello")).toMatchObject({ kind: "search" });
    expect(resolveOmniboxInput("v1.2.3")).toMatchObject({ kind: "search" });
    expect(resolveOmniboxInput("foo.notatld")).toMatchObject({ kind: "search" });
  });

  it("never opens non-web schemes; they become a search instead", () => {
    for (const text of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,<b>x</b>", "sigma-doc-storage://x", "about:blank"]) {
      expect(resolveOmniboxInput(text)).toMatchObject({ kind: "search" });
    }
  });

  it("searches with the selected engine and falls back to the default for unknown ids", () => {
    expect(searchUrl("a&b", "duckduckgo")).toBe("https://duckduckgo.com/?q=a%26b");
    expect(searchUrl("a", "yahoo-japan")).toBe("https://search.yahoo.co.jp/search?p=a");
    expect(searchUrl("a", "nope")).toBe("https://www.google.com/search?q=a");
  });
});

describe("isBrowsableUrl", () => {
  it("accepts only http and https", () => {
    expect(isBrowsableUrl("https://example.com")).toBe(true);
    expect(isBrowsableUrl("http://example.com")).toBe(true);
    expect(isBrowsableUrl("file:///a")).toBe(false);
    expect(isBrowsableUrl("javascript:1")).toBe(false);
    expect(isBrowsableUrl("not a url")).toBe(false);
  });
});

describe("search suggestions", () => {
  it("picks a per-engine endpoint and falls back to Google's for engines without one", () => {
    expect(suggestionEndpoint("二次", "google")).toContain("suggestqueries.google.com");
    expect(suggestionEndpoint("a b", "duckduckgo")).toBe("https://duckduckgo.com/ac/?type=list&q=a%20b");
    expect(suggestionEndpoint("a", "bing")).toContain("api.bing.com/osjson.aspx");
    expect(suggestionEndpoint("a", "yahoo-japan")).toContain("suggestqueries.google.com");
  });

  it("extracts unique text candidates from OpenSearch payloads and ignores malformed ones", () => {
    expect(parseSuggestions(["q", ["one", " two ", "one", 3, "", "three"]])).toEqual(["one", "two", "three"]);
    expect(parseSuggestions(["q", Array.from({ length: 20 }, (_, index) => `s${index}`)], 3)).toEqual(["s0", "s1", "s2"]);
    expect(parseSuggestions({ not: "an array" })).toEqual([]);
    expect(parseSuggestions(["q", "not-an-array"])).toEqual([]);
    expect(parseSuggestions(null)).toEqual([]);
  });
});
