import { afterEach, describe, expect, it, vi } from "vitest";

import { getDesktopRuntime } from "@/lib/runtime/desktop-runtime";

describe("desktop runtime surface", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("exposes only the local repositories", () => {
    installDesktopBridge();

    const runtime = getDesktopRuntime();

    expect(runtime).not.toBeNull();
    expect(Object.keys(runtime as object).sort()).toEqual([
      "ai",
      "capabilities",
      "library",
      "materials",
      "target",
      "templates",
      "workspace",
    ]);
  });

  it("keeps the desktop target on file-backed storage, not the browser store", () => {
    installDesktopBridge();

    const runtime = getDesktopRuntime();

    expect(runtime?.target).toBe("desktop");
    expect(runtime?.capabilities).toMatchObject({ desktopStorage: true, browserStorage: false });
  });

  it("does not advertise a cloud workspace capability", () => {
    installDesktopBridge();

    const runtime = getDesktopRuntime();

    expect(Object.keys(runtime?.capabilities ?? {})).not.toContain("cloudWorkspace");
  });
});

function installDesktopBridge(): void {
  vi.stubGlobal("window", {
    desktopAPI: {
      isDesktop: true,
      platform: "darwin",
      storage: { listFiles: vi.fn() },
      aiEdit: { run: vi.fn() },
      cloudWorkspace: { getStatus: vi.fn() },
    },
  });
}
