// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as bridgeModule from "@/lib/desktop-bridge";
import type { AvatarCrop } from "../model/avatar-crop";
import type { AvatarSource } from "./avatar-image";
import { CollaborationAvatarCropDialog } from "./CollaborationAvatarCropDialog";
import { CollaborationProfileDialog } from "./CollaborationProfileDialog";

const avatarImage = vi.hoisted(() => ({
  loadAvatarSource: vi.fn(),
  renderAvatarImage: vi.fn(),
}));
vi.mock("./avatar-image", async (importOriginal) => ({ ...(await importOriginal<object>()), ...avatarImage }));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  avatarImage.loadAvatarSource.mockReset();
  avatarImage.renderAvatarImage.mockReset();
});

const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); }); };
const click = async (element: Element) => {
  await act(async () => { element.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await settle();
};
/** `scope` を渡さなければ文書全体。名前とアイコンの上に重ねた切り抜く画面にも「キャンセル」があるので、区別するときに渡す。 */
function button(name: string, scope: ParentNode = document) {
  const found = Array.from(scope.querySelectorAll("button")).find((item) => item.textContent === name || item.getAttribute("aria-label") === name);
  expect(found, name).toBeTruthy();
  return found!;
}
const hasButton = (name: string) => Array.from(document.querySelectorAll("button")).some((item) => item.textContent === name);
const cropDialog = () => Array.from(document.querySelectorAll('[role="dialog"]')).find((dialog) => dialog.textContent?.includes("アイコンの範囲")) ?? null;
const stage = () => document.querySelector<HTMLElement>('[data-testid="avatar-crop-stage"]')!;
const stageImage = () => document.querySelector<HTMLImageElement>('[data-testid="avatar-crop-frame"] img')!;
const placement = () => {
  const { left, top, width, height } = stageImage().style;
  return { left, top, width, height };
};
/** 小数の誤差を許して比べる (対数の目盛りやホイールの拡大率は割り切れない)。 */
function expectPlacement(expected: { left: number; top: number; width: number; height: number }) {
  const actual = placement();
  for (const key of ["left", "top", "width", "height"] as const) expect(Number.parseFloat(actual[key]), key).toBeCloseTo(expected[key], 6);
}
/** 枠を 240px 四方 (画面の左上 100,100) に置いたことにする (happy-dom は配置を計算しない)。 */
function layOutFrame() {
  const frame = document.querySelector<HTMLElement>('[data-testid="avatar-crop-frame"]')!;
  frame.getBoundingClientRect = () => ({ left: 100, top: 100, width: 240, height: 240, right: 340, bottom: 340, x: 100, y: 100, toJSON: () => ({}) }) as DOMRect;
}
function pointer(type: string, x: number, y: number) {
  return new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, clientX: x, clientY: y });
}
const key = async (name: string, init: KeyboardEventInit = {}) => {
  await act(async () => { stage().dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init })); });
};

const landscape: AvatarSource = { file: new Blob(), width: 1200, height: 800, url: "blob:landscape" };

