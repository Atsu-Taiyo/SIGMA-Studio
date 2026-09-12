"use client";

import { Loader2, MoreHorizontal, PlusCircle, Search, X } from "lucide-react";

import { MaterialContentPreview, MaterialPreview } from "@/components/editor/MaterialPreview";
import { useT } from "@/lib/i18n/react";
import { isOfficialMaterial } from "@/lib/official-materials";
import { InfoDialog, MaterialActionMenu, MaterialEditDialog, MaterialMetadataDraftFields } from "./material-dialogs";
import type { MaterialLibraryController } from "./use-material-library-controller";

/** 素材 UI の表示とイベント接続。文書や repository の所有は controller に委ねる。 */
export function MaterialLibraryDialogs({ controller }: { controller: MaterialLibraryController }) {
  const tE = useT("editor");
  const {
    materialLibraryOpen,
    setMaterialLibraryOpen,
    materialNameDraft,
    setMaterialNameDraft,
    materialDescriptionDraft,
    setMaterialDescriptionDraft,
    materialsLoading,
    saveSelectedMaterial,
    materialSearch,
    setMaterialSearch,
    materialError,
    materials,
    visibleMaterials,
    materialActionMenu,
    openMaterialActionMenu,
    materialActionMenuItem,
    insertMaterialFromDialog,
    startEditingMaterial,
    deleteMaterial,
    materialEditingItem,
    materialEditingContent,
    materialEditingDraft,
    updateMaterialEditingContent,
    setMaterialEditingDraft,
    renameMaterial,
    closeMaterialEditing,
    setMaterialMetadataInfoOpen,
    materialMetadataInfoOpen,
    materialAddDialogOpen,
    materialAddContent,
    closeMaterialAddDialog,
    materialAddName,
    setMaterialAddName,
    confirmMaterialAddDialog,
    materialAddDraft,
    setMaterialAddDraft,
  } = controller;

  return (
    <>
      {materialLibraryOpen && (
        <div className="material-library-backdrop" data-modal-backdrop="" role="presentation" onPointerDown={() => setMaterialLibraryOpen(false)}>
          <section
            className="material-library-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={tE("material.title")}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <header className="material-library-header">
              <div>
                <h2>{tE("material.title")}</h2>
                <p>{tE("material.libraryDescription")}</p>
              </div>
              <button type="button" className="icon-button" title={tE("common.close")} aria-label={tE("common.close")} onClick={() => setMaterialLibraryOpen(false)}>
                <X size={16} />
              </button>
            </header>
            <div className="material-library-create">
              <input
                type="text"
                value={materialNameDraft}
                placeholder={tE("material.name")}
                aria-label={tE("material.name")}
                onChange={(event) => setMaterialNameDraft(event.target.value)}
              />
              <input
                type="text"
                value={materialDescriptionDraft}
                placeholder={tE("material.usage")}
                aria-label={tE("material.usageAria")}
                onChange={(event) => setMaterialDescriptionDraft(event.target.value)}
              />
              <button type="button" className="button primary" disabled={materialsLoading} onClick={() => void saveSelectedMaterial()}>
                {materialsLoading ? <Loader2 className="save-state-spinner" size={14} /> : <PlusCircle size={15} />}
                {tE("material.saveSelection")}
              </button>
            </div>
            <div className="material-library-search">
              <Search size={15} />
              <input
                type="search"
                value={materialSearch}
                placeholder={tE("material.search")}
                aria-label={tE("material.search")}
                onChange={(event) => setMaterialSearch(event.target.value)}
              />
            </div>
            {materialError && <p className="material-library-error" role="alert">{materialError}</p>}
            <div className="material-library-list">
              {materialsLoading && materials.length === 0 ? (
                <div className="material-library-empty">{tE("material.loading")}</div>
              ) : visibleMaterials.length === 0 ? (
                <div className="material-library-empty">{tE("material.empty")}</div>
              ) : (
                  visibleMaterials.map((material) => (
                    <article className="material-library-item" key={material.id}>
                      <MaterialPreview material={material} />
                      <div className="material-library-item-main">
                        <div className="material-library-item-title">
                          <strong>{material.name}</strong>
                          {isOfficialMaterial(material) && <span className="material-library-official-badge">{tE("material.official")}</span>}
                        </div>
                        {material.description && (
                          <p className="material-library-item-desc">{material.description}</p>
                        )}
                        {material.tags && material.tags.length > 0 && (
                          <div className="material-library-item-tags">
                            {material.tags.slice(0, 4).map((tag) => (
                              <span className="material-library-tag" key={tag}>{tag}</span>
                            ))}
                          </div>
                        )}
                        {material.visualConcepts && material.visualConcepts.length > 0 && (
                          <div className="material-library-item-tags">
                            {material.visualConcepts.slice(0, 4).map((concept) => (
                              <span className="material-library-tag semantic" key={concept}>{concept}</span>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="material-library-item-actions">
                        <button
                          type="button"
                          className="icon-button small"
                          title={tE("material.actions")}
                          aria-label={tE("material.actionsFor", { name: material.name })}
                          aria-haspopup="menu"
                          aria-expanded={materialActionMenu?.materialId === material.id}
                          onClick={(event) => openMaterialActionMenu(event, material)}
                        >
                          <MoreHorizontal size={14} />
                        </button>
                      </div>
                    </article>
                  ))
              )}
            </div>
          </section>
        </div>
      )}

      {materialLibraryOpen && materialActionMenu && materialActionMenuItem && (
        <MaterialActionMenu
          material={materialActionMenuItem}
          x={materialActionMenu.x}
          y={materialActionMenu.y}
          onInsert={insertMaterialFromDialog}
          onRename={startEditingMaterial}
          onDelete={deleteMaterial}
        />
      )}

      {materialLibraryOpen && materialEditingItem && materialEditingContent && !isOfficialMaterial(materialEditingItem) && (
        <MaterialEditDialog
          material={materialEditingItem}
          content={materialEditingContent}
          draft={materialEditingDraft}
          saving={materialsLoading}
          onContentChange={updateMaterialEditingContent}
          onDraftChange={setMaterialEditingDraft}
          onSave={() => void renameMaterial(materialEditingItem)}
          onClose={closeMaterialEditing}
          onOpenInfo={() => setMaterialMetadataInfoOpen(true)}
        />
      )}

      {materialMetadataInfoOpen && (
        <InfoDialog
          title={tE("material.aiInfo")}
          onClose={() => setMaterialMetadataInfoOpen(false)}
        >
          <p>{tE("material.aiInfoRead")}</p>
          <p>{tE("material.aiInfoExample")}</p>
          <p>{tE("material.aiInfoContent")}</p>
        </InfoDialog>
      )}

      {materialAddDialogOpen && materialAddContent && (
        <div className="material-add-backdrop" data-modal-backdrop="" role="presentation" onPointerDown={closeMaterialAddDialog}>
          <section
            className="material-add-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={tE("material.add")}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <header className="material-add-header">
              <div>
                <h2>{tE("material.add")}</h2>
                <p>{tE("material.addDescription")}</p>
              </div>
              <button type="button" className="icon-button" title={tE("common.close")} aria-label={tE("common.close")} onClick={closeMaterialAddDialog}>
                <X size={16} />
              </button>
            </header>
            <div className="material-add-body">
              <MaterialContentPreview content={materialAddContent} title={materialAddName || tE("material.title")} />
              <label className="material-add-name-field">
                <span>{tE("material.name")}</span>
                <input
                  type="text"
                  value={materialAddName}
                  aria-label={tE("material.name")}
                  autoFocus
                  onChange={(event) => setMaterialAddName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void confirmMaterialAddDialog();
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      closeMaterialAddDialog();
                    }
                  }}
                />
              </label>
              <MaterialMetadataDraftFields
                value={{ ...materialAddDraft, name: materialAddName }}
                onChange={(nextDraft) => {
                  setMaterialAddName(nextDraft.name);
                  setMaterialAddDraft(nextDraft);
                }}
                hideName
              />
              {materialError && <p className="material-library-error" role="alert">{materialError}</p>}
            </div>
            <footer className="material-add-actions">
              <button type="button" className="button secondary" onClick={closeMaterialAddDialog}>
                {tE("common.cancel")}
              </button>
              <button type="button" className="button primary" disabled={materialsLoading} onClick={() => void confirmMaterialAddDialog()}>
                {materialsLoading ? <Loader2 className="save-state-spinner" size={14} /> : <PlusCircle size={15} />}
                {tE("material.add")}
              </button>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}
