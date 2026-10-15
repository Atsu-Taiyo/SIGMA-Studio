import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  app: { isPackaged: true, getVersion: () => "0.515.1" },
  autoUpdater: {
    on: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
  },
}));

vi.mock("electron", () => ({
  app: mocks.app,
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock("electron-updater", () => ({ autoUpdater: mocks.autoUpdater }));

import { AppUpdateController } from "./app-updater";

const releaseUrl = "https://github.com/Atsu-Taiyo/SIGMA-Studio/releases/latest";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.app.isPackaged = true;
  vi.stubGlobal("process", Object.create(process, { windowsStore: { value: false } }));
});

afterEach(() => vi.unstubAllGlobals());

describe("Store-managed app updates", () => {
  it("keeps checks informational and never contacts the GitHub updater", async () => {
    vi.stubGlobal("process", Object.create(process, { windowsStore: { value: true } }));
    const controller = new AppUpdateController({ releaseUrl });

    await expect(controller.checkForUpdates()).resolves.toMatchObject({
      phase: "idle", supported: false, releaseUrl,
    });
    await controller.checkAndDownloadInBackground();
    expect(controller.getStatus().error).toBeUndefined();
    expect(mocks.autoUpdater.on).not.toHaveBeenCalled();
    expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(mocks.autoUpdater.downloadUpdate).not.toHaveBeenCalled();
  });

  it("still blocks direct installer downloads and installation", async () => {
    vi.stubGlobal("process", Object.create(process, { windowsStore: { value: true } }));
    const controller = new AppUpdateController({ releaseUrl });

    await expect(controller.downloadUpdate()).resolves.toMatchObject({ phase: "error", supported: false });
    expect(controller.quitAndInstall().ok).toBe(false);
    expect(mocks.autoUpdater.downloadUpdate).not.toHaveBeenCalled();
    expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });
});

describe("non-Store app updates", () => {
  it("preserves background updates for existing installer builds", async () => {
    mocks.autoUpdater.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true, updateInfo: { version: "0.516.0" },
    });
    mocks.autoUpdater.downloadUpdate.mockResolvedValue([]);
    const controller = new AppUpdateController({ releaseUrl });

    await expect(controller.checkAndDownloadInBackground()).resolves.toMatchObject({
      phase: "downloaded", supported: true, availableVersion: "0.516.0",
    });
    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledOnce();
    expect(mocks.autoUpdater.downloadUpdate).toHaveBeenCalledOnce();
  });

  it("continues to report that development builds cannot check for updates", async () => {
    mocks.app.isPackaged = false;
    const controller = new AppUpdateController({ releaseUrl });

    await expect(controller.checkForUpdates()).resolves.toMatchObject({ phase: "error", supported: false });
    expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });
});
