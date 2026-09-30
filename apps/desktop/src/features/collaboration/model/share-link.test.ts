import { describe, expect, it } from "vitest";
import { createShareLink, invitationToken, parseShareLink } from "./share-link";
import type { SharedTargetRef } from "./catalog";
const id = "12345678-1234-4234-8234-123456789012" as SharedTargetRef["catalogNodeId"];
describe("shared item links", () => {
  it.each(["workspace", "folder", "document"] as const)("round trips a stable %s target and optional invitation", kind => {
    const target = { kind, catalogNodeId: id };
    expect(parseShareLink(createShareLink(target))).toEqual({ target });
    const token = "x".repeat(43);
    expect(parseShareLink(createShareLink(target, token))).toEqual({ target, token });
    expect(invitationToken(createShareLink(target, token))).toBe(token);
    expect(invitationToken(` ${token} `)).toBe(token);
    expect(invitationToken(createShareLink(target))).toBeNull();
  });
  it.each([
    "https://share/document/", "javascript:alert(1)", "file:///tmp/example", "sigma-studio://share/document/local_file",
    `sigma-studio://user@share/document/${id}`, `sigma-studio://share:123/document/${id}`,
    `sigma-studio://share/document/${id}/extra`, `sigma-studio://share/document/${id}?server=https://evil.test`,
    `sigma-studio://share/document/${id}#invitation=bad`, `sigma-studio://share/document/${id}#unknown=true`,
    `sigma-studio://share/delete/${id}`,
  ])("rejects malformed or unrelated links: %s", value => expect(parseShareLink(value)).toBeNull());
});

describe("selection links", () => {
  const target: SharedTargetRef = { kind: "document", catalogNodeId: id };
  const location = { type: "textRange" as const, start: { blockId: "p", offset: 2 }, end: { blockId: "p", offset: 9 }, quote: "" };
  it("round trips the location with or without an invitation", () => {
    expect(parseShareLink(createShareLink(target, undefined, location))).toEqual({ target, location });
    const token = "a".repeat(43);
    expect(parseShareLink(createShareLink(target, token, location))).toEqual({ target, token, location });
  });
  it("rejects non-document, malformed and duplicate locations", () => {
    const link = createShareLink(target, undefined, location);
    expect(parseShareLink(link.replace("/document/", "/folder/"))).toBeNull();
    expect(parseShareLink(`${link}&location=bad`)).toBeNull();
    expect(parseShareLink(`${createShareLink(target)}#location=bad`)).toBeNull();
    expect(() => createShareLink({ ...target, kind: "folder" }, undefined, location)).toThrow("INVALID_LOCATION");
  });
});
