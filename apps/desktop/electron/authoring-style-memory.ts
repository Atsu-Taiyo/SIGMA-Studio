import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { AUTHORING_STYLE_NOTE_LIMIT, type AuthoringStyleProfile } from "@/lib/ai/authoring-style";

export const styleHash = (text: string) => createHash("sha256").update(text).digest("hex");

export async function boundedRead(file: string, limit = 30_000): Promise<string> {
  try {
    // Reject links so a user-editable memory cannot redirect writes/reads outside its directory.
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > limit * 4) throw new Error("Invalid authoring memory file");
    const text = await fs.readFile(file, "utf8");
    if (text.length > limit) throw new Error("Authoring memory exceeds the size limit");
    return text;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

export async function atomicStyleWrite(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}

/** Callers hold the cross-process style lock. Automatic updates never write the user note. */
export class AuthoringStyleMemory {
  constructor(private readonly root: string) {}

  private dir(workspaceId: string | null): string {
    return workspaceId === null ? this.root : path.join(this.root, "workspaces", styleHash(workspaceId));
  }

  async enabled(workspaceId: string | null): Promise<boolean> {
    const text = await boundedRead(path.join(this.dir(workspaceId), "settings.json"), 1000);
    return !text || JSON.parse(text).enabled !== false;
  }

  async setEnabled(workspaceId: string | null, enabled: boolean): Promise<void> {
    await atomicStyleWrite(path.join(this.dir(workspaceId), "settings.json"), JSON.stringify({ enabled }));
  }

  async read(workspaceId: string | null, exampleCount: number): Promise<AuthoringStyleProfile> {
    const dir = this.dir(workspaceId);
    const userPath = path.join(dir, workspaceId === null ? "user.md" : "workspace.md");
    const generatedPath = path.join(dir, "learned.md");
    const userContent = await boundedRead(userPath, AUTHORING_STYLE_NOTE_LIMIT);
    const generatedContent = await boundedRead(generatedPath, AUTHORING_STYLE_NOTE_LIMIT);
    const hash = await boundedRead(path.join(dir, "learned.sha256"), 100);
    const evidenceText = await boundedRead(path.join(dir, "learned-evidence.json"), 1000);
    const evidence = evidenceText ? JSON.parse(evidenceText) : {};
    return { evidenceRevision: typeof evidence.revision === "string" ? evidence.revision : "",
      needsSynthesis: exampleCount > 0 && evidence.synthesized !== true && !(generatedContent && styleHash(generatedContent) !== hash),
      workspaceId, enabled: await this.enabled(workspaceId), userContent, generatedContent,
      userPath, generatedPath, revision: styleHash(userContent),
      generatedEdited: Boolean(generatedContent && styleHash(generatedContent) !== hash), exampleCount };
  }

  async update(workspaceId: string | null, generated: string, evidenceRevision: string): Promise<void> {
    const profile = await this.read(workspaceId, 0);
    await fs.mkdir(this.dir(workspaceId), { recursive: true });
    // Exclusive creation: an external editor's first note also wins.
    try { await fs.writeFile(profile.userPath, "", { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (profile.generatedEdited || profile.evidenceRevision === evidenceRevision) return;
    // Recheck just before writing; a hand edit to learned.md freezes automatic updates.
    if (await boundedRead(profile.generatedPath, AUTHORING_STYLE_NOTE_LIMIT) !== profile.generatedContent) return;
    await atomicStyleWrite(profile.generatedPath, generated);
    await atomicStyleWrite(path.join(this.dir(workspaceId), "learned.sha256"), styleHash(generated));
    await atomicStyleWrite(path.join(this.dir(workspaceId), "learned-evidence.json"), JSON.stringify({ revision: evidenceRevision, synthesized: false }));
  }

  async synthesize(workspaceId: string | null, content: string, expectedEvidenceRevision: string): Promise<void> {
    if (!content.trim() || content.length > AUTHORING_STYLE_NOTE_LIMIT) throw new Error("Invalid style summary");
    const profile = await this.read(workspaceId, 0);
    if (profile.generatedEdited) throw new Error("Style summary was manually edited");
    if (profile.evidenceRevision !== expectedEvidenceRevision) throw new Error("Style evidence changed");
    await atomicStyleWrite(profile.generatedPath, content);
    await atomicStyleWrite(path.join(this.dir(workspaceId), "learned.sha256"), styleHash(content));
    await atomicStyleWrite(path.join(this.dir(workspaceId), "learned-evidence.json"), JSON.stringify({ revision: expectedEvidenceRevision, synthesized: true }));
  }

  async save(workspaceId: string | null, content: string, expectedRevision: string): Promise<void> {
    if (typeof content !== "string" || content.length > AUTHORING_STYLE_NOTE_LIMIT) throw new Error("Style note exceeds 3000 characters");
    const profile = await this.read(workspaceId, 0);
    if (profile.revision !== expectedRevision) throw new Error("Style note changed. Reload before saving.");
    await atomicStyleWrite(profile.userPath, content);
  }

  async resetAllGenerated(): Promise<void> {
    await this.resetGenerated(null);
    let scopes;
    try { scopes = await fs.readdir(path.join(this.root, "workspaces"), { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for (const dir of scopes) {
      if (!dir.isDirectory() || !/^[a-f0-9]{64}$/.test(dir.name)) continue;
      for (const name of ["learned.md", "learned.sha256", "learned-evidence.json"]) await fs.rm(path.join(this.root, "workspaces", dir.name, name), { force: true });
    }
  }

  async resetGenerated(workspaceId: string | null): Promise<void> {
    for (const name of ["learned.md", "learned.sha256", "learned-evidence.json"]) await fs.rm(path.join(this.dir(workspaceId), name), { force: true });
  }
}
