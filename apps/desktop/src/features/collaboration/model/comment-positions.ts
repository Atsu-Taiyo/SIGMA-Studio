import * as Y from "yjs";
import { richText, readRichFragment } from "./rich-text";
import { fromBase64, toBase64 } from "./protocol";
import { isObject, sameValue, type ObjectValue } from "./value";

type Positions = { start: string; end: string };
export function recordCommentPositions(
  map: Y.Map<Positions>,
  before: ObjectValue,
  after: ObjectValue,
  getFragment: (id: string) => Y.XmlFragment | undefined,
): void {
  const previous = new Map(
    (Array.isArray(before.comments) ? before.comments : [])
      .filter(isObject)
      .map((comment) => [comment.id, comment]),
  );
  for (const comment of Array.isArray(after.comments) ? after.comments : []) {
    if (
      !isObject(comment) ||
      typeof comment.id !== "string" ||
      !isObject(comment.anchor) ||
      comment.anchor.type !== "textRange"
    )
      continue;
    if (
      sameValue(previous.get(comment.id)?.anchor, comment.anchor) &&
      map.has(comment.id)
    )
      continue;
    const positions: Partial<Positions> = {};
    for (const side of ["start", "end"] as const) {
      const endpoint = comment.anchor[side];
      if (
        !isObject(endpoint) ||
        typeof endpoint.blockId !== "string" ||
        typeof endpoint.offset !== "number"
      )
        continue;
      const fragment = getFragment(endpoint.blockId);
      if (!fragment) continue;
      let textOffset = 0;
      let yOffset = 0;
      for (const node of readRichFragment(fragment)) {
        const length =
          node.type === "text"
            ? String(node.text).length
            : String(node.tex).length + 2;
        if (textOffset + length >= endpoint.offset) {
          yOffset +=
            node.type === "text"
              ? Math.max(0, endpoint.offset - textOffset)
              : endpoint.offset > textOffset
                ? 1
                : 0;
          break;
        }
        textOffset += length;
        yOffset += node.type === "text" ? length : 1;
      }
      positions[side] = toBase64(
        Y.encodeRelativePosition(
          Y.createRelativePositionFromTypeIndex(
            richText(fragment),
            yOffset,
            side === "end" ? -1 : 0,
          ),
        ),
      );
    }
    if (positions.start && positions.end)
      map.set(comment.id, positions as Positions);
  }
}
export function resolveCommentPositions(
  map: Y.Map<Positions>,
  document: ObjectValue,
  doc: Y.Doc,
): void {
  for (const comment of Array.isArray(document.comments)
    ? document.comments
    : []) {
    if (
      !isObject(comment) ||
      typeof comment.id !== "string" ||
      !isObject(comment.anchor) ||
      comment.anchor.type !== "textRange"
    )
      continue;
    const positions = map.get(comment.id);
    if (!positions) continue;
    for (const side of ["start", "end"] as const) {
      const endpoint = comment.anchor[side];
      if (!isObject(endpoint)) continue;
      const position = Y.createAbsolutePositionFromRelativePosition(
        Y.decodeRelativePosition(fromBase64(positions[side], 4096)),
        doc,
      );
      if (!position || !(position.type instanceof Y.XmlText)) continue;
      let yOffset = 0;
      let textOffset = 0;
      for (const item of position.type.toDelta()) {
        const length = typeof item.insert === "string" ? item.insert.length : 1;
        const node =
          item.insert instanceof Y.Map ? item.insert.get("node") : item.insert;
        const visible =
          typeof item.insert === "string"
            ? length
            : isObject(node)
              ? String(node.tex).length + 2
              : 0;
        if (yOffset + length >= position.index) {
          textOffset +=
            typeof item.insert === "string"
              ? position.index - yOffset
              : position.index > yOffset
                ? visible
                : 0;
          break;
        }
        yOffset += length;
        textOffset += visible;
      }
      endpoint.offset = textOffset;
    }
  }
}
