import { describe, expect, it } from "vitest";

import { findUrls, isSingleUrl } from "./url-detection";

describe("findUrls", () => {
  it("returns no matches for plain text", () => {
    expect(findUrls("これはURLを含まない文章です。")).toEqual([]);
    expect(findUrls("")).toEqual([]);
  });

  it("detects a single https URL with correct offsets", () => {
    const text = "資料はこちら https://example.com/page です";
    const matches = findUrls(text);
    expect(matches).toHaveLength(1);
    expect(matches[0].url).toBe("https://example.com/page");
    expect(text.slice(matches[0].start, matches[0].end)).toBe("https://example.com/page");
  });

  it("detects http and multiple URLs in document order", () => {
    const matches = findUrls("a http://a.test b https://b.test/x");
    expect(matches.map((m) => m.url)).toEqual(["http://a.test", "https://b.test/x"]);
    expect(matches[0].start).toBeLessThan(matches[1].start);
  });

  it("trims trailing sentence punctuation", () => {
    expect(findUrls("see https://example.com.")[0].url).toBe("https://example.com");
    expect(findUrls("(https://example.com)")[0].url).toBe("https://example.com");
    expect(findUrls("見て→https://example.com、ね")[0].url).toBe("https://example.com");
  });

  it("keeps balanced parentheses inside a URL", () => {
    const url = "https://en.wikipedia.org/wiki/Foo_(bar)";
    expect(findUrls(`link ${url}`)[0].url).toBe(url);
  });

  it("ignores a bare scheme with no host", () => {
    expect(findUrls("https://")).toEqual([]);
    expect(findUrls("type https:// here")).toEqual([]);
  });
});

describe("isSingleUrl", () => {
  it("is true only for an exact single URL", () => {
    expect(isSingleUrl("https://example.com")).toBe(true);
    expect(isSingleUrl("  https://example.com  ")).toBe(true);
    expect(isSingleUrl("text https://example.com")).toBe(false);
    expect(isSingleUrl("https://a.test https://b.test")).toBe(false);
    expect(isSingleUrl("nope")).toBe(false);
  });
});
