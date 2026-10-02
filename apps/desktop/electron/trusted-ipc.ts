import { ipcMain as electronIpcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

type SenderEvent = IpcMainEvent | IpcMainInvokeEvent;
interface RendererPolicy {
  getMainWebContents(): WebContents | null;
  rendererDirectory: string;
  devServerUrl: string | null;
}

let policy: RendererPolicy | null = null;
const previews = new Map<WebContents, { renderId: string; url: string }>();

/** Set once by main before any privileged handlers are registered. Fail closed until then. */
export function configureTrustedIpc(value: RendererPolicy): void {
  policy = value;
}

/** Only actual application routes may invoke the bridge, even within the local origin. */
export function isTrustedRendererUrl(value: string, rendererDirectory: string, devServerUrl: string | null): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (devServerUrl) {
      return url.origin === new URL(devServerUrl).origin && ["/", "/workspace", "/workspace/", "/print", "/print/"].includes(url.pathname);
    }
    if (url.protocol !== "file:" || url.host) return false;
    const filename = fileURLToPath(url);
    return ["index.html", "workspace.html", "print.html"].some(name => filename === path.join(rendererDirectory, name));
  } catch {
    return false;
  }
}

function isTopFrame(event: SenderEvent): boolean {
  return Boolean(event?.sender && !event.sender.isDestroyed() && event.senderFrame && event.senderFrame === event.sender.mainFrame);
}

export function isTrustedMainSender(event: SenderEvent): boolean {
  return Boolean(policy && isTopFrame(event) && event.sender === policy.getMainWebContents()
    && isTrustedRendererUrl(event.senderFrame!.url, policy.rendererDirectory, policy.devServerUrl)
    && isTrustedRendererUrl(event.sender.getURL(), policy.rendererDirectory, policy.devServerUrl));
}

/** Give an AI preview access to its one document; never to the editor's bridge. */
export function authorizePreviewSender(sender: WebContents, renderId: string, url: string): () => void {
  previews.set(sender, { renderId, url });
  return () => { previews.delete(sender); };
}

function isTrustedPreviewSender(event: SenderEvent, renderId: unknown): boolean {
  const preview = previews.get(event?.sender);
  return Boolean(policy && preview && renderId === preview.renderId && isTopFrame(event)
    && event.senderFrame!.url === preview.url && event.sender.getURL() === preview.url
    && isTrustedRendererUrl(preview.url, policy.rendererDirectory, policy.devServerUrl));
}

type InvokeHandler = Parameters<typeof electronIpcMain.handle>[1];
type EventHandler = Parameters<typeof electronIpcMain.on>[1];

/** Every privileged invoke/send route goes through the same window, frame and URL check. */
export const ipcMain = {
  handle(channel: string, handler: InvokeHandler): void {
    electronIpcMain.handle(channel, (event, ...args) => {
      if (!isTrustedMainSender(event)) throw new Error("TRUSTED_RENDERER_REQUIRED");
      return handler(event, ...args);
    });
  },
  on(channel: string, handler: EventHandler): void {
    electronIpcMain.on(channel, (event, ...args) => {
      if (isTrustedMainSender(event)) handler(event, ...args);
    });
  },
};

export function registerPreviewDocumentIpc(handler: InvokeHandler): void {
  electronIpcMain.handle("ai-render:get-document", (event, ...args) => {
    if (!isTrustedPreviewSender(event, args[0])) throw new Error("TRUSTED_PREVIEW_REQUIRED");
    return handler(event, ...args);
  });
}
