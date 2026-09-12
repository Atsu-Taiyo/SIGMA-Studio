import { app, BrowserWindow } from "electron";
import {
  autoUpdater,
  type ProgressInfo,
  type UpdateDownloadedEvent,
  type UpdateInfo,
} from "electron-updater";
import { createCurrentLocaleTranslator } from "@/lib/i18n";

const te = createCurrentLocaleTranslator("error");

export type AppUpdatePhase =
  | "idle"
  | "checking"
  | "not-available"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";

export interface AppUpdateProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

export interface AppUpdateState {
  phase: AppUpdatePhase;
  currentVersion: string;
  releaseUrl: string;
  supported: boolean;
  availableVersion?: string;
  releaseName?: string | null;
  releaseDate?: string;
  progress?: AppUpdateProgress;
  error?: string;
}

interface AppUpdateControllerOptions {
  releaseUrl: string;
}

export class AppUpdateController {
  private configured = false;
  private checkPromise: Promise<AppUpdateState> | null = null;
  private downloadPromise: Promise<AppUpdateState> | null = null;
  private latestUpdateInfo: UpdateInfo | null = null;
  private state: AppUpdateState;

  constructor(private readonly options: AppUpdateControllerOptions) {
    this.state = this.createState("idle");
  }

  getStatus(): AppUpdateState {
    return this.state;
  }

  async checkForUpdates(): Promise<AppUpdateState> {
    if (this.checkPromise) {
      return this.checkPromise;
    }

    this.checkPromise = this.doCheckForUpdates().finally(() => {
      this.checkPromise = null;
    });
    return this.checkPromise;
  }

  async downloadUpdate(): Promise<AppUpdateState> {
    if (this.downloadPromise) {
      return this.downloadPromise;
    }

    this.downloadPromise = this.doDownloadUpdate().finally(() => {
      this.downloadPromise = null;
    });
    return this.downloadPromise;
  }

  async checkAndDownloadInBackground(): Promise<AppUpdateState> {
    if (!isBuiltInUpdaterSupported()) {
      return this.state;
    }

    const checked = await this.checkForUpdates();
    if (checked.phase === "available") {
      return this.downloadUpdate();
    }
    return checked;
  }

  quitAndInstall(): { ok: true } | { ok: false; error: string } {
    if (this.state.phase !== "downloaded") {
      return { ok: false, error: te("electron.updater.downloadIncomplete") };
    }

    setImmediate(() => {
      autoUpdater.quitAndInstall();
    });
    return { ok: true };
  }

  private async doCheckForUpdates(): Promise<AppUpdateState> {
    if (!isBuiltInUpdaterSupported()) {
      return this.setState("error", {
        supported: false,
        error: process.windowsStore
          ? te("electron.updater.storeManaged")
          : te("electron.updater.devCheckUnavailable"),
      });
    }

    this.configureUpdater();
    this.setState("checking", { progress: undefined, error: undefined });

    try {
      const result = await autoUpdater.checkForUpdates();
      if (!result) {
        return this.setState("error", {
          error: te("electron.updater.unavailable"),
        });
      }

      this.latestUpdateInfo = result.updateInfo;
      if (result.isUpdateAvailable) {
        return this.setState("available", this.updateInfoPatch(result.updateInfo));
      }

      return this.setState("not-available", this.updateInfoPatch(result.updateInfo));
    } catch (error) {
      return this.setState("error", {
        error: errorMessage(error, te("electron.updater.checkFailed")),
      });
    }
  }

  private async doDownloadUpdate(): Promise<AppUpdateState> {
    if (!isBuiltInUpdaterSupported()) {
      return this.setState("error", {
        supported: false,
        error: process.windowsStore
          ? te("electron.updater.storeManaged")
          : te("electron.updater.devDownloadUnavailable"),
      });
    }

    this.configureUpdater();

    if (this.state.phase === "downloaded") {
      return this.state;
    }

    if (!this.latestUpdateInfo || this.state.phase !== "available") {
      const checked = await this.checkForUpdates();
      if (checked.phase !== "available") {
        return checked;
      }
    }

    this.setState("downloading", {
      ...this.updateInfoPatch(this.latestUpdateInfo),
      progress: {
        percent: 0,
        transferred: 0,
        total: 0,
        bytesPerSecond: 0,
      },
      error: undefined,
    });

    try {
      await autoUpdater.downloadUpdate();
      const nextState = this.state as AppUpdateState;
      return nextState.phase === "downloaded"
        ? nextState
        : this.setState("downloaded", this.updateInfoPatch(this.latestUpdateInfo));
    } catch (error) {
      return this.setState("error", {
        ...this.updateInfoPatch(this.latestUpdateInfo),
        error: errorMessage(error, te("electron.updater.downloadFailed")),
      });
    }
  }

  private configureUpdater(): void {
    if (this.configured) {
      return;
    }
    this.configured = true;

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.disableDifferentialDownload = false;
    autoUpdater.logger = console;

    autoUpdater.on("checking-for-update", () => {
      this.setState("checking", { error: undefined, progress: undefined });
    });
    autoUpdater.on("update-available", (info) => {
      this.latestUpdateInfo = info;
      this.setState("available", this.updateInfoPatch(info));
    });
    autoUpdater.on("update-not-available", (info) => {
      this.latestUpdateInfo = info;
      this.setState("not-available", this.updateInfoPatch(info));
    });
    autoUpdater.on("download-progress", (progress) => {
      this.setState("downloading", {
        ...this.updateInfoPatch(this.latestUpdateInfo),
        progress: toProgress(progress),
      });
    });
    autoUpdater.on("update-downloaded", (event) => {
      this.latestUpdateInfo = event;
      this.setState("downloaded", this.updateInfoPatch(event));
    });
    autoUpdater.on("update-cancelled", (info) => {
      this.latestUpdateInfo = info;
      this.setState("error", {
        ...this.updateInfoPatch(info),
        error: te("electron.updater.downloadCancelled"),
      });
    });
    autoUpdater.on("error", (error) => {
      this.setState("error", {
        ...this.updateInfoPatch(this.latestUpdateInfo),
        error: errorMessage(error, te("electron.updater.processingFailed")),
      });
    });
  }

  private updateInfoPatch(info: UpdateInfo | UpdateDownloadedEvent | null | undefined): Partial<AppUpdateState> {
    if (!info) {
      return {};
    }
    return {
      availableVersion: info.version,
      releaseName: info.releaseName,
      releaseDate: info.releaseDate,
    };
  }

  private createState(phase: AppUpdatePhase, patch: Partial<AppUpdateState> = {}): AppUpdateState {
    return {
      phase,
      currentVersion: app.getVersion(),
      releaseUrl: this.options.releaseUrl,
      supported: isBuiltInUpdaterSupported(),
      ...patch,
    };
  }

  private setState(phase: AppUpdatePhase, patch: Partial<AppUpdateState> = {}): AppUpdateState {
    this.state = this.createState(phase, patch);
    this.broadcast();
    return this.state;
  }

  private broadcast(): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("app-updater:status-changed", this.state);
    }
  }
}

function isBuiltInUpdaterSupported(): boolean {
  return app.isPackaged && !process.windowsStore;
}

function toProgress(progress: ProgressInfo): AppUpdateProgress {
  return {
    percent: Number.isFinite(progress.percent) ? progress.percent : 0,
    transferred: progress.transferred,
    total: progress.total,
    bytesPerSecond: progress.bytesPerSecond,
  };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
