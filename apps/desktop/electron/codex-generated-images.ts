import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { decodeGeneratedImage } from "./generated-image-decoder";
import { tv } from "@/lib/ai/validation-locale";
import { AiEditAttachmentItemSchema } from "./ai-edit-run-context";

export const MAX_GENERATED_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_GENERATED_IMAGES_PER_RUN = 8;
const MAX_IMAGE_DIMENSION = 8192;
const MAX_IMAGE_PIXELS = 32 * 1024 * 1024;

const GeneratedImageSchema = z.object({
  version: z.literal(1),
  runId: z.string().min(1),
  fileId: z.string().min(1),
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  itemId: z.string().min(1),
  imageId: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string(),
  image: AiEditAttachmentItemSchema,
  previewDataUrl: z.string().max(2 * 1024 * 1024),
});

export type CodexGeneratedImage = z.infer<typeof GeneratedImageSchema>;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function imageMime(bytes: Buffer): "image/png" | "image/jpeg" | "image/webp" {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  throw new Error(tv("generatedImage.invalidImage"));
}

/** Decode actual image bytes, never an SVG, URL or model-authored file reference. */
export async function prepareGeneratedImage(bytes: Buffer) {
  if (!bytes.length || bytes.length > MAX_GENERATED_IMAGE_BYTES) throw new Error(tv("generatedImage.tooLarge"));
  const mimeType = imageMime(bytes);
  // Reject unreasonable PNG dimensions before allocating the decoded bitmap.
  if (mimeType === "image/png" && bytes.length >= 24) checkDimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
  const { width, height, png } = await decodeGeneratedImage(mimeType === "image/png" ? pngThumbnailInput(bytes) : bytes);
  checkDimensions(width, height);
  return {
    mimeType, width, height, fileSize: bytes.length,
    dataUrl: `data:${mimeType};base64,${bytes.toString("base64")}`,
    previewDataUrl: `data:image/png;base64,${png}`,
  };
}

/**
 * The native decoder misidentifies PNGs containing Codex's caBX provenance
 * chunk as SVG. Remove that ancillary chunk ONLY from thumbnail input. The
 * original bytes, metadata and provenance remain in storage and SigmaDoc.
 */
function pngThumbnailInput(bytes: Buffer): Buffer {
  const chunks = [bytes.subarray(0, 8)];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) break;
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type !== "caBX") chunks.push(bytes.subarray(offset, end));
    offset = end;
    if (type === "IEND" && length === 0 && offset === bytes.length) return Buffer.concat(chunks);
  }
  throw new Error(tv("generatedImage.invalidImage"));
}

function checkDimensions(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION || width * height > MAX_IMAGE_PIXELS) {
    throw new Error(tv("generatedImage.tooLarge"));
  }
}

/** Only native imageGeneration notifications from the active turn enter this boundary. */
export async function readCodexGeneratedImageBytes(item: Record<string, unknown>, allowedRoots: string[]): Promise<Buffer> {
  if (item.failure || item.status !== "completed") throw new Error(tv("generatedImage.failed"));
  if (typeof item.result === "string" && item.result.length > 0) {
    const encoded = item.result.replace(/^data:image\/(?:png|jpeg|webp);base64,/, "");
    if (encoded.length > Math.ceil(MAX_GENERATED_IMAGE_BYTES / 3) * 4) throw new Error(tv("generatedImage.tooLarge"));
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
      const bytes = Buffer.from(encoded, "base64");
      imageMime(bytes);
      return bytes;
    }
  }
  if (typeof item.savedPath !== "string" || !path.isAbsolute(item.savedPath)) throw new Error(tv("generatedImage.invalidImage"));
  const realFile = await fs.realpath(item.savedPath);
  const roots = await Promise.all(allowedRoots.map((root) => fs.realpath(root).catch(() => null)));
  if (!roots.some((root) => root && isWithin(root, realFile))) throw new Error(tv("generatedImage.invalidImage"));
  const handle = await fs.open(realFile, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_GENERATED_IMAGE_BYTES) throw new Error(tv("generatedImage.tooLarge"));
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function isWithin(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Original results outlive the turn so chat history can reopen them after restarting. */
export class CodexGeneratedImageStore {
  constructor(private readonly dataDir: string) {}

  private directory(runId: string): string {
    if (!runId.trim()) throw new Error(tv("generatedImage.invalidRun"));
    return path.join(this.dataDir, "ai-generated-images", digest(runId));
  }

  async register(scope: { runId: string; fileId: string; threadId: string; turnId: string; itemId: string }, bytes: Buffer): Promise<CodexGeneratedImage> {
    const imageId = digest(JSON.stringify([scope.runId, scope.threadId, scope.turnId, scope.itemId]));
    const existing = await this.get(scope.runId, imageId);
    if (existing) return existing;
    if ((await this.list(scope.runId)).length >= MAX_GENERATED_IMAGES_PER_RUN) throw new Error(tv("generatedImage.tooMany"));
    const { previewDataUrl, ...image } = await prepareGeneratedImage(bytes);
    const record = GeneratedImageSchema.parse({
      version: 1, ...scope, imageId, createdAt: new Date().toISOString(), previewDataUrl,
      image: { ...image, id: imageId, name: `AI-${imageId.slice(0, 8)}` },
    });
    const directory = this.directory(scope.runId);
    await fs.mkdir(directory, { recursive: true });
    const temporary = path.join(directory, `${imageId}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: "wx" });
      await fs.rename(temporary, path.join(directory, `${imageId}.json`));
    } finally {
      await fs.rm(temporary, { force: true });
    }
    return record;
  }

  async get(runId: string, imageId: string): Promise<CodexGeneratedImage | null> {
    if (!/^[a-f0-9]{64}$/.test(imageId)) throw new Error(tv("generatedImage.invalidImage"));
    try {
      const record = GeneratedImageSchema.parse(JSON.parse(await fs.readFile(path.join(this.directory(runId), `${imageId}.json`), "utf8")));
      if (record.runId !== runId || record.imageId !== imageId) throw new Error(tv("generatedImage.invalidRun"));
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async list(runId: string): Promise<CodexGeneratedImage[]> {
    const names = await fs.readdir(this.directory(runId)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const records = await Promise.all(names.filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).map((name) => this.get(runId, name.slice(0, -5))));
    return records.filter((record): record is CodexGeneratedImage => record !== null);
  }

  async removeRun(runId: string): Promise<void> {
    await fs.rm(this.directory(runId), { recursive: true, force: true });
  }
}
