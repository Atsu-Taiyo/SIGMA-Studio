export interface PageBreakMarkerActivationEvent {
  preventDefault: () => void;
  stopPropagation: () => void;
}

export interface PageBreakMarkerMouseDownEvent extends PageBreakMarkerActivationEvent {
  button: number;
}

export interface PageBreakMarkerClickEvent extends PageBreakMarkerActivationEvent {
  detail: number;
}

export interface PageBreakMarkerContentOptions {
  labelText: string;
  removeLabel?: string;
  removeButtonLabel?: string;
  onRemove?: () => void;
}

/**
 * Pointer activation is committed on left mousedown, before ProseMirror can
 * replace a widget between mousedown and click. Other buttons remain untouched
 * so the page canvas can keep handling the marker's context menu.
 */
export function activatePageBreakMarkerOnMouseDown(
  event: PageBreakMarkerMouseDownEvent,
  onRemove: () => void,
): void {
  if (event.button !== 0) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  onRemove();
}

/**
 * Native button keyboard activation and assistive `click()` use detail=0.
 * Pointer clicks were already committed on mousedown and must not run twice.
 */
export function activatePageBreakMarkerOnClick(
  event: PageBreakMarkerClickEvent,
  onRemove: () => void,
): void {
  event.preventDefault();
  event.stopPropagation();
  if (event.detail === 0) {
    onRemove();
  }
}

/** Creates the shared marker content for ProseMirror's imperative widget DOM. */
export function createPageBreakMarkerContent(
  marker: HTMLElement,
  {
    labelText,
    removeLabel,
    removeButtonLabel,
    onRemove,
  }: PageBreakMarkerContentOptions,
): void {
  const before = document.createElement("span");
  const label = document.createElement("strong");
  const after = document.createElement("span");
  label.textContent = labelText;

  marker.append(before, label, after);
  if (!removeLabel || !onRemove) {
    return;
  }

  const button = document.createElement("button");
  button.type = "button";
  button.className = "page-break-marker-remove";
  button.textContent = removeButtonLabel ?? removeLabel;
  button.setAttribute("aria-label", removeLabel);
  button.addEventListener("mousedown", (event) => {
    activatePageBreakMarkerOnMouseDown(event, onRemove);
  });
  button.addEventListener("click", (event) => {
    activatePageBreakMarkerOnClick(event, onRemove);
  });
  marker.append(button);
}
