import { describe, expect, it } from "vitest";
import { isDevServerNavigation, resolveDevServerUrl } from "./dev-server";

describe("Electron development origin", () => {
  it("ignores even malformed overrides in packaged builds", () => {
    expect(resolveDevServerUrl(true, "not a URL")).toBeNull();
    expect(resolveDevServerUrl(false)).toBeNull();
  });
  it("accepts an explicit loopback HTTP origin", () => {
    expect(resolveDevServerUrl(false, "http://127.0.0.1:3107")).toBe("http://127.0.0.1:3107/");
  });
  it.each(["https://127.0.0.1:3107", "http://example.com:3107", "http://127.0.0.1.evil.test:3107", "file:///tmp/index.html", "http://localhost:3107", "http://127.0.0.1", "http://user:pass@127.0.0.1:3107", "http://127.0.0.1:3107/other", "http://127.0.0.1:3107/?x=1"])("rejects %s", (url) => {
    expect(() => resolveDevServerUrl(false, url)).toThrow();
  });
  it("restricts navigation to the selected origin", () => {
    const origin = "http://127.0.0.1:3107/";
    expect(isDevServerNavigation(`${origin}print?renderId=test`, origin)).toBe(true);
    for (const url of ["http://127.0.0.1:3108/", "https://example.com/", "file:///tmp/index.html", "javascript:alert(1)", "http://user@127.0.0.1:3107/"]) {
      expect(isDevServerNavigation(url, origin)).toBe(false);
    }
  });
});
