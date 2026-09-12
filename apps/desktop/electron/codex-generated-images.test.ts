import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexGeneratedImageStore, prepareGeneratedImage, readCodexGeneratedImageBytes } from "./codex-generated-images";
import { CodexImageGenerationRun } from "./codex-image-generation-run";
import type { AiEditRunEvent } from "@/lib/ai/ai-edit-runtime";

function png(color = "red"): Buffer {
  const canvas = createCanvas(64, 32);
  const context = canvas.getContext("2d");
  context.fillStyle = color;
  context.fillRect(0, 0, 64, 32);
  return canvas.toBuffer("image/png");
}

describe("Codex generated image ownership and imports", () => {
  let directory: string;
  let store: CodexGeneratedImageStore;
  const scope = { runId: "run_1", fileId: "file_1", threadId: "thread_1", turnId: "turn_1", itemId: "image_1" };
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-generated-images-"));
    store = new CodexGeneratedImageStore(directory);
  });
  afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

  it("persists original bytes, dimensions and a thumbnail across store recreation; repeated events have one identity", async () => {
    const bytes = png();
    const record = await store.register(scope, bytes);
    expect(record.image).toMatchObject({ width: 64, height: 32, fileSize: bytes.length, mimeType: "image/png" });
    expect(record.image.dataUrl).toBe(`data:image/png;base64,${bytes.toString("base64")}`);
    expect(await new CodexGeneratedImageStore(directory).get(scope.runId, record.imageId)).toEqual(record);
    expect(await store.register(scope, png("blue"))).toEqual(record);
    expect(await store.list(scope.runId)).toHaveLength(1);
    expect(await store.get("other_run", record.imageId)).toBeNull();
  });

  it("decodes a PNG carrying SVG-looking provenance without stripping provenance from the original", async () => {
    // Reproduces native imagegen PNGs: ancillary C2PA/caBX metadata contains XML.
    const metadata = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">provenance</svg>');
    const typeAndData = Buffer.concat([Buffer.from("caBX"), metadata]);
    let crc = 0xffffffff;
    for (const byte of typeAndData) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const chunk = Buffer.alloc(metadata.length + 12);
    chunk.writeUInt32BE(metadata.length); typeAndData.copy(chunk, 4); chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
    const plain = png();
    const bytes = Buffer.concat([plain.subarray(0, 33), chunk, plain.subarray(33)]);
    const image = await prepareGeneratedImage(bytes);
    expect(image.width).toBe(64);
    expect(image.dataUrl).toBe(`data:image/png;base64,${bytes.toString("base64")}`);
    expect(Buffer.from(image.previewDataUrl.split(",")[1], "base64").includes(metadata)).toBe(false);
  });

  it("keeps IDs distinct even for run names that a filename sanitizer would collapse", async () => {
    const first = await store.register({ ...scope, runId: "a/b" }, png());
    const second = await store.register({ ...scope, runId: "a_b" }, png());
    expect(first.imageId).not.toBe(second.imageId);
    await store.removeRun("a/b");
    expect(await store.list("a/b")).toEqual([]);
    expect(await store.get("a_b", second.imageId)).toEqual(second);
    await expect(store.get("a_b", "../auth.json")).rejects.toThrow();
  });

  it("rejects SVGs, malformed PNGs, impossible dimensions and failed native results", async () => {
    await expect(prepareGeneratedImage(Buffer.from("<svg/>"))).rejects.toThrow();
    await expect(prepareGeneratedImage(png().subarray(0, 26))).rejects.toThrow();
    const huge = Buffer.from(png());
    huge.writeUInt32BE(100_000, 16);
    await expect(prepareGeneratedImage(huge)).rejects.toThrow();
    await expect(readCodexGeneratedImageBytes({ status: "failed", result: png().toString("base64") }, [])).rejects.toThrow();
  });

  it("accepts base64 directly and permits savedPath only within a verified runtime root", async () => {
    const bytes = png();
    expect(await readCodexGeneratedImageBytes({ status: "completed", result: bytes.toString("base64") }, [])).toEqual(bytes);
    const root = path.join(directory, "runtime");
    await fs.mkdir(root);
    const imagePath = path.join(root, "image.png");
    await fs.writeFile(imagePath, bytes);
    expect(await readCodexGeneratedImageBytes({ status: "completed", savedPath: imagePath }, [root])).toEqual(bytes);
    const outside = path.join(directory, "outside.png");
    await fs.writeFile(outside, bytes);
    await fs.symlink(outside, path.join(root, "link.png"));
    await expect(readCodexGeneratedImageBytes({ status: "completed", savedPath: path.join(root, "link.png") }, [root])).rejects.toThrow();
  });

  it("drains asynchronous imports before follow-up, deduplicates completed events and ignores late started events", async () => {
    const events: AiEditRunEvent[] = [];
    const run = new CodexImageGenerationRun({ store, ...scope, allowedRoots: [], onEvent: (event) => events.push(event), isCancelled: () => false });
    const item = { type: "imageGeneration", id: scope.itemId, status: "completed", result: png().toString("base64") };
    const params = { turnId: scope.turnId, item };
    run.handle({ method: "item/completed", params }, scope.threadId);
    run.handle({ method: "item/completed", params }, scope.threadId);
    run.handle({ method: "item/started", params }, scope.threadId);
    await run.settle();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ itemType: "imageGeneration", itemStatus: "completed", images: [{ generatedImage: { runId: scope.runId } }] });
    expect(run.imageIds.size).toBe(1);
    expect(await store.list(scope.runId)).toHaveLength(1);
  });

  it("cancellation removes imported results and drops later notifications", async () => {
    const events: AiEditRunEvent[] = [];
    let cancelled = false;
    const run = new CodexImageGenerationRun({ store, ...scope, allowedRoots: [], onEvent: (event) => events.push(event), isCancelled: () => cancelled });
    const notification = { method: "item/completed", params: { turnId: scope.turnId, item: { id: scope.itemId, type: "imageGeneration", status: "completed", result: png().toString("base64") } } };
    run.handle(notification, scope.threadId);
    cancelled = true;
    await run.settle();
    run.handle(notification, scope.threadId);
    await run.settle();
    expect(events).toEqual([]);
    expect(await store.list(scope.runId)).toEqual([]);
    expect(run.imageIds.size).toBe(0);
  });

  it("closes a failed image activity and does not retry or persist a result", async () => {
    const events: AiEditRunEvent[] = [];
    const run = new CodexImageGenerationRun({ store, ...scope, allowedRoots: [], onEvent: (event) => events.push(event), isCancelled: () => false });
    run.handle({ method: "item/completed", params: { turnId: scope.turnId, item: { id: scope.itemId, type: "imageGeneration", status: "failed", result: "", failure: { code: "rate_limit" } } } }, scope.threadId);
    await run.settle();
    expect(events[0]).toMatchObject({ itemStatus: "completed" });
    expect(run.errors).toHaveLength(1);
    expect(await store.list(scope.runId)).toEqual([]);
  });
});
