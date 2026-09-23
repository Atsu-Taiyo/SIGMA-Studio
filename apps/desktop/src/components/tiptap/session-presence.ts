import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type {
  DocumentSession,
  SessionTextPoint,
} from "@/features/document-session/contracts";

export const sessionPresenceKey = new PluginKey("sessionPresence");
/** Presentation only: the host resolves ephemeral cursors against its authoritative text. */
export const SessionPresenceExtension = Extension.create<{
  session: () => DocumentSession | undefined;
}>({
  name: "sessionPresence",
  addOptions: () => ({ session: () => undefined }),
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: sessionPresenceKey,
        props: {
          decorations: (state) => {
            const peers = this.options.session()?.remoteSelections?.() ?? [];
            if (!peers.length) return DecorationSet.empty;
            const positions = new Map<
              string,
              { start: number; size: number }
            >();
            state.doc.descendants((node, pos) => {
              if (node.isTextblock && typeof node.attrs.sigmaDocId === "string")
                positions.set(node.attrs.sigmaDocId, {
                  start: pos + 1,
                  size: node.content.size,
                });
            });
            const resolve = (point: SessionTextPoint): number | undefined => {
              const block = positions.get(point.blockId);
              return (
                block &&
                block.start + Math.max(0, Math.min(point.offset, block.size))
              );
            };
            const decorations: Decoration[] = [];
            for (const peer of peers) {
              const anchor = resolve(peer.anchor),
                head = resolve(peer.head);
              if (head === undefined) continue;
              if (anchor !== undefined && anchor !== head)
                decorations.push(
                  Decoration.inline(
                    Math.min(anchor, head),
                    Math.max(anchor, head),
                    { class: "session-peer-selection" },
                  ),
                );
              decorations.push(
                Decoration.widget(
                  head,
                  (view) => {
                    const caret = view.dom.ownerDocument.createElement("span");
                    caret.className = "session-peer-caret";
                    caret.setAttribute("aria-hidden", "true");
                    return caret;
                  },
                  { key: peer.actorId, side: 1 },
                ),
              );
            }
            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});
