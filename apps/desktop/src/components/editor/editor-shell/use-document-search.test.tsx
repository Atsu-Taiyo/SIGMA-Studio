// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SigmaBlock, SigmaDocument } from "@/features/document";

import { tEditor } from "./editor-translations";
import { useDocumentSearchCommands } from "./use-document-search";

const paragraph = (id: string, text: string): SigmaBlock => ({ id, type: "paragraph", children: [{ type: "text", text }] });

function documentOf(content: SigmaBlock[]): SigmaDocument {
  return { version: "2.0", docId: "search", metadata: { title: "検索" }, content, outputProfiles: {} } as unknown as SigmaDocument;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

type Commands = ReturnType<typeof useDocumentSearchCommands>;

async function renderCommands(options: {
  content: SigmaBlock[];
  hiddenBlockIds?: ReadonlySet<string>;
  commit?: (change: unknown) => boolean;
}) {
  const setSelectedId = vi.fn();
  const setStatusMessage = vi.fn();
  const commitDocumentChange = vi.fn(options.commit ?? (() => true));
  let commands: Commands | null = null;
  function Harness() {
    commands = useDocumentSearchCommands({
      document: documentOf(options.content),
      selectedId: null,
      searchQuery: "needle",
      replaceText: "pin",
      hiddenBlockIds: options.hiddenBlockIds,
      setSelectedId,
      setStatusMessage,
      commitDocumentChange,
    });
    return null;
  }
  await act(async () => root.render(<Harness />));
  return { commands: commands as unknown as Commands, setSelectedId, setStatusMessage, commitDocumentChange };
}

describe("document search commands", () => {
  it("does not move the selection into, or count, a block the page does not show", async () => {
    const { commands, setSelectedId, setStatusMessage } = await renderCommands({
      content: [paragraph("shown", "plain"), paragraph("folded", "needle here")],
      hiddenBlockIds: new Set(["folded"]),
    });

    expect(commands.searchMatchCount).toBe(0);
    commands.findNext();
    expect(setSelectedId).not.toHaveBeenCalled();
    expect(setStatusMessage).toHaveBeenLastCalledWith(tEditor("status.noSearchResults"));
  });

  it("does not report a replacement the document refused (the refusal message stays)", async () => {
    const { commands, setStatusMessage, commitDocumentChange } = await renderCommands({
      content: [paragraph("shown", "needle"), paragraph("other", "needle")],
      commit: () => false,
    });

    commands.replaceAll();
    commands.replaceNext();

    expect(commitDocumentChange).toHaveBeenCalledTimes(2);
    expect(setStatusMessage).not.toHaveBeenCalled();
  });

  it("reports a replacement the document took", async () => {
    const { commands, setStatusMessage } = await renderCommands({
      content: [paragraph("shown", "needle"), paragraph("other", "needle")],
    });

    commands.replaceAll();

    expect(setStatusMessage).toHaveBeenLastCalledWith(tEditor("status.replacedMany", { matches: 2 }));
  });
});
