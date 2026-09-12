import { ipcMain } from "electron";

import { LocalMaterialStore } from "../local-material-store";
import { LocalTemplateStore } from "../local-template-store";

export interface RegisterMaterialsIpcDeps {
  localMaterialStore: LocalMaterialStore;
  localTemplateStore: LocalTemplateStore;
}

export function registerMaterialsIpc(deps: RegisterMaterialsIpcDeps): void {
  const { localMaterialStore, localTemplateStore } = deps;

  ipcMain.handle("materials:list", async () => {
    return localMaterialStore.listMaterials();
  });

  ipcMain.handle("materials:create", async (_event, input: Parameters<LocalMaterialStore["createMaterial"]>[0]) => {
    return localMaterialStore.createMaterial(input);
  });

  ipcMain.handle("materials:rename", async (_event, id: string, name: string) => {
    return localMaterialStore.renameMaterial(id, name);
  });

  ipcMain.handle("materials:update-metadata", async (_event, id: string, input: Parameters<LocalMaterialStore["updateMaterialMetadata"]>[1]) => {
    return localMaterialStore.updateMaterialMetadata(id, input);
  });

  ipcMain.handle("materials:delete", async (_event, id: string) => {
    return localMaterialStore.deleteMaterial(id);
  });

  ipcMain.handle("templates:list", async (_event, workspaceId?: string | null) => {
    return localTemplateStore.listTemplates(workspaceId ?? null);
  });

  ipcMain.handle("templates:create", async (_event, input: Parameters<LocalTemplateStore["createTemplate"]>[0]) => {
    return localTemplateStore.createTemplate(input);
  });

  ipcMain.handle("templates:rename", async (_event, id: string, name: string) => {
    return localTemplateStore.renameTemplate(id, name);
  });

  ipcMain.handle("templates:delete", async (_event, id: string) => {
    return localTemplateStore.deleteTemplate(id);
  });
}
