import { describe, expect, it } from "vitest";

import { activeDownloadCount, displayAddress, downloadFraction, formatBytes, hostOf, nextHighlight, tabLabel } from "./browser-format";

describe("browser formatting", () => {
  it("formats sizes with 1024 steps and at most one decimal", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024)).toBe("1 MB");
    expect(formatBytes(250 * 1024 * 1024)).toBe("250 MB");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });

  it("shows the address without the protocol, trailing slash and www-less host noise", () => {
    expect(displayAddress("https://www.example.com/")).toBe("www.example.com");
    expect(displayAddress("https://example.com/a/b?q=1#x")).toBe("example.com/a/b?q=1#x");
    expect(displayAddress("http://localhost:3000/")).toBe("http://localhost:3000");
    expect(displayAddress("")).toBe("");
    expect(displayAddress("not a url")).toBe("not a url");
  });

  it("labels a tab with its title, then its host", () => {
    expect(tabLabel({ title: " 二次関数 ", url: "https://a.example" })).toBe("二次関数");
    expect(tabLabel({ title: "", url: "https://www.example.com/x" })).toBe("example.com");
    expect(tabLabel({ title: "", url: "" })).toBe("");
    expect(hostOf("bad")).toBe("");
  });

  it("reports download progress only when the size is known", () => {
    expect(downloadFraction({ receivedBytes: 50, totalBytes: 200 })).toBe(0.25);
    expect(downloadFraction({ receivedBytes: 50, totalBytes: 0 })).toBeNull();
    expect(downloadFraction({ receivedBytes: 500, totalBytes: 200 })).toBe(1);
    expect(activeDownloadCount([{ state: "progressing" }, { state: "completed" }, { state: "interrupted" }, { state: "cancelled" }])).toBe(2);
  });
});

describe("nextHighlight", () => {
  it("cycles through the suggestions and the input itself (-1)", () => {
    expect(nextHighlight(-1, 1, 3)).toBe(0);
    expect(nextHighlight(2, 1, 3)).toBe(-1);
    expect(nextHighlight(-1, -1, 3)).toBe(2);
    expect(nextHighlight(0, -1, 3)).toBe(-1);
    expect(nextHighlight(1, 1, 3)).toBe(2);
  });
});
