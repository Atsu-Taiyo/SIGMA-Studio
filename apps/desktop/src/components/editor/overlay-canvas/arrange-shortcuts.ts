import type { OverlayArrangeAction } from "./reorder-shapes";

type ArrangeKeyboardEvent = Pick<
  KeyboardEvent,
  "altKey" | "code" | "ctrlKey" | "key" | "metaKey" | "shiftKey"
>;

/** Google Slides defaults plus PowerPoint and legacy aliases. */
export function getOverlayArrangeShortcutAction(
  event: ArrangeKeyboardEvent,
): OverlayArrangeAction | null {
  const primary = event.metaKey || event.ctrlKey;
  const closingBracket = event.key === "]" || event.key === "}" || event.code === "BracketRight";
  const openingBracket = event.key === "[" || event.key === "{" || event.code === "BracketLeft";

  if (primary && !event.altKey) {
    if (event.key === "ArrowUp") {
      return event.shiftKey ? "front" : "forward";
    }
    if (event.key === "ArrowDown") {
      return event.shiftKey ? "back" : "backward";
    }
    if (closingBracket) {
      return event.shiftKey ? "front" : "forward";
    }
    if (openingBracket) {
      return event.shiftKey ? "back" : "backward";
    }
  }

  if (!primary && !event.shiftKey) {
    if (closingBracket) {
      return event.altKey ? "forward" : "front";
    }
    if (openingBracket) {
      return event.altKey ? "backward" : "back";
    }
  }

  return null;
}

export function overlayArrangeActionAllowsRepeat(
  action: OverlayArrangeAction,
): boolean {
  return action === "forward" || action === "backward";
}
