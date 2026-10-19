import { describe, expect, it } from "vitest";
import {
  avatarCropPlacement,
  avatarCropZoom,
  avatarSliderFromZoom,
  avatarZoomFromSlider,
  avatarZoomRange,
  clampAvatarCrop,
  dragAvatarCrop,
  initialAvatarCrop,
  zoomAvatarCrop,
} from "./avatar-crop";

const landscape = { width: 1200, height: 800 };
const portrait = { width: 600, height: 900 };

describe("avatar crop", () => {
  it("starts from the centred square that fills the short side", () => {
    expect(initialAvatarCrop(landscape)).toEqual({ x: 200, y: 0, size: 800 });
    expect(initialAvatarCrop(portrait)).toEqual({ x: 0, y: 150, size: 600 });
    expect(avatarCropZoom(landscape, initialAvatarCrop(landscape))).toBe(1);
  });

  it("lets the short side cover the frame at least, and caps the zoom by the source pixels", () => {
    expect(avatarZoomRange(landscape)).toEqual({ min: 1, max: 8 });
    // 短い辺 96px なら、32px 四方 (3倍) まで。
    expect(avatarZoomRange({ width: 160, height: 96 })).toEqual({ min: 1, max: 3 });
    // 32px 以下の画像は拡大しない。
    expect(avatarZoomRange({ width: 20, height: 30 })).toEqual({ min: 1, max: 1 });
    // 枠より小さくはできない (縮小は短い辺いっぱいで止まる)。
    expect(clampAvatarCrop(landscape, { x: 0, y: 0, size: 5000 })).toEqual({ x: 0, y: 0, size: 800 });
    expect(clampAvatarCrop(landscape, { x: 0, y: 0, size: 1 })).toEqual({ x: 0, y: 0, size: 100 });
  });

  it("keeps the square inside the picture", () => {
    expect(clampAvatarCrop(landscape, { x: -50, y: 30, size: 800 })).toEqual({ x: 0, y: 0, size: 800 });
    expect(clampAvatarCrop(landscape, { x: 900, y: 700, size: 400 })).toEqual({ x: 800, y: 400, size: 400 });
    expect(clampAvatarCrop(landscape, { x: Number.NaN, y: Number.POSITIVE_INFINITY, size: Number.NaN })).toEqual({ x: 0, y: 0, size: 800 });
    expect(clampAvatarCrop({ width: 0, height: 10 }, { x: 0, y: 0, size: 10 })).toEqual({ x: 0, y: 0, size: 0 });
  });

  it("moves the picture with the pointer and stops at the edges without drifting", () => {
    const start = initialAvatarCrop(landscape);
    // 画像を枠の 1/8 だけ右へ動かすと、範囲は 100px 左へ寄る。
    expect(dragAvatarCrop(landscape, start, 0.125, 0)).toEqual({ x: 100, y: 0, size: 800 });
    // 端を越えて動かしても範囲は画像の左端で止まり、戻せば同じ場所に戻る。
    expect(dragAvatarCrop(landscape, start, 2, 0)).toEqual({ x: 0, y: 0, size: 800 });
    expect(dragAvatarCrop(landscape, start, 0, 0)).toEqual(start);
    // 縦長の写真は上下に動かせる (顔を枠に合わせる)。
    expect(dragAvatarCrop(portrait, initialAvatarCrop(portrait), 0, 0.25)).toEqual({ x: 0, y: 0, size: 600 });
    expect(dragAvatarCrop(portrait, initialAvatarCrop(portrait), 0, -0.1)).toEqual({ x: 0, y: 210, size: 600 });
  });

  it("zooms around the frame centre or the pointer and clamps to the picture", () => {
    const start = initialAvatarCrop(landscape);
    // 真ん中を止めて 2 倍。
    expect(zoomAvatarCrop(landscape, start, 2)).toEqual({ x: 400, y: 200, size: 400 });
    // 左上の角を止めて 2 倍。
    expect(zoomAvatarCrop(landscape, start, 2, { x: 0, y: 0 })).toEqual({ x: 200, y: 0, size: 400 });
    // 右下を止めて 4 倍にすると、その下の点が動かない。
    const zoomed = zoomAvatarCrop(landscape, start, 4, { x: 1, y: 1 });
    expect(zoomed).toEqual({ x: 800, y: 600, size: 200 });
    // 上限・下限を越える拡大率は丸める。
    expect(avatarCropZoom(landscape, zoomAvatarCrop(landscape, start, 100))).toBe(8);
    expect(zoomAvatarCrop(landscape, zoomed, 0.1)).toEqual({ x: 400, y: 0, size: 800 });
  });

  it("places the picture relative to the frame", () => {
    expect(avatarCropPlacement(landscape, { x: 200, y: 0, size: 800 })).toEqual({ left: -0.25, top: -0, width: 1.5, height: 1 });
    expect(avatarCropPlacement(portrait, { x: 150, y: 300, size: 300 })).toEqual({ left: -0.5, top: -1, width: 2, height: 3 });
  });

  it("maps the slider on a log scale", () => {
    expect(avatarZoomFromSlider(landscape, 0)).toBe(1);
    expect(avatarZoomFromSlider(landscape, 1)).toBe(8);
    expect(avatarZoomFromSlider(landscape, 1 / 3)).toBeCloseTo(2);
    expect(avatarSliderFromZoom(landscape, 4)).toBeCloseTo(2 / 3);
    expect(avatarSliderFromZoom({ width: 20, height: 20 }, 1)).toBe(0);
  });
});
