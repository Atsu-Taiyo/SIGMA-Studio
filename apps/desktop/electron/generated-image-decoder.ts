import { tv } from "@/lib/ai/validation-locale";
import { spawnCliProcess } from "./cli-spawn";

// Malformed raster data can terminate the native decoder instead of rejecting
// loadImage(). Keep that failure outside Electron main and the MCP process.
// This is fixed application code; no prompt, path or image bytes become code.
const DECODE_SCRIPT = `
const { loadImage, createCanvas } = require(process.argv[1]);
const chunks = [];
let length = 0;
process.stdin.on('data', chunk => {
  length += chunk.length;
  if (length > 20 * 1024 * 1024) process.exit(1);
  chunks.push(chunk);
});
process.stdin.on('end', async () => {
  try {
    const image = await loadImage(Buffer.concat(chunks));
    const { width, height } = image;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
      || width > 8192 || height > 8192 || width * height > 32 * 1024 * 1024) process.exit(1);
    const scale = Math.min(1, 512 / Math.max(width, height));
    const canvas = createCanvas(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    process.stdout.write(JSON.stringify({ width, height, png: canvas.toBuffer('image/png').toString('base64') }));
  } catch { process.exitCode = 1; }
});
`;

export async function decodeGeneratedImage(bytes: Buffer): Promise<{ width: number; height: number; png: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnCliProcess(process.execPath, ["-e", DECODE_SCRIPT, require.resolve("@napi-rs/canvas")], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
    });
    let output = "";
    let finished = false;
    const finish = (value?: { width: number; height: number; png: string }) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (value) resolve(value);
      else reject(new Error(tv("generatedImage.invalidImage")));
    };
    const timer = setTimeout(() => { child.kill(); finish(); }, 30_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 2 * 1024 * 1024) { child.kill(); finish(); }
    });
    child.on("error", () => finish());
    child.stdin.on("error", () => { child.kill(); finish(); });
    child.on("close", (code) => {
      if (code !== 0) return finish();
      try {
        const value = JSON.parse(output) as { width: number; height: number; png: string };
        if (!Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height) || typeof value.png !== "string") return finish();
        finish(value);
      } catch { finish(); }
    });
    child.stdin.end(bytes);
  });
}
