"use client";

import { DocumentTitleText } from "@/features/rendering/adapters/react";
import { collectOutline } from "@/lib/document-tree";
import { type Translate } from "@/lib/i18n";
import { X } from "lucide-react";
import type { ComponentProps } from "react";

interface EditorOutlineDialogProps {
  outlineDialogOpen: boolean;
  resolvedDocumentTitle: string;
  titleNodes: ComponentProps<typeof DocumentTitleText>["nodes"];
  outline: ReturnType<typeof collectOutline>;
  outlineHeadingNumbers: ReadonlyMap<string, string>;
  selectedId: string | null;
  selectOutlineItem: (blockId: string) => void;
  onClose: () => void;
  tE: Translate<"editor">;
}
export function EditorOutlineDialog({ outlineDialogOpen, resolvedDocumentTitle, titleNodes, outline, outlineHeadingNumbers, selectedId, selectOutlineItem, onClose, tE }: EditorOutlineDialogProps) {
  return <>
      {outlineDialogOpen && (
        <div className="outline-dialog-backdrop" data-modal-backdrop="" role="presentation" onPointerDown={() => onClose()}>
          <section
            className="outline-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={tE("outline.title")}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <header className="outline-dialog-header">
              <div>
                <h2>{tE("outline.title")}</h2>
                <p title={resolvedDocumentTitle}><DocumentTitleText title={resolvedDocumentTitle} nodes={titleNodes} /></p>
              </div>
              <button type="button" className="icon-button" title={tE("common.close")} aria-label={tE("common.close")} onClick={() => onClose()}>
                <X size={16} />
              </button>
            </header>
            <nav className="outline-dialog-list">
              {outline.length === 0 ? (
                <p className="outline-dialog-empty">{tE("outline.empty")}</p>
              ) : outline.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={selectedId === item.id ? "selected" : ""}
                  onClick={() => selectOutlineItem(item.id)}
                >
                  <span>
                    {(item.type === "section" || item.type === "heading") && outlineHeadingNumbers.get(item.id) ? (
                      <span className="heading-number-prefix">
                        {outlineHeadingNumbers.get(item.id)}{" "}
                      </span>
                    ) : null}
                    {item.title}
                  </span>
                  <code>{item.type}</code>
                </button>
              ))}
            </nav>
          </section>
        </div>
      )}

  </>;
}