describe("avatar crop dialog", () => {
  it("starts from the centred square and moves the picture by dragging, keys and zoom", async () => {
    const onApply = vi.fn<(crop: AvatarCrop) => void>();
    act(() => root.render(<CollaborationAvatarCropDialog source={landscape} onCancel={vi.fn()} onApply={onApply} />));
    // 横長 (1200×800) は、真ん中の 800px 四方。
    expect(placement()).toEqual({ left: "-25%", top: "0%", width: "150%", height: "100%" });
    expect(button("縮小").disabled).toBe(true);
    const slider = document.querySelector<HTMLInputElement>('input[type="range"]')!;
    expect(slider.getAttribute("aria-label")).toBe("拡大率");
    expect(slider.getAttribute("aria-valuetext")).toBe("100%");
    // 見本 (64px・28px) も同じ置き方。
    expect(Array.from(document.querySelectorAll<HTMLImageElement>('[data-testid="avatar-crop-previews"] img')).map((image) => image.style.left)).toEqual(["-25%", "-25%"]);

    // 画像を枠の 1/8 (30px) 右へドラッグすると、左の 100px 寄りが見える。端を越えたら左端で止まる。
    layOutFrame();
    await act(async () => { stage().dispatchEvent(pointer("pointerdown", 200, 200)); });
    await act(async () => { stage().dispatchEvent(pointer("pointermove", 230, 260)); });
    expect(placement()).toEqual({ left: "-12.5%", top: "0%", width: "150%", height: "100%" });
    await act(async () => { stage().dispatchEvent(pointer("pointermove", 900, 200)); });
    expect(placement().left).toBe("0%");
    await act(async () => { stage().dispatchEvent(pointer("pointerup", 900, 200)); });
    await act(async () => { stage().dispatchEvent(pointer("pointermove", 100, 200)); });
    expect(placement().left).toBe("0%");

    // + で 1.25 倍 (真ん中を止める)、矢印キーで動かす。
    await key("+");
    expect(slider.getAttribute("aria-valuetext")).toBe("125%");
    expect(button("縮小").disabled).toBe(false);
    await key("ArrowLeft");
    await key("-");
    expect(slider.getAttribute("aria-valuetext")).toBe("100%");

    await click(button("適用"));
    expect(onApply).toHaveBeenCalledOnce();
    const [crop] = onApply.mock.calls[0];
    // 左端 (x 0) → 1.25 倍 (真ん中を止めて x 80・一辺 640) → 画像を左へ 4% (x 105.6) → 1 倍 (x 25.6)。
    expect(crop.size).toBeCloseTo(800);
    expect(crop.x).toBeCloseTo(25.6);
    expect(crop.y).toBeCloseTo(0);
  });

  it("zooms with the slider and with a pinch around the pointer", async () => {
    const onApply = vi.fn<(crop: AvatarCrop) => void>();
    act(() => root.render(<CollaborationAvatarCropDialog source={landscape} onCancel={vi.fn()} onApply={onApply} />));
    layOutFrame();
    const slider = document.querySelector<HTMLInputElement>('input[type="range"]')!;
    // スライダーの右端で上限の 8 倍 (真ん中を止める)。
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(slider, "1");
      slider.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(slider.getAttribute("aria-valuetext")).toBe("800%");
    expectPlacement({ left: -550, top: -350, width: 1200, height: 800 });
    expect(button("拡大").disabled).toBe(true);

    // 枠の左上を指したままピンチで縮めると、左上が止まったまま 4 倍になる。
    const pinch = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: Math.log(2) / 0.01 });
    // happy-dom の WheelEvent は MouseEvent の項目を引き継がない (Chromium のピンチは ctrlKey 付きのホイールで届く)。
    for (const [name, value] of Object.entries({ ctrlKey: true, clientX: 100, clientY: 100 })) Object.defineProperty(pinch, name, { value });
    await act(async () => { stage().dispatchEvent(pinch); });
    expect(pinch.defaultPrevented).toBe(true);
    expect(slider.getAttribute("aria-valuetext")).toBe("400%");
    expectPlacement({ left: -275, top: -175, width: 600, height: 400 });
    await click(button("適用"));
    const [crop] = onApply.mock.calls[0];
    expect(crop.size).toBeCloseTo(200, 1);
    expect(crop.x).toBeCloseTo(550, 1);
    expect(crop.y).toBeCloseTo(350, 1);
  });

  it("cancels with the button and with Escape", async () => {
    const onCancel = vi.fn();
    act(() => root.render(<CollaborationAvatarCropDialog source={landscape} onCancel={onCancel} onApply={vi.fn()} />));
    await click(button("キャンセル"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});

describe("profile dialog picture", () => {
  const user = { actorId: "me", email: "me@example.test", displayName: "Me", avatarUrl: "https://lh3.googleusercontent.com/a/me", avatarVersion: 3 };
  function mockBridge() {
    const collaboration = {
      profile: vi.fn(async () => ({ userId: "me", providerDisplayName: "Me", providerAvatarUrl: "https://lh3.googleusercontent.com/a/me", avatarVersion: 3 })),
      updateProfile: vi.fn(),
      setAvatar: vi.fn(async () => ({})),
      clearAvatar: vi.fn(async () => ({})),
    };
    vi.spyOn(bridgeModule, "getDesktopBridge").mockReturnValue({ collaboration } as unknown as ReturnType<typeof bridgeModule.getDesktopBridge>);
    return collaboration;
  }
  const portrait: AvatarSource = { file: new Blob(), width: 600, height: 900, url: "blob:portrait" };
  const preview = () => document.querySelector<HTMLImageElement>('[data-testid="profile-avatar-preview"] img')!.getAttribute("src");
  async function choose(source: AvatarSource) {
    avatarImage.loadAvatarSource.mockResolvedValueOnce(source);
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(["x"], "photo.png", { type: "image/png" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle();
    expect(avatarImage.loadAvatarSource).toHaveBeenLastCalledWith(file);
  }

  it("keeps the current picture when the crop is cancelled", async () => {
    const bridge = mockBridge();
    act(() => root.render(<CollaborationProfileDialog user={user} onClose={vi.fn()} onSaved={vi.fn(async () => {})} />));
    await settle();
    expect(preview()).toBe("sigma-collaboration-profile://avatar?user=me&v=3");
    await choose(portrait);
    expect(cropDialog()).not.toBeNull();
    await click(button("キャンセル", cropDialog()!));
    expect(cropDialog()).toBeNull();
    expect(preview()).toBe("sigma-collaboration-profile://avatar?user=me&v=3");
    expect(avatarImage.renderAvatarImage).not.toHaveBeenCalled();
    expect(button("保存").disabled).toBe(true);
    expect(hasButton("範囲を調整")).toBe(false);
    expect(bridge.setAvatar).not.toHaveBeenCalled();
  });

  it("saves the chosen crop, can adjust it again, and can still go back to the Google picture", async () => {
    const bridge = mockBridge();
    const onSaved = vi.fn(async () => {});
    act(() => root.render(<CollaborationProfileDialog user={user} onClose={vi.fn()} onSaved={onSaved} />));
    await settle();
    await choose(portrait);
    // 縦長 (600×900) は真ん中の 600px 四方から始まる。上へずらして (顔を枠に) 合わせる。
    expect(placement()).toEqual({ left: "0%", top: "-25%", width: "100%", height: "150%" });
    await key("ArrowDown", { shiftKey: true });
    await key("ArrowDown", { shiftKey: true });
    await key("ArrowDown", { shiftKey: true });
    expect(placement().top).toBe("0%");
    const bytes = new Uint8Array([1, 2, 3]);
    avatarImage.renderAvatarImage.mockResolvedValueOnce({ bytes, type: "image/webp", previewUrl: "blob:cropped-1" });
    await click(button("適用"));
    expect(avatarImage.renderAvatarImage).toHaveBeenLastCalledWith(portrait, { x: 0, y: 0, size: 600 });
    expect(cropDialog()).toBeNull();
    expect(preview()).toBe("blob:cropped-1");

    // 選び直さずに調整し直すと、前に決めた範囲から始まる。キャンセルすれば前の見本のまま。
    await click(button("範囲を調整"));
    expect(placement().top).toBe("0%");
    await key("ArrowUp");
    await click(button("キャンセル", cropDialog()!));
    expect(cropDialog()).toBeNull();
    expect(preview()).toBe("blob:cropped-1");

    // Google のアイコンに戻すと、選んだ画像は送らない。
    await click(button("Google のアイコンに戻す"));
    expect(preview()).toBe(`sigma-collaboration-profile://avatar?url=${encodeURIComponent("https://lh3.googleusercontent.com/a/me")}`);
    expect(hasButton("範囲を調整")).toBe(false);
    await click(button("保存"));
    expect(bridge.clearAvatar).toHaveBeenCalledOnce();
    expect(bridge.setAvatar).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it("sends the cropped picture when saved", async () => {
    const bridge = mockBridge();
    act(() => root.render(<CollaborationProfileDialog user={user} onClose={vi.fn()} onSaved={vi.fn(async () => {})} />));
    await settle();
    await choose(landscape);
    const bytes = new Uint8Array([4, 5, 6]);
    avatarImage.renderAvatarImage.mockResolvedValueOnce({ bytes, type: "image/webp", previewUrl: "blob:cropped-2" });
    await click(button("適用"));
    await click(button("保存"));
    expect(bridge.setAvatar).toHaveBeenCalledWith(bytes, "image/webp");
    expect(bridge.clearAvatar).not.toHaveBeenCalled();
  });

  it("reports a picture that cannot be read without opening the crop", async () => {
    mockBridge();
    act(() => root.render(<CollaborationProfileDialog user={user} onClose={vi.fn()} onSaved={vi.fn(async () => {})} />));
    await settle();
    avatarImage.loadAvatarSource.mockResolvedValueOnce("unreadable");
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["x"], "broken.png", { type: "image/png" })] });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle();
    expect(cropDialog()).toBeNull();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("画像を読み込めませんでした。別の画像を選んでください。");
  });
});
