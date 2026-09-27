import type { PageGeometry, Region } from "./model";

/** Geometry with every value made finite and usable. */
export interface NormalizedPageGeometry extends PageGeometry {
  /** Distance between the tops of consecutive pages. */
  stride: number;
}

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

export function normalizePageGeometry(geometry: PageGeometry): NormalizedPageGeometry {
  const contentTop = finite(geometry.contentTop, 0);
  const contentHeight = Math.max(1, finite(geometry.contentHeight, 1));
  const pageHeight = Math.max(contentTop + contentHeight, finite(geometry.pageHeight, 0));
  const pageGap = Math.max(0, finite(geometry.pageGap, 0));
  const columnCount = Math.max(1, Math.floor(finite(geometry.columnCount, 1)));
  const contentWidth = Math.max(0, finite(geometry.contentWidth, 0));
  return {
    pageHeight,
    pageGap,
    contentTop,
    contentHeight,
    contentLeft: finite(geometry.contentLeft, 0),
    contentWidth,
    columnCount,
    columnWidth: Math.max(0, finite(geometry.columnWidth, contentWidth)),
    columnGap: Math.max(0, finite(geometry.columnGap, 0)),
    stride: pageHeight + pageGap,
  };
}

export function pageContentTop(geometry: NormalizedPageGeometry, page: number): number {
  return page * geometry.stride + geometry.contentTop;
}

export function pageContentBottom(geometry: NormalizedPageGeometry, page: number): number {
  return pageContentTop(geometry, page) + geometry.contentHeight;
}

/** Page whose content box starts at or below `y` (used to clear a tall overflow). */
export function firstPageStartingAtOrBelow(geometry: NormalizedPageGeometry, y: number, eps: number): number {
  let page = Math.max(0, Math.ceil((y - eps - geometry.contentTop) / geometry.stride));
  while (page > 0 && pageContentTop(geometry, page - 1) >= y - eps) page -= 1;
  while (pageContentTop(geometry, page) < y - eps) page += 1;
  return page;
}

/** Page that contains the canvas coordinate `y` (a y inside a page gap belongs to the page above). */
export function pageContainingY(geometry: NormalizedPageGeometry, y: number): number {
  return Math.max(0, Math.floor(y / geometry.stride));
}

/** Assigns region indices in the order the engine opens regions. */
export class RegionAllocator {
  readonly regions: Region[] = [];

  create(region: Omit<Region, "index">): Region {
    const created: Region = { ...region, index: this.regions.length };
    this.regions.push(created);
    return created;
  }

  truncate(length: number): void {
    this.regions.length = length;
  }
}

/** Ordered regions a flow can use. `null` means the flow may not continue (bounded balancing). */
export interface RegionStream {
  first(): Region;
  next(region: Region): Region | null;
  nextPage(region: Region): Region | null;
}

function clampTop(top: number, pageTop: number, pageBottom: number): number {
  return Math.min(Math.max(top, pageTop), pageBottom);
}

/** One full-width region per page. */
export class FullWidthStream implements RegionStream {
  private readonly byPage = new Map<number, Region>();

  constructor(
    private readonly allocator: RegionAllocator,
    private readonly geometry: NormalizedPageGeometry,
    private readonly startPage: number,
    private readonly startTop: number,
  ) {}

  first(): Region {
    return this.region(this.startPage);
  }

  next(region: Region): Region {
    return this.region(region.page + 1);
  }

  nextPage(region: Region): Region {
    return this.region(region.page + 1);
  }

  private region(page: number): Region {
    const existing = this.byPage.get(page);
    if (existing) return existing;
    const geometry = this.geometry;
    const pageTop = pageContentTop(geometry, page);
    const bottom = pageContentBottom(geometry, page);
    const created = this.allocator.create({
      page,
      column: -1,
      x: geometry.contentLeft,
      width: geometry.contentWidth,
      top: page === this.startPage ? clampTop(this.startTop, pageTop, bottom) : pageTop,
      bottom,
      flowKey: "root",
      parentIndex: null,
      dx: 0,
    });
    this.byPage.set(page, created);
    return created;
  }
}

/** Limits the column regions of one page to a height (column balancing). */
export interface ColumnBound {
  page: number;
  bottom: number;
}

/** Page columns in reading order: column 0..N-1 of a page, then the next page. */
export class PageColumnStream implements RegionStream {
  private readonly byKey = new Map<string, Region>();

  constructor(
    private readonly allocator: RegionAllocator,
    private readonly geometry: NormalizedPageGeometry,
    private readonly startPage: number,
    private readonly startTop: number,
    private readonly bound: ColumnBound | null,
  ) {}

  first(): Region {
    return this.region(this.startPage, 0);
  }

  next(region: Region): Region | null {
    if (region.column < this.geometry.columnCount - 1) return this.region(region.page, region.column + 1);
    return this.nextPage(region);
  }

  nextPage(region: Region): Region | null {
    if (this.bound && region.page >= this.bound.page) return null;
    return this.region(region.page + 1, 0);
  }

  private region(page: number, column: number): Region {
    const key = `${page}:${column}`;
    const existing = this.byKey.get(key);
    if (existing) return existing;
    const geometry = this.geometry;
    const pageTop = pageContentTop(geometry, page);
    const pageBottom = pageContentBottom(geometry, page);
    const bottom = this.bound && this.bound.page === page ? Math.min(pageBottom, this.bound.bottom) : pageBottom;
    const dx = column * (geometry.columnWidth + geometry.columnGap);
    const created = this.allocator.create({
      page,
      column,
      x: geometry.contentLeft + dx,
      width: geometry.columnWidth,
      top: page === this.startPage ? clampTop(this.startTop, pageTop, bottom) : pageTop,
      bottom,
      flowKey: "root",
      parentIndex: null,
      dx,
    });
    this.byKey.set(key, created);
    return created;
  }
}

/** Regions of one band column: the enclosing flow's regions narrowed to the column. */
export class BandColumnStream implements RegionStream {
  private readonly byParent = new Map<number, Region>();

  constructor(
    private readonly allocator: RegionAllocator,
    private readonly parent: RegionStream,
    private readonly startParent: Region,
    private readonly startTop: number,
    private readonly column: { key: string; xOffset: number; width: number },
  ) {}

  first(): Region {
    return this.region(this.startParent);
  }

  next(region: Region): Region | null {
    const parent = this.parent.next(this.parentOf(region));
    return parent ? this.region(parent) : null;
  }

  nextPage(region: Region): Region | null {
    const parent = this.parent.nextPage(this.parentOf(region));
    return parent ? this.region(parent) : null;
  }

  private parentOf(region: Region): Region {
    return this.allocator.regions[region.parentIndex ?? region.index];
  }

  private region(parent: Region): Region {
    const existing = this.byParent.get(parent.index);
    if (existing) return existing;
    const xOffset = Number.isFinite(this.column.xOffset) ? this.column.xOffset : 0;
    const created = this.allocator.create({
      page: parent.page,
      column: parent.column,
      x: parent.x + xOffset,
      width: Number.isFinite(this.column.width) ? Math.max(0, this.column.width) : parent.width,
      top: parent === this.startParent ? clampTop(this.startTop, parent.top, parent.bottom) : parent.top,
      bottom: parent.bottom,
      flowKey: this.column.key,
      parentIndex: parent.index,
      dx: parent.dx,
    });
    this.byParent.set(parent.index, created);
    return created;
  }
}
