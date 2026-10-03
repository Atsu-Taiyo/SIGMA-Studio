import { describe, expect, it } from "vitest";

import type { AiEditAttachment } from "@/lib/ai/sigma-doc-agent-tools";

import { MAX_AI_EDIT_ATTACHMENTS } from "./ai-chat-attachments";
import { appendPendingAttachment } from "./use-ai-pending-attachments";

function attachment(id: string): AiEditAttachment {
  return { id, name: `${id}.png`, mimeType: "image/png", dataUrl: "data:image/png;base64,AA" };
}

describe("appendPendingAttachment", () => {
  it("appends in the order the screenshots were taken", () => {
    const result = appendPendingAttachment([attachment("a")], attachment("b"));
    expect(result.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("drops the oldest once the attachment limit is reached, so the newest screenshot always lands", () => {
    let current: AiEditAttachment[] = [];
    for (let index = 0; index < MAX_AI_EDIT_ATTACHMENTS + 2; index += 1) {
      current = appendPendingAttachment(current, attachment(`shot-${index}`));
    }
    expect(current).toHaveLength(MAX_AI_EDIT_ATTACHMENTS);
    expect(current.at(-1)?.id).toBe(`shot-${MAX_AI_EDIT_ATTACHMENTS + 1}`);
    expect(current[0]?.id).toBe("shot-2");
  });

  it("does not double an attachment that arrives twice", () => {
    const first = attachment("a");
    expect(appendPendingAttachment([first], first)).toHaveLength(1);
  });
});
