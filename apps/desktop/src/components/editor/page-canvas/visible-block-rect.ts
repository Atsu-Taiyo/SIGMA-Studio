import { readFragmentClientRect } from "./layout-snapshot";

/** Screen geometry for interaction only; pagination still measures the full source block. */
export function visibleBlockClientRect(element: HTMLElement): DOMRect | null {
  const rect = element.getBoundingClientRect();
  let top = rect.top;
  let bottom = rect.bottom;
  let left = rect.left;
  let right = rect.right;
  for (let owner: HTMLElement | null = element; owner; owner = owner.parentElement) {
    if (owner.matches('.editor-box-fragment-viewport')) {
      const viewport = readFragmentClientRect(owner, owner.dataset.boxSourceId ?? "", Number(owner.dataset.boxFragmentIndex))
        ?? owner.getBoundingClientRect();
      top = Math.max(top, viewport.top);
      bottom = Math.min(bottom, viewport.bottom);
      left = Math.max(left, viewport.left);
      right = Math.min(right, viewport.right);
    }
    if (owner.hasAttribute('data-box-fragment-source-id')) {
      const published = readFragmentClientRect(owner, owner.dataset.boxFragmentSourceId ?? "", 0);
      if (published) {
        top = Math.max(top, published.top);
        bottom = Math.min(bottom, published.bottom);
        left = Math.max(left, published.left);
        right = Math.min(right, published.right);
        continue;
      }
      const source = owner.getBoundingClientRect();
      const height = Number.parseFloat(getComputedStyle(owner).getPropertyValue('--text-flow-box-fragment-visible-height'));
      const scale = owner.offsetHeight > 0 ? source.height / owner.offsetHeight : 1;
      if (Number.isFinite(height)) {
        top = Math.max(top, source.top);
        bottom = Math.min(bottom, source.top + height * scale);
      }
    }
  }
  return bottom > top && right > left ? new DOMRect(left, top, right - left, bottom - top) : null;
}
