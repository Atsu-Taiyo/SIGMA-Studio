import { describe, expect, it } from "vitest";

import { getCommentThreadParticipants, layoutCommentParticipants, type CommentParticipant } from "./comment-participants";

const me = { name: "木村", avatarUrl: "data:image/png;base64,AA" };
const message = (id: string, authorName?: string, agent?: { vendor: "openai" | "anthropic" }) => ({
  id, authorName, agent, body: [], createdAt: "2026-10-03T00:00:00.000Z",
});
const person = (name: string): CommentParticipant => ({ key: `${name}:`, name });

describe("getCommentThreadParticipants", () => {
  it("lists each speaker once, in the order they first spoke", () => {
    const thread = { messages: [message("1", "田中"), message("2", "佐藤"), message("3", "田中"), message("4", "木村")] };
    expect(getCommentThreadParticipants(thread, me).map((p) => p.name)).toEqual(["田中", "佐藤", "木村"]);
  });

  it("treats a message without an author name as the current user, and lends only them the avatar", () => {
    const thread = { messages: [message("1"), message("2", "田中")] };
    const [self, other] = getCommentThreadParticipants(thread, me);
    expect(self).toMatchObject({ name: "木村", avatarUrl: "data:image/png;base64,AA" });
    expect(other.avatarUrl).toBeNull();
  });

  it("keeps an AI apart from a person with the same name, and never lends it the user's avatar", () => {
    const thread = { messages: [message("1", "木村"), message("2", "木村", { vendor: "anthropic" })] };
    const participants = getCommentThreadParticipants(thread, me);
    expect(participants).toHaveLength(2);
    expect(participants[1].agent).toEqual({ vendor: "anthropic" });
    expect(participants[1].avatarUrl).toBeNull();
  });
});

describe("layoutCommentParticipants", () => {
  const names = (list: CommentParticipant[]) => list.map((p) => p.name);

  it("shows one or two people solid and nothing faded", () => {
    expect(layoutCommentParticipants([])).toEqual({ solid: [], faded: [], hiddenCount: 0 });
    const two = layoutCommentParticipants([person("a"), person("b")]);
    expect(names(two.solid)).toEqual(["a", "b"]);
    expect(two.faded).toEqual([]);
    expect(two.hiddenCount).toBe(0);
  });

  it("fades the third person", () => {
    const three = layoutCommentParticipants([person("a"), person("b"), person("c")]);
    expect(names(three.solid)).toEqual(["a", "b"]);
    expect(names(three.faded)).toEqual(["c"]);
    expect(three.hiddenCount).toBe(0);
  });

  it("folds everyone after the third into a count", () => {
    const five = layoutCommentParticipants(["a", "b", "c", "d", "e"].map(person));
    expect(names(five.solid)).toEqual(["a", "b"]);
    expect(names(five.faded)).toEqual(["c"]);
    expect(five.hiddenCount).toBe(2);
  });
});
