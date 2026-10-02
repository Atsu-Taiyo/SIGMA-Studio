import { expect, it } from "vitest";
import { createBlankDocument } from "@/lib/blank-document";
import { SharedDocument } from "@/features/collaboration/model/shared-document";
import { toBase64 } from "@/features/collaboration/model/protocol";
import type { ObjectValue } from "@/features/collaboration/model/value";
import { validateAcknowledgements, validateApproval, validateDocumentIdentity, validateSnapshot, validateSync } from "./response-validation";

it.each(["../escape", "", null, "__proto__"])("rejects unsafe document id %s before storage use", id => {
  expect(() => validateDocumentIdentity({ id, epoch: 1 })).toThrow("INVALID_DOCUMENT_RESPONSE");
});
it.each([-1, 0, "1", "../../escape", Number.MAX_SAFE_INTEGER + 1])("rejects invalid snapshot epoch %s", epoch => {
  expect(() => validateSnapshot({ state: "AAA=", role: "editor", epoch }, "shared")).toThrow("INVALID_SNAPSHOT_RESPONSE");
});
it("binds a parsed snapshot to the response epoch and requested document before journal creation", () => {
  const document = new SharedDocument();
  document.initialize(JSON.parse(JSON.stringify(createBlankDocument())) as ObjectValue, { sharedDocumentId: "shared", epoch: 2 });
  const value = { state: toBase64(document.snapshot()), role: "editor", epoch: 2, protocol: 1 };
  expect(() => validateSnapshot(value, "shared")).not.toThrow();
  expect(() => validateSnapshot(value, "other")).toThrow("INVALID_SNAPSHOT_RESPONSE");
  expect(() => validateSnapshot({ ...value, epoch: 1 }, "shared")).toThrow("INVALID_SNAPSHOT_RESPONSE");
  expect(() => validateSnapshot({ ...value, role: "superuser" }, "shared")).toThrow("INVALID_SNAPSHOT_RESPONSE");
  document.destroy();
});
it("accepts current minimal sync fields and rejects invalid roles or explicit identity drift", () => {
  expect(() => validateSync({ update: "AAA=", role: "viewer" }, 1)).not.toThrow();
  for (const value of [{ update: "AAA=" }, { update: "AAA=", role: "superuser" }, { update: "AAA=", role: "editor", epoch: 2 }, { update: "AAA=", role: "editor", protocol: 2 }])
    expect(() => validateSync(value, 1)).toThrow("INVALID_SYNC_RESPONSE");
});
it("requires positive ACK sequences and exact operation correspondence", () => {
  expect(() => validateAcknowledgements({ acks: [{ operationId: "one", seq: 1 }, { operationId: "two", seq: -1 }] }, ["one", "two"])).toThrow("INVALID_ACK");
  expect(() => validateAcknowledgements({ acks: [{ operationId: "other", seq: 1 }] }, ["one"])).toThrow("INVALID_ACK");
  expect(() => validateApproval({ operationId: "other", seq: 1, update: "AAA=" }, "one")).toThrow("INVALID_ACK");
});
