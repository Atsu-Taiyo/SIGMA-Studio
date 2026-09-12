import { afterEach, describe, expect, it, vi } from "vitest";

import { getAppRouteHref } from "@/lib/app-navigation";

describe("app navigation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("resolves editor links to static files when the app runs from file URLs", () => {
    vi.stubGlobal("window", {
      location: {
        href: "file:///Applications/Sigma%20Studio.app/Contents/Resources/app.asar/out/workspace.html",
        protocol: "file:",
      },
    });

    expect(getAppRouteHref("/", { fileId: "file_1" })).toBe("file:///Applications/Sigma%20Studio.app/Contents/Resources/app.asar/out/index.html?fileId=file_1");
  });

  it("uses exported HTML files for production web navigation", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubGlobal("window", {
      location: {
        href: "https://sigma-studio.example/sigma/index.html",
        protocol: "https:",
      },
    });

    expect(getAppRouteHref("/workspace")).toBe("https://sigma-studio.example/sigma/workspace");
    expect(getAppRouteHref("/print", { fileId: "file_1" })).toBe("https://sigma-studio.example/sigma/print?fileId=file_1");
    expect(getAppRouteHref("/", { fileId: "file_1" })).toBe("https://sigma-studio.example/sigma/?fileId=file_1");
  });

  it("keeps extensionless routes for the development server", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubGlobal("window", {
      location: {
        href: "http://127.0.0.1:3000/",
        protocol: "http:",
      },
    });

    expect(getAppRouteHref("/workspace")).toBe("/workspace");
  });
});
