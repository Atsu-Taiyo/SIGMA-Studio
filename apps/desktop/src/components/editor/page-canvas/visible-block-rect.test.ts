// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { visibleBlockClientRect } from './visible-block-rect';
import { measureDragUnit, measureDragUnitPieces } from './block-drag-dom';
import { resolveBlockOwnerOf } from './pointer-targets';

function rect(element: HTMLElement, top: number, height: number) {
  element.getBoundingClientRect = () => new DOMRect(20, top, 200, height);
  Object.defineProperty(element, 'offsetHeight', { value: height, configurable: true });
}
function fixture() {
  const canvas = document.createElement('div');
  document.body.append(canvas);
  canvas.innerHTML = `<section data-problem-id="problem" data-problem-area="prompt">
    <ol data-sigma-doc-id="list" data-box-fragment-source-id="list" style="--text-flow-box-fragment-visible-height:100px">
      <li><p data-sigma-doc-id="item">row</p></li>
    </ol></section>
    <div class="page-box-fragment-layer"><div class="editor-box-fragment-viewport" data-box-source-id="list">
      <ol data-sigma-doc-id="list"><li><p data-sigma-doc-id="item">row</p></li></ol>
    </div></div>`;
  const [source, copy] = Array.from(canvas.querySelectorAll<HTMLElement>('ol'));
  const [sourceRow, copyRow] = Array.from(canvas.querySelectorAll<HTMLElement>('p'));
  const viewport = canvas.querySelector<HTMLElement>('.editor-box-fragment-viewport')!;
  rect(canvas, 0, 1000);
  rect(source, 100, 300); rect(sourceRow, 300, 100); rect(sourceRow.parentElement!, 300, 100);
  rect(viewport, 600, 200); rect(copy, 500, 300); rect(copyRow, 700, 100); rect(copyRow.parentElement!, 700, 100);
  return { canvas, source, sourceRow, copyRow, viewport };
}
afterEach(() => document.body.replaceChildren());
describe('visible fragment interaction geometry', () => {
  it('excludes a row hidden in the source and measures its continuation', () => {
    const { canvas, sourceRow, copyRow } = fixture();
    expect(visibleBlockClientRect(sourceRow)).toBeNull();
    expect(visibleBlockClientRect(copyRow)?.top).toBe(700);
    expect(measureDragUnit(canvas, 'item', 'listItem')?.ownBox).toMatchObject({ top: 700, bottom: 800 });
  });
  it('selects only the visible copy at the pointer, never the gap between pages', () => {
    const { canvas, sourceRow, copyRow } = fixture();
    rect(sourceRow, 150, 120); rect(sourceRow.parentElement!, 150, 120);
    rect(copyRow, 550, 200); rect(copyRow.parentElement!, 550, 200);
    expect(measureDragUnit(canvas, 'item', 'listItem', 175)?.box).toMatchObject({ top: 150, bottom: 200 });
    expect(measureDragUnit(canvas, 'item', 'listItem', 650)?.box).toMatchObject({ top: 600, bottom: 750 });
    expect(measureDragUnit(canvas, 'item', 'listItem', 175)?.hasVisibleEnd).toBe(false);
    expect(measureDragUnit(canvas, 'item', 'listItem', 650)?.hasVisibleEnd).toBe(true);
    expect(measureDragUnitPieces(canvas, 'item', 'listItem').map(({ box }) => [box.top, box.bottom]))
      .toEqual([[150, 200], [600, 750]]);
  });
  it('maps the continuation to its SigmaDoc problem while retaining the visible viewport', () => {
    const { canvas, copyRow, viewport } = fixture();
    expect(resolveBlockOwnerOf(canvas, copyRow)).toEqual({ id: 'problem', element: viewport, isProblem: true });
  });
  it('scales source clipping at 150 percent zoom', () => {
    const { source, sourceRow } = fixture();
    source.getBoundingClientRect = () => new DOMRect(20, 100, 300, 450);
    rect(sourceRow, 200, 100);
    expect(visibleBlockClientRect(sourceRow)?.bottom).toBe(250);
  });
});
