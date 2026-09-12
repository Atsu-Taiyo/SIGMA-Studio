import { inferDefaultMaterialPorts, normalizeMaterialMetadata } from "@/lib/materials";
import { isOfficialMaterial, mergeOfficialMaterials } from "@/lib/official-materials";
import type { MaterialRepository } from "@/lib/runtime/types";
import type { MaterialContent, MaterialItem } from "@/types/material";
import {
  createEmptyMaterialMetadataDraft,
  materialMetadataDraftToInput,
  type MaterialMetadataDraft,
} from "./material-metadata-draft";

type MaterialLibraryMessageKey =
  | "status.materialsLoadFailed"
  | "status.materialSaveFailed"
  | "status.materialDeleteFailed"
  | "status.officialMaterialRename"
  | "status.officialMaterialDelete"
  | "status.materialNeedsContent";

interface MaterialLibraryPorts {
  getRepository(): MaterialRepository;
  setMaterials(value: MaterialItem[] | ((current: MaterialItem[]) => MaterialItem[])): void;
  setLoading(loading: boolean): void;
  setError(error: string | null): void;
  translate(key: MaterialLibraryMessageKey): string;
}

/**
 * 素材 repository と一覧の同期を担当する。素材 controller が UI と接続し、文書の履歴は shell が所有する。
 * 完了通知も try/finally 内で呼び、一覧更新→dialog close→error/status→loading の順序を保つ。
 * repository と翻訳は実行時に取得し、待機中の runtime/言語変更を先取りしない。
 */
export async function loadMaterialLibrary(ports: MaterialLibraryPorts): Promise<void> {
  ports.setLoading(true);
  try {
    const materials = await ports.getRepository().listMaterials();
    ports.setMaterials(mergeOfficialMaterials(materials));
    ports.setError(null);
  } catch (error) {
    ports.setError(error instanceof Error ? error.message : ports.translate("status.materialsLoadFailed"));
  } finally {
    ports.setLoading(false);
  }
}

export async function createLibraryMaterial(
  request: {
    content: MaterialContent;
    requestedName: string;
    fallbackName(): string;
    metadataDraft?: MaterialMetadataDraft;
  },
  ports: MaterialLibraryPorts & { onCreated(): void },
): Promise<MaterialItem | null> {
  const { content, metadataDraft } = request;
  const fallbackName = request.fallbackName();
  const name = request.requestedName.trim() || fallbackName;
  ports.setLoading(true);
  try {
    const metadata = normalizeMaterialMetadata({
      ...materialMetadataDraftToInput(metadataDraft ?? createEmptyMaterialMetadataDraft()),
      transformPolicy: content.overlaySnapshot.shapes.length > 0 ? { scale: true, rotate: false } : undefined,
      ports: content.overlaySnapshot.shapes.length > 0 ? inferDefaultMaterialPorts(content) : undefined,
    });
    const material = await ports.getRepository().createMaterial({ name, ...metadata, content });
    ports.setMaterials((current) => mergeOfficialMaterials([
      material,
      ...current.filter((item) => !isOfficialMaterial(item) && item.id !== material.id),
    ]));
    ports.setError(null);
    ports.onCreated();
    return material;
  } catch (error) {
    ports.setError(error instanceof Error ? error.message : ports.translate("status.materialSaveFailed"));
    return null;
  } finally {
    ports.setLoading(false);
  }
}

export async function updateLibraryMaterial(
  material: MaterialItem,
  readEdit: () => { draft: MaterialMetadataDraft; content: MaterialContent },
  ports: MaterialLibraryPorts & { closeEditing(): void; closeMenu(): void; onUpdated(): void },
): Promise<void> {
  if (isOfficialMaterial(material)) {
    ports.setError(ports.translate("status.officialMaterialRename"));
    ports.closeEditing();
    ports.closeMenu();
    return;
  }

  // 素材 controller が overlay の保留編集を flush し、同じ call stack で最新の ref を読む。
  const { draft, content } = readEdit();
  const name = draft.name.trim();
  if (!name) {
    return;
  }
  if (content.blocks.length === 0 && content.overlaySnapshot.shapes.length === 0) {
    ports.setError(ports.translate("status.materialNeedsContent"));
    return;
  }

  ports.setLoading(true);
  try {
    const nextMaterial = await ports.getRepository().updateMaterialMetadata(material.id, {
      name,
      ...materialMetadataDraftToInput(draft),
      content,
    });
    ports.setMaterials((current) => current.map((item) => item.id === nextMaterial.id ? nextMaterial : item));
    ports.closeEditing();
    ports.closeMenu();
    ports.setError(null);
    ports.onUpdated();
  } catch (error) {
    ports.setError(error instanceof Error ? error.message : ports.translate("status.materialSaveFailed"));
  } finally {
    ports.setLoading(false);
  }
}

export async function deleteLibraryMaterial(
  material: MaterialItem,
  ports: MaterialLibraryPorts & { closeMenu(): void },
): Promise<void> {
  if (isOfficialMaterial(material)) {
    ports.setError(ports.translate("status.officialMaterialDelete"));
    ports.closeMenu();
    return;
  }
  ports.setLoading(true);
  try {
    const result = await ports.getRepository().deleteMaterial(material.id);
    if (!result.ok) {
      throw new Error(result.error ?? ports.translate("status.materialDeleteFailed"));
    }
    ports.setMaterials((current) => current.filter((item) => item.id !== material.id));
    ports.closeMenu();
    ports.setError(null);
  } catch (error) {
    ports.setError(error instanceof Error ? error.message : ports.translate("status.materialDeleteFailed"));
  } finally {
    ports.setLoading(false);
  }
}
