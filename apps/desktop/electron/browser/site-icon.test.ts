import { describe, expect, it } from "vitest";

import { siteIconServiceUrl } from "./site-icon";

describe("siteIconServiceUrl", () => {
  it("asks for the site's origin only", () => {
    const url = new URL(siteIconServiceUrl("https://ja.wikipedia.org/wiki/数学?secret=1#top")!);
    expect(url.origin + url.pathname).toBe("https://www.google.com/s2/favicons");
    expect(url.searchParams.get("domain_url")).toBe("https://ja.wikipedia.org");
    expect(url.searchParams.get("sz")).toBe("128");
  });

  it("never forwards credentials", () => {
    const url = new URL(siteIconServiceUrl("https://user:pass@www.desmos.com/calculator")!);
    expect(url.searchParams.get("domain_url")).toBe("https://www.desmos.com");
    expect(url.href).not.toContain("pass");
  });

  it("does not fetch for unencrypted, local or malformed addresses", () => {
    expect(siteIconServiceUrl("http://example.com")).toBeNull();
    expect(siteIconServiceUrl("file:///etc/passwd")).toBeNull();
    expect(siteIconServiceUrl("javascript:alert(1)")).toBeNull();
    expect(siteIconServiceUrl("not a url")).toBeNull();
    expect(siteIconServiceUrl("")).toBeNull();
  });
});
