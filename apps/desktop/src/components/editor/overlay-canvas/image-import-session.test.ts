import { describe, expect, it, vi } from "vitest";

import type { OverlayAsset, OverlayShape } from "@/features/document";
import type { OverlayImageEntry } from "@/features/drawing";
import { createOverlayImageImportSession } from "./image-import-session";

function file(name: string): File {
  return new File(["image"], name, { type: "image/png" });
}

function entry(id: string): OverlayImageEntry {
  return {
    asset: { id: `asset_${id}`, type: "image", props: { w: 100, h: 50, name: id, isAnimated: false, mimeType: "image/png", src: "data:image/png;base64,AA==", fileSize: 1 } },
    shape: { id, type: "image", x: 0, y: 0, rotation: 0, props: { assetId: `asset_${id}`, w: 100, h: 50 } },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness() {
  const events: string[] = [];
  const placement = { canvasWidth: 800, canvasHeight: 600, parentId: undefined as string | undefined };
  const ports = {
    areaSize: { w: 800, h: 600 }, gap: 16,
    decodeFile: vi.fn(async (file: File) => entry(file.name)),
    getPlacement: vi.fn(() => { events.push("placement"); return { ...placement }; }),
    insert: vi.fn((shapes: OverlayShape[], assets: Record<string, OverlayAsset>) => {
      events.push(`insert:${shapes.map((shape) => shape.id).join(",")}:${Object.keys(assets).join(",")}`);
    }),
    onHandled: vi.fn((id: number) => { events.push(`handled:${id}`); }),
  };
  return { ports, events, placement };
}

describe("overlay image import session", () => {
  it("keeps the empty-canvas request alive through decoding and commits before acknowledging", async () => {
    const h = harness();
    const pending = deferred<OverlayImageEntry>();
    h.ports.decodeFile.mockReturnValue(pending.promise);
    const session = createOverlayImageImportSession();
    const request = { id: 1, files: [file("first")] };
    const inserting = session.handle(request, h.ports);
    await session.handle(request, h.ports);
    expect(h.ports.decodeFile).toHaveBeenCalledOnce();
    expect(h.ports.decodeFile).toHaveBeenCalledWith(request.files[0], { w: 800, h: 600 });
    expect(h.events).toEqual([]);

    h.placement.canvasWidth = 1000;
    h.placement.canvasHeight = 800;
    pending.resolve(entry("first"));
    await inserting;
    expect(h.ports.insert.mock.calls[0][0]).toMatchObject([{ id: "first", x: 450, y: 96 }]);
    expect(h.events).toEqual(["placement", "insert:first:asset_first", "handled:1"]);
    await session.handle(request, h.ports);
    expect(h.ports.onHandled).toHaveBeenCalledOnce();
  });

  it("starts all decodes together and preserves request order when the second completes first", async () => {
    const h = harness();
    const first = deferred<OverlayImageEntry>();
    const second = deferred<OverlayImageEntry>();
    h.ports.decodeFile.mockImplementation((file) => file.name === "first" ? first.promise : second.promise);
    const inserting = createOverlayImageImportSession().handle({ id: 1, files: [file("first"), file("second")], point: { x: 20, y: 30 } }, h.ports);
    expect(h.ports.decodeFile).toHaveBeenCalledTimes(2);
    second.resolve(entry("second"));
    await Promise.resolve();
    expect(h.ports.insert).not.toHaveBeenCalled();
    first.resolve(entry("first"));
    await inserting;
    expect(h.ports.insert.mock.calls[0][0]).toMatchObject([{ id: "first", x: 20, y: 30 }, { id: "second", x: 136, y: 30 }]);
    expect(h.events.at(-1)).toBe("handled:1");
  });

  it("acknowledges an empty request synchronously and suppresses its duplicate", async () => {
    const h = harness();
    const session = createOverlayImageImportSession();
    const request = { id: 1, files: [] };
    const empty = session.handle(request, h.ports);
    expect(h.events).toEqual(["handled:1"]);
    await empty;
    await session.handle(request, h.ports);
    expect(h.ports.decodeFile).not.toHaveBeenCalled();
    expect(h.ports.getPlacement).not.toHaveBeenCalled();
    expect(h.ports.onHandled).toHaveBeenCalledOnce();
  });

  it("releases a failed batch without inserting the successfully decoded subset", async () => {
    const h = harness();
    const first = deferred<OverlayImageEntry>();
    const second = deferred<OverlayImageEntry>();
    h.ports.decodeFile.mockImplementation((file) => file.name === "first" ? first.promise : second.promise);
    const request = { id: 1, files: [file("first"), file("second")] };
    const session = createOverlayImageImportSession();
    const inserting = session.handle(request, h.ports);
    first.reject(new Error("read failure"));
    await inserting;
    expect(h.events).toEqual(["handled:1"]);
    second.resolve(entry("second"));
    await Promise.resolve();
    await session.handle(request, h.ports);
    expect(h.ports.insert).not.toHaveBeenCalled();
    expect(h.ports.decodeFile).toHaveBeenCalledTimes(2);
  });

  it.each(["decode", "placement", "insert"])("still acknowledges when %s throws synchronously", async (phase) => {
    const h = harness();
    const fail = () => { throw new Error(phase); };
    if (phase === "decode") h.ports.decodeFile.mockImplementation(fail);
    if (phase === "placement") h.ports.getPlacement.mockImplementation(fail);
    if (phase === "insert") h.ports.insert.mockImplementation(fail);
    await expect(createOverlayImageImportSession().handle({ id: 1, files: [file("first")] }, h.ports)).resolves.toBeUndefined();
    expect(h.ports.onHandled).toHaveBeenCalledExactlyOnceWith(1);
  });

  it.each([false, true])("propagates completion callback failures (empty=%s)", async (empty) => {
    const h = harness();
    h.ports.onHandled.mockImplementation(() => { throw new Error("completion"); });
    await expect(createOverlayImageImportSession().handle({ id: 1, files: empty ? [] : [file("first")] }, h.ports)).rejects.toThrow("completion");
    expect(h.ports.onHandled).toHaveBeenCalledOnce();
  });

  it("tracks only the most recent request and keeps sessions independent", async () => {
    const h = harness();
    const session = createOverlayImageImportSession();
    for (const id of [1, 2, 1]) await session.handle({ id, files: [file(String(id))] }, h.ports);
    expect(h.ports.insert).toHaveBeenCalledTimes(3);
    await createOverlayImageImportSession().handle({ id: 1, files: [file("new-canvas")] }, h.ports);
    expect(h.ports.insert).toHaveBeenCalledTimes(4);
  });

  it("normalizes the imported snapshot before passing it to the host", async () => {
    const h = harness();
    h.placement.parentId = "group-not-in-imported-snapshot";
    await createOverlayImageImportSession().handle({ id: 1, files: [file("first")] }, h.ports);
    expect(h.ports.insert.mock.calls[0][0][0]).not.toHaveProperty("parentId");
    expect(h.ports.insert.mock.calls[0][1]).toEqual({ asset_first: entry("first").asset });
  });
});
