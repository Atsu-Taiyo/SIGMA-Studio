import { describe, expect, it, vi } from "vitest";

import { LocalStoreWriteIdentity, type LocalStoreWriteIdentityPorts } from "./local-store-write-identity";

function harness() {
  const stat = vi.fn<LocalStoreWriteIdentityPorts["stat"]>(async () => ({ size: 20, mtimeMs: 30, ino: 40 }));
  const readFile = vi.fn<LocalStoreWriteIdentityPorts["readFile"]>(async () => "document bytes");
  const identity = new LocalStoreWriteIdentity({ stat, readFile });
  return { identity, stat, readFile };
}

describe("local store write identity", () => {
  it("recognizes bytes as soon as they are registered, before a durable write has returned a stat token", async () => {
    const h = harness();
    h.identity.rememberSignature("document", "document bytes");
    expect(h.identity.matchesSignature("document", "document bytes")).toBe(true);
    expect(await h.identity.matchesStat("document")).toBe(false);
    expect(h.stat).not.toHaveBeenCalled();
    expect(await h.identity.matchesFile("document")).toBe(true);
  });

  it("retains exact byte signatures for duplicate events, independently for each path", () => {
    const h = harness();
    h.identity.rememberSignature("document", '{"updatedAt":"first"}');
    h.identity.rememberSignature("library", '{"version":4}');
    for (let event = 0; event < 2; event++) {
      expect(h.identity.matchesSignature("document", '{"updatedAt":"first"}')).toBe(true);
      expect(h.identity.matchesSignature("library", '{"version":4}')).toBe(true);
    }
    expect(h.identity.matchesSignature("document", '{"updatedAt":"second"}')).toBe(false);
    expect(h.identity.matchesSignature("library", '{ "version": 4 }')).toBe(false);
    expect(h.identity.matchesSignature("unknown", '{"version":4}')).toBe(false);
    expect(h.identity.matchesSignature("library")).toBe(false);
    h.identity.rememberSignature("document", "new bytes");
    expect(h.identity.matchesSignature("document", '{"updatedAt":"first"}')).toBe(false);
    expect(h.identity.matchesSignature("document", "new bytes")).toBe(true);
  });

  it("consumes a successful stat match once while retaining the byte signature", async () => {
    const h = harness();
    h.identity.rememberSignature("document", "document bytes");
    h.identity.recordStat("document", "20:30:40");
    expect(await h.identity.matchesStat("document")).toBe(true);
    expect(await h.identity.matchesStat("document")).toBe(false);
    expect(h.stat).toHaveBeenCalledOnce();
    expect(h.identity.matchesSignature("document", "document bytes")).toBe(true);
  });

  it.each([
    { size: 21, mtimeMs: 30, ino: 40 },
    { size: 20, mtimeMs: 31, ino: 40 },
    { size: 20, mtimeMs: 30, ino: 41 },
  ])("retains the token after a nonmatching stat %j", async (stat) => {
    const h = harness();
    h.identity.recordStat("document", "20:30:40");
    h.stat.mockResolvedValueOnce(stat);
    expect(await h.identity.matchesStat("document")).toBe(false);
    expect(await h.identity.matchesStat("document")).toBe(true);
  });

  it("retains the token after a failed stat and treats failed reads as unrecognized", async () => {
    const h = harness();
    h.identity.rememberSignature("document", "document bytes");
    h.identity.recordStat("document", "20:30:40");
    h.stat.mockRejectedValueOnce(new Error("stat failed"));
    h.readFile.mockRejectedValueOnce(new Error("read failed"));
    expect(await h.identity.matchesStat("document")).toBe(false);
    expect(await h.identity.matchesFile("document")).toBe(false);
    expect(await h.identity.matchesStat("document")).toBe(true);
    expect(await h.identity.matchesFile("document")).toBe(true);
  });

  it("clears a stale stat token when a later durable write cannot supply one", async () => {
    const h = harness();
    h.identity.rememberSignature("document", "document bytes");
    h.identity.recordStat("document", "20:30:40");
    h.identity.recordStat("document", null);
    expect(await h.identity.matchesStat("document")).toBe(false);
    expect(h.stat).not.toHaveBeenCalled();
    expect(h.identity.matchesSignature("document", "document bytes")).toBe(true);
  });

  it("checks bytes when an untracked file generates an event", async () => {
    const h = harness();
    expect(await h.identity.matchesFile("unknown")).toBe(false);
    expect(h.readFile).toHaveBeenCalledWith("unknown");
  });
});
