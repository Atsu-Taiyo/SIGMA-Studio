import { contextBridge, ipcRenderer } from "electron";

// A hidden AI page has no storage, filesystem, CLI, collaboration or shell capability.
contextBridge.exposeInMainWorld("sigmaPreviewAPI", {
  getRenderDocument: (renderId: string) => ipcRenderer.invoke("ai-render:get-document", renderId),
});
