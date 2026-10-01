import { beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { IpcMainInvokeEvent, WebContents } from "electron";

const registered = vi.hoisted(() => ({ invokes: new Map<string, (...args: unknown[]) => unknown>(), sends: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock("electron", () => ({ ipcMain: {
  handle: (channel: string, handler: (...args: unknown[]) => unknown) => registered.invokes.set(channel, handler),
  on: (channel: string, handler: (...args: unknown[]) => unknown) => registered.sends.set(channel, handler),
} }));
import { authorizePreviewSender, configureTrustedIpc, ipcMain, isTrustedRendererUrl, registerPreviewDocumentIpc } from "./trusted-ipc";

const directory = path.resolve("/sigma/out");
const devOrigin = "http://127.0.0.1:3100/";
function contents(url: string) {
  const frame = { url };
  return { mainFrame: frame, getURL: () => frame.url, isDestroyed: () => false } as unknown as WebContents;
}
function event(sender: WebContents, senderFrame = sender.mainFrame): IpcMainInvokeEvent {
  return { sender, senderFrame } as IpcMainInvokeEvent;
}

describe("privileged IPC sender boundary", () => {
  let main: WebContents;
  beforeEach(() => {
    registered.invokes.clear(); registered.sends.clear();
    main = contents(devOrigin);
    configureTrustedIpc({ getMainWebContents: () => main, rendererDirectory: directory, devServerUrl: devOrigin });
  });

  it("preserves the legitimate handler's arguments and results", async () => {
    const save = vi.fn(async (_event, fileId, document) => ({ ok: true, fileId, document }));
    ipcMain.handle("storage:save-document", save);
    expect(await registered.invokes.get("storage:save-document")!(event(main), "file", { content: "saved" }))
      .toEqual({ ok: true, fileId: "file", document: { content: "saved" } });
    expect(save).toHaveBeenCalledOnce();
  });

  it("rejects same-origin other windows, child frames, destroyed senders and navigated main pages before effects", () => {
    const effect = vi.fn();
    ipcMain.handle("ai-edit:run", effect);
    const invoke = registered.invokes.get("ai-edit:run")!;
    const other = contents(devOrigin);
    const child = { url: devOrigin } as WebContents["mainFrame"];
    for (const attacker of [event(other), event(main, child), null, { sender: { ...main, isDestroyed: () => true }, senderFrame: main.mainFrame }]) {
      expect(() => invoke(attacker, "run", {})).toThrow("TRUSTED_RENDERER_REQUIRED");
    }
    for (const url of ["http://127.0.0.1:3101/", "https://attacker.test/", `${devOrigin}untrusted.html`, "data:text/html,attack"]) {
      (main.mainFrame as { url: string }).url = url;
      expect(() => invoke(event(main), "run", {})).toThrow("TRUSTED_RENDERER_REQUIRED");
    }
    expect(effect).not.toHaveBeenCalled();
  });

  it("guards fire-and-forget send handlers too", () => {
    const effect = vi.fn();
    ipcMain.on("action", effect);
    const send = registered.sends.get("action")!;
    send(event(contents(devOrigin)), "value");
    send(event(main, { url: devOrigin } as WebContents["mainFrame"]), "value");
    expect(effect).not.toHaveBeenCalled();
    send(event(main), "value");
    expect(effect).toHaveBeenCalledWith(event(main), "value");
  });

  it("limits each preview to its assigned document and revokes access at cleanup", () => {
    const url = `${devOrigin}print?renderId=render-a&profile=teacher`;
    const preview = contents(url);
    const release = authorizePreviewSender(preview, "render-a", url);
    const document = { title: "Only this preview" };
    registerPreviewDocumentIpc(() => document);
    ipcMain.handle("storage:load-document", vi.fn());
    const invoke = registered.invokes.get("ai-render:get-document")!;
    expect(invoke(event(preview), "render-a")).toBe(document);
    for (const [sender, id] of [[main, "render-a"], [contents(url), "render-a"], [preview, "render-b"]] as const) {
      expect(() => invoke(event(sender), id)).toThrow("TRUSTED_PREVIEW_REQUIRED");
    }
    expect(() => invoke(event(preview, { url } as WebContents["mainFrame"]), "render-a")).toThrow("TRUSTED_PREVIEW_REQUIRED");
    expect(() => registered.invokes.get("storage:load-document")!(event(preview), "file")).toThrow("TRUSTED_RENDERER_REQUIRED");
    (preview.mainFrame as { url: string }).url = `${devOrigin}print?renderId=render-b`;
    expect(() => invoke(event(preview), "render-a")).toThrow("TRUSTED_PREVIEW_REQUIRED");
    (preview.mainFrame as { url: string }).url = url;
    release();
    expect(() => invoke(event(preview), "render-a")).toThrow("TRUSTED_PREVIEW_REQUIRED");
  });

  it("accepts only application routes in development and static builds", () => {
    for (const route of ["/", "/workspace", "/print?fileId=abc#page"]) expect(isTrustedRendererUrl(new URL(route, devOrigin).href, directory, devOrigin)).toBe(true);
    expect(isTrustedRendererUrl("http://user@127.0.0.1:3100/", directory, devOrigin)).toBe(false);
    for (const filename of ["index.html", "workspace.html", "print.html"]) expect(isTrustedRendererUrl(pathToFileURL(path.join(directory, filename)).href, directory, null)).toBe(true);
    for (const filename of ["../index.html", "untrusted.html", "_next/attack.html"]) expect(isTrustedRendererUrl(pathToFileURL(path.resolve(directory, filename)).href, directory, null)).toBe(false);
    expect(isTrustedRendererUrl(devOrigin, directory, null)).toBe(false);
  });
});

it("keeps every application IPC registration behind the common boundary", () => {
  const root = fileURLToPath(new URL("./", import.meta.url));
  const files = ["main.ts", "cli-bin-ipc.ts", ...["ipc", "collaboration"].flatMap(dir => readdirSync(path.join(root, dir)).filter(name => name.endsWith(".ts") && !name.endsWith(".test.ts")).map(name => `${dir}/${name}`))];
  for (const file of files) {
    const source = readFileSync(path.join(root, file), "utf8");
    if (/ipcMain\.(?:handle|on)\(/u.test(source)) expect(source, file).toMatch(/import \{[^\n]*ipcMain[^\n]*\} from "\.\.?\/trusted-ipc"/u);
  }
  const preview = readFileSync(path.join(root, "preview-preload.ts"), "utf8");
  expect([...preview.matchAll(/ipcRenderer\.invoke\("([^"]+)"/gu)].map(match => match[1])).toEqual(["ai-render:get-document"]);
  expect(preview).not.toContain('exposeInMainWorld("desktopAPI"');
});
