import { describe, expect, it } from "vitest";

import { createTableShapeProps } from "@/components/editor/overlay-canvas/shapes/table";
import { blockToReferenceText } from "@/lib/ai/ai-edit-reference";
import { findBlock } from "@/lib/document-tree";
import { sampleDocument } from "@/lib/sample-document";
import {
  createSigmaWebMcpTools,
  END_OF_DOCUMENT_TARGET,
  getWebMcpAgentInstructionsStorageKey,
  initializeWebMcpHeavyFallbackCounter,
  recordWebMcpHeavyFallback,
  SIGMA_WEB_MCP_TOOL_NAMES,
  WEB_MCP_PROPOSAL_ID,
  type SigmaWebMcpPorts,
  type SigmaWebMcpProposal,
  type WebMcpToolDefinition,
} from "@/lib/webmcp-tools";
import {
  getDefaultPageLayout,
  hydrateGraphSpecWithOwnedLabelTexts,
  type OverlayShape,
  type SigmaDocument,
} from "@/features/document";

function baseDocument(shapes: OverlayShape[] = []): SigmaDocument {
  return {
    ...sampleDocument,
    docId: "doc_webmcp_test",
    metadata: { ...sampleDocument.metadata, title: "WebMCP test" },
    content: [
      { type: "paragraph", id: "p_existing", children: [{ type: "text", text: "Original ", marks: ["bold"] }, { type: "text", text: "text" }] },
      { type: "paragraph", id: "p_second", children: [{ type: "text", text: "Second paragraph" }] },
    ],
    pageLayout: {
      ...sampleDocument.pageLayout!,
      overlay: {
        ...sampleDocument.pageLayout?.overlay,
        overlaySnapshot: { version: 1, shapes, assets: {} },
        updatedAt: "2026-08-30T00:00:00.000Z",
      },
    },
    updatedAt: "2026-08-30T00:00:00.000Z",
  };
}

function whiteboardDocument(): SigmaDocument {
  return {
    ...baseDocument(),
    content: [],
    pageLayout: getDefaultPageLayout("whiteboard"),
  };
}

function createHarness(initial = baseDocument(), catalog: "public" | "implementation" = "implementation") {
  let document = initial;
  let revision = 0;
  let proposal: SigmaWebMcpProposal | null = null;
  const undoStack: SigmaDocument[] = [];
  const proposalUpdates: SigmaWebMcpProposal[] = [];
  const ports: SigmaWebMcpPorts = {
    getDocument: () => document,
    getRevision: () => revision,
    getSelectedBlockId: () => "p_existing",
    getSelection: () => ({ blockId: "p_existing", textRange: null, inlineMath: null, overlayShapes: [] }),
    getAgentInstructions: () => "Keep explanations concise.",
    proposeDocumentChange: (next) => { proposal = next; proposalUpdates.push(next); },
    withdrawDocumentChange: () => { proposal = null; },
    // 本物と同じく、コメントは提案を経由せず即座に文書へ入り revision を進める。
    commitComments: (mutate) => { document = mutate(document); revision += 1; },
  };
  const tools = createSigmaWebMcpTools(ports, { catalog });
  const tool = (name: string): WebMcpToolDefinition => {
    const found = tools.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`Missing tool: ${name}`);
    return found;
  };
  return {
    tool,
    tools,
    getDocument: () => document,
    getProposal: () => proposal as SigmaWebMcpProposal | null,
    getProposalUpdates: () => proposalUpdates,
    apply: () => {
      if (!proposal) throw new Error("No proposal");
      undoStack.push(structuredClone(document));
      document = proposal.apply(document).document;
      proposal.accept();
      proposal = null;
      revision += 1;
    },
    undo: () => {
      const previous = undoStack.pop();
      if (!previous) throw new Error("No undo entry");
      document = previous;
      revision += 1;
    },
    humanEdit: (next: SigmaDocument) => {
      document = next;
      revision += 1;
      if (proposal) {
        try {
          proposal = proposal.refresh(document);
        } catch {
          // The real Bridge keeps the last reviewed proposal visible so Apply can report the
          // concrete conflicting target. Safe rebases replace it with a refreshed preview.
        }
      }
    },
  };
}

function parseResult(result: unknown): Record<string, unknown> {
  expect(result).toEqual(expect.any(Object));
  return result as Record<string, unknown>;
}

function currentShape(document: SigmaDocument, id: string): OverlayShape {
  const shape = document.pageLayout?.overlay?.overlaySnapshot?.shapes.find((candidate) => candidate.id === id);
  if (!shape) throw new Error(`Missing shape: ${id}`);
  return shape;
}

describe("Sigma WebMCP desktop-parity tools", () => {
  it("keeps the heavy-fallback counter observable and at zero on the normal path (acceptance 14)", () => {
    const target: { __sigmaWebMcpHeavyFallbackCount?: number } = {};
    initializeWebMcpHeavyFallbackCounter(target);
    expect(target.__sigmaWebMcpHeavyFallbackCount).toBe(0);
    recordWebMcpHeavyFallback(target);
    expect(target.__sigmaWebMcpHeavyFallbackCount).toBe(1);
  });
  it("publishes the documented open-document tool set with safety annotations", () => {
    const { tools } = createHarness(baseDocument(), "public");
    expect(tools.map((tool) => tool.name)).toEqual(SIGMA_WEB_MCP_TOOL_NAMES);
    expect(tools.find((tool) => tool.name === "get_agent_instructions")?.annotations.readOnlyHint).toBe(true);
    expect(tools.find((tool) => tool.name === "get_agent_instructions")?.annotations.untrustedContentHint).toBe(true);
    expect(tools.find((tool) => tool.name === "insert_markdown")?.annotations.readOnlyHint).toBe(false);
    expect(tools.find((tool) => tool.name === "insert_markdown")?.description).toContain("get_agent_instructions");
  });

  it("keeps the public catalog compact and task-oriented while preserving all major editing domains", () => {
    const { tools } = createHarness(baseDocument(), "public");
    expect(tools).toHaveLength(28);
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "inspect_document", "insert_markdown", "edit_text", "edit_problem", "organize_blocks",
      "update_layout", "insert_svg_image", "update_svg_image", "create_overlay", "update_overlay", "arrange_overlay", "delete_overlay",
      "insert_table", "update_table", "insert_graph", "update_graph",
      "insert_graph3d", "update_graph3d",
      "list_comments", "add_comment", "reply_comment", "resolve_comment",
    ]));
    expect(tools.map((tool) => tool.name)).not.toEqual(expect.arrayContaining([
      "get_block", "get_blocks", "insert_shape", "update_shape",
    ]));
  });

  it("proposes, revises, applies and undoes an SVG image through the public tools", async () => {
    const harness = createHarness(baseDocument(), "public");
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><rect width="200" height="100" fill="red"/></svg>';
    const result = parseResult(await harness.tool("insert_svg_image").execute({ expectedRevision: 0, targetId: "p_existing", svg, w: 200 }));
    expect(result).toMatchObject({ ok: true, status: "pending_approval" });
    expect(harness.getDocument()).toEqual(baseDocument());
    const first = harness.getProposal()!.apply(harness.getDocument()).document;
    const image = first.pageLayout!.overlay!.overlaySnapshot!.shapes.find((shape) => shape.type === "image")!;
    expect(parseResult(await harness.tool("update_svg_image").execute({ expectedRevision: 0, shapeId: image.id, expectedShape: image, svg: svg.replace('red', 'blue') }))).toMatchObject({ ok: true, status: "pending_approval" });
    harness.apply();
    expect(currentShape(harness.getDocument(), image.id)).toEqual(image);
    const assets = harness.getDocument().pageLayout!.overlay!.overlaySnapshot!.assets;
    expect(Buffer.from(Object.values(assets)[0].props.src.split(',')[1], 'base64').toString()).toContain('blue');
    harness.undo();
    expect(harness.getDocument()).toEqual(baseDocument());
  });

  it("rejects stale SVG asset changes even when the image shape itself is unchanged", async () => {
    const harness = createHarness(baseDocument(), "public");
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><rect fill="red"/></svg>';
    await harness.tool("insert_svg_image").execute({ expectedRevision: 0, targetId: "p_existing", svg });
    harness.apply();
    const image = harness.getDocument().pageLayout!.overlay!.overlaySnapshot!.shapes.find((shape) => shape.type === "image")!;
    await harness.tool("update_svg_image").execute({ expectedRevision: 1, shapeId: image.id, expectedShape: image, svg: svg.replace('red', 'blue') });
    const changed = structuredClone(harness.getDocument());
    const asset = Object.values(changed.pageLayout!.overlay!.overlaySnapshot!.assets)[0];
    asset.props.src = `data:image/svg+xml;base64,${Buffer.from(svg.replace('red', 'green')).toString('base64')}`;
    harness.humanEdit(changed);
    expect(() => harness.apply()).toThrow(/STALE/);
    expect(harness.getDocument()).toEqual(changed);
  });

  it("routes public inspection and Markdown insertion through the established proposal engine", async () => {
    const harness = createHarness(baseDocument(), "public");
    const context = parseResult(await harness.tool("inspect_document").execute({ targetId: "p_existing" }));
    expect(context).toMatchObject({ revision: 0, target: { id: "p_existing", type: "paragraph" } });
    expect(parseResult(await harness.tool("read_blocks").execute({ blockIds: ["p_existing", "p_second"] }))).toMatchObject({
      blocks: [{ id: "p_existing" }, { id: "p_second" }],
    });

    const result = parseResult(await harness.tool("insert_markdown").execute({
      expectedRevision: 0,
      targetId: "p_existing",
      markdown: "## 例題\n\n式 $x^2=4$ を解く。",
    }));
    expect(result).toMatchObject({ status: "pending_approval", operationCount: 2 });
    harness.apply();
    expect(harness.getDocument().content.slice(1, 3)).toMatchObject([
      { type: "heading", children: [{ type: "text", text: "例題" }] },
      { type: "paragraph" },
    ]);
    const insertedParagraph = harness.getDocument().content[2];
    if (insertedParagraph?.type !== "paragraph") return;
    expect(insertedParagraph.children.find((node) => node.type === "mathInline")).toMatchObject({ tex: "x^2=4" });
  });

  it("reports document mode and explains whiteboard canvas authoring", async () => {
    const whiteboard = createHarness(whiteboardDocument(), "public");
    expect(parseResult(await whiteboard.tool("inspect_document").execute({}))).toMatchObject({
      documentMode: "whiteboard",
      guidance: expect.stringContaining("WHITEBOARD_NO_BODY"),
    });

    const paged = createHarness(baseDocument(), "public");
    expect(parseResult(await paged.tool("inspect_document").execute({}))).toMatchObject({
      documentMode: "paged",
    });
  });

  it("rejects whiteboard body edits without leaking a draft or stale revision", async () => {
    const harness = createHarness(whiteboardDocument(), "public");

    await expect(async () => harness.tool("insert_markdown").execute({
      expectedRevision: 0,
      targetId: END_OF_DOCUMENT_TARGET,
      markdown: "本文",
    })).rejects.toThrow("WHITEBOARD_NO_BODY");
    expect(parseResult(await harness.tool("get_pending_proposal").execute({}))).toMatchObject({ pending: false });

    harness.humanEdit({ ...harness.getDocument(), updatedAt: "2026-09-03T00:00:00.000Z" });
    expect(parseResult(await harness.tool("create_overlay").execute({
      expectedRevision: 1,
      targetId: "CANVAS",
      kind: "rectangle",
      x: 100,
      y: 80,
    }))).toMatchObject({ ok: true, status: "pending_approval" });
  });

  it("creates multi-block Markdown text on a whiteboard and validates markdown exclusivity", async () => {
    const harness = createHarness(whiteboardDocument(), "public");
    expect(parseResult(await harness.tool("create_overlay").execute({
      expectedRevision: 0,
      targetId: "CANVAS",
      kind: "text",
      x: 100,
      y: 80,
      markdown: "## 見出し\n\n式 $x^2$ を考える。\n\n- 一つ\n- 二つ",
    }))).toMatchObject({ ok: true, status: "pending_approval" });
    const operation = harness.getProposal()?.previewDraft.operations.find((item) => item.operation === "insertOverlayShape");
    expect(operation).toMatchObject({ operation: "insertOverlayShape", overlayShape: { type: "text" } });
    const overlayShape = operation?.operation === "insertOverlayShape" ? operation.overlayShape : null;
    expect(overlayShape?.type === "text" ? overlayShape.props.blocks.map((block) => block.type) : []).toEqual(["heading", "paragraph", "list"]);
    const paragraph = overlayShape?.type === "text" ? overlayShape.props.blocks[1] : null;
    expect(paragraph?.type === "paragraph" ? paragraph.children : []).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "mathInline", tex: "x^2" }),
    ]));

    const invalidKind = createHarness(whiteboardDocument(), "public");
    await expect(async () => invalidKind.tool("create_overlay").execute({
      expectedRevision: 0,
      targetId: "CANVAS",
      kind: "rectangle",
      x: 0,
      y: 0,
      markdown: "x",
    })).rejects.toThrow("kind:text");
    expect(parseResult(await invalidKind.tool("get_pending_proposal").execute({}))).toMatchObject({ pending: false });

    const conflictingContent = createHarness(whiteboardDocument(), "public");
    await expect(async () => conflictingContent.tool("create_overlay").execute({
      expectedRevision: 0,
      targetId: "CANVAS",
      kind: "text",
      x: 0,
      y: 0,
      markdown: "x",
      text: "y",
    })).rejects.toThrow("text");
    expect(parseResult(await conflictingContent.tool("get_pending_proposal").execute({}))).toMatchObject({ pending: false });
  });

  it("routes public overlay creation and updates by canonical object type", async () => {
    const harness = createHarness(baseDocument(), "public");
    await harness.tool("create_overlay").execute({
      expectedRevision: 0,
      targetId: "p_existing",
      kind: "rectangle",
      x: 40,
      y: 80,
      color: "#111827",
    });
    harness.apply();
    const created = harness.getDocument().pageLayout?.overlay?.overlaySnapshot?.shapes.find((shape) => shape.type === "geo");
    expect(created).toMatchObject({ type: "geo", x: 40, y: 80, props: { color: "#111827" } });
    if (!created) return;

    await harness.tool("update_overlay").execute({
      expectedRevision: 1,
      shapeId: created.id,
      expectedShape: created,
      color: "#dc2626",
    });
    harness.apply();
    expect(currentShape(harness.getDocument(), created.id)).toMatchObject({ props: { color: "#dc2626" } });
  });

  it("materializes every WebMCP graph label with recoverable ownership", async () => {
    const harness = createHarness(baseDocument(), "public");
    await harness.tool("insert_graph").execute({
      expectedRevision: 0,
      targetId: "p_existing",
      id: "graph_with_labels",
      kind: "cartesian",
      axes: { xLabel: "X軸", yLabel: "Y軸", originLabel: "O", grid: true },
      curves: [{ id: "curve_webmcp", expr: "x^2", label: "f" }],
      points: [{ id: "point_webmcp", x: "1", y: "1", label: "P" }],
      annotations: [{ id: "annotation_webmcp", x: "2", y: "2", text: "注記" }],
      showFormulaLabels: true,
    });
    harness.apply();

    const document = harness.getDocument();
    const graph = currentShape(document, "graph_with_labels");
    expect(graph.type).toBe("graph2dShape");
    if (graph.type !== "graph2dShape") return;
    const overlayShapes = document.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
    expect(graph.props.axisLabelTextShapeIds).toEqual({
      x: expect.any(String),
      y: expect.any(String),
      origin: expect.any(String),
    });
    expect(graph.props.pointLabelTextShapeIdsByPointId).toEqual({ point_webmcp: expect.any(String) });
    expect(graph.props.annotationTextShapeIdsByAnnotationId).toEqual({ annotation_webmcp: expect.any(String) });
    expect(graph.props.labelTextShapeIdsByCurveId).toEqual({ curve_webmcp: expect.any(String) });
    expect(hydrateGraphSpecWithOwnedLabelTexts(graph, overlayShapes)).toMatchObject({
      axes: { xLabel: "X軸", yLabel: "Y軸", originLabel: "O" },
      curves: [{ id: "curve_webmcp", label: "f" }],
      points: [{ id: "point_webmcp", label: "P" }],
      annotations: [{ id: "annotation_webmcp", text: "注記" }],
    });
  });

  it("converts Markdown independently inside semantic problem areas", async () => {
    const harness = createHarness(baseDocument(), "public");
    await harness.tool("edit_problem").execute({
      expectedRevision: 0,
      action: "create",
      targetId: "p_second",
      prompt: "方程式 $x^2-4=0$ を解け。",
      answerTex: String.raw`x=\pm2`,
      solution: "## 解法\n\n平方差を使う。",
      hints: "- 左辺を因数分解する\n- 零積の法則を使う",
    });
    harness.apply();
    const problem = harness.getDocument().content.find((block) => block.type === "problem");
    expect(problem).toMatchObject({
      type: "problem",
      prompt: [expect.objectContaining({ type: "paragraph" })],
      answer: { type: "math", expected: String.raw`x=\pm2` },
      solution: [expect.objectContaining({ type: "heading", level: 2 }), expect.objectContaining({ type: "paragraph" })],
      hints: [expect.objectContaining({ type: "list" })],
    });
    if (problem?.type !== "problem") return;
    const prompt = problem.prompt[0];
    if (prompt?.type !== "paragraph") return;
    expect(prompt.children.find((node) => node.type === "mathInline")).toMatchObject({ tex: "x^2-4=0" });
  });

  it("returns integrated edit context and user instructions with the Web revision", async () => {
    const harness = createHarness();
    expect(parseResult(await harness.tool("get_agent_instructions").execute({}))).toMatchObject({ ok: true, userInstructions: "Keep explanations concise." });
    const context = parseResult(await harness.tool("get_edit_context").execute({ targetId: "p_existing" }));
    expect(context).toMatchObject({ revision: 0, target: { id: "p_existing", type: "paragraph" } });
    expect(context.outline).toEqual(expect.arrayContaining([expect.objectContaining({ id: "p_second" })]));
  });

  it("inserts a 3D figure and updates it in place through the shared draft layer", async () => {
    const harness = createHarness();

    const inserted = parseResult(await harness.tool("insert_graph3d").execute({
      expectedRevision: 0,
      targetId: "p_existing",
      id: "graph3d_web",
      preset: "revolution",
    }));
    expect(inserted).toMatchObject({ status: "pending_approval", proposalId: WEB_MCP_PROPOSAL_ID });
    harness.apply();
    const shape = currentShape(harness.getDocument(), "graph3d_web") as OverlayShape & {
      props: { previewAssetId?: string; spec: { camera: { position: { x: number; y: number; z: number } } } };
    };
    expect(shape.type).toBe("graph3dShape");
    // ブラウザにラスタライザは無い。絵はアプリのWebGLキャプチャに任せ、嘘のハッシュを残さない。
    expect(shape.props.previewAssetId).toBeUndefined();

    const updated = parseResult(await harness.tool("update_graph3d").execute({
      expectedRevision: 1,
      shapeId: "graph3d_web",
      expectedShape: shape,
      camera: { position: { x: 4, y: -4, z: 3 } },
    }));
    expect(updated).toMatchObject({ status: "pending_approval" });
    harness.apply();
    const after = currentShape(harness.getDocument(), "graph3d_web") as typeof shape;
    expect(after.x).toBe(shape.x);
    expect(after.y).toBe(shape.y);
    expect(after.props.spec.camera.position).toEqual({ x: 4, y: -4, z: 3 });
  });

  it("refuses update_graph3d on a shape that is not a 3D figure", async () => {
    const harness = createHarness();
    const inserted = parseResult(await harness.tool("insert_graph").execute({
      expectedRevision: 0,
      targetId: "p_existing",
      id: "graph2d_web",
      curves: [{ id: "curve_web", expr: "x^2" }],
    }));
    expect(inserted).toMatchObject({ status: "pending_approval" });
    harness.apply();
    const shape = currentShape(harness.getDocument(), "graph2d_web");

    await expect(async () => harness.tool("update_graph3d").execute({
      expectedRevision: 1,
      shapeId: "graph2d_web",
      expectedShape: shape,
      camera: { position: { x: 1, y: 1, z: 1 } },
    })).rejects.toThrow("graph3dShape");
  });

  it("scopes locally stored agent instructions to one document", () => {
    expect(getWebMcpAgentInstructionsStorageKey("doc_a")).not.toBe(getWebMcpAgentInstructionsStorageKey("doc_b"));
    expect(getWebMcpAgentInstructionsStorageKey("folder/doc a")).toContain("folder%2Fdoc%20a");
  });

  it("inserts a paragraph with typed inline-math runs and applies it only after approval", async () => {
    const harness = createHarness();
    const result = parseResult(await harness.tool("insert_body_content").execute({
      expectedRevision: 0,
      targetId: "p_existing",
      blocks: [{ id: "p_formula", type: "paragraph", runs: ["二次式 ", { type: "math", id: "math_formula", tex: "x^2+1" }, " を考える。"] }],
    }));
    expect(result).toMatchObject({ status: "pending_approval", proposalId: WEB_MCP_PROPOSAL_ID, operationCount: 1 });
    expect(findBlock(harness.getDocument(), "p_formula")).toBeNull();
    expect(harness.getProposal()?.previewDraft.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: "insertAfter", insertedBlock: expect.objectContaining({ id: "p_formula", children: expect.arrayContaining([expect.objectContaining({ type: "mathInline", tex: "x^2+1" })]) }) }),
    ]));
    harness.apply();
    expect(findBlock(harness.getDocument(), "p_formula")).toMatchObject({
      type: "paragraph",
      children: [{ type: "text", text: "二次式 " }, { type: "mathInline", tex: "x^2+1" }, { type: "text", text: " を考える。" }],
    });
  });

  it("inserts Markdown with headings, math, escaped dollars, lists, emphasis, and fenced code", async () => {
    const harness = createHarness();
    const result = parseResult(await harness.tool("insert_body_content").execute({
      expectedRevision: 0,
      targetId: "p_existing",
      markdown: [
        "## 二次方程式",
        "",
        String.raw`式 $x^2-4=0$ と $$x=\pm2$$ を使う。価格は \$5。`,
        "",
        "- **解**を確認する",
        "- *代入*する",
        "",
        "```typescript",
        'const price = "$5";',
        "```",
      ].join("\n"),
    }));

    expect(result).toMatchObject({
      status: "pending_approval",
      proposalId: WEB_MCP_PROPOSAL_ID,
      operationCount: 4,
    });
    expect(harness.getProposal()?.previewDraft.operations).toHaveLength(4);
    harness.apply();

    expect(harness.getDocument().content.slice(1, 5)).toMatchObject([
      { type: "heading", level: 2, children: [{ type: "text", text: "二次方程式" }] },
      {
        type: "paragraph",
        children: [
          { type: "text", text: "式 " },
          { type: "mathInline", tex: "x^2-4=0" },
          { type: "text", text: " と " },
          { type: "mathInline", tex: String.raw`x=\pm2` },
          { type: "text", text: " を使う。価格は $5。" },
        ],
      },
      {
        type: "list",
        items: [
          { children: [{ type: "text", text: "解", marks: ["bold"] }, { type: "text", text: "を確認する" }] },
          { children: [{ type: "text", text: "代入", marks: ["italic"] }, { type: "text", text: "する" }] },
        ],
      },
      {
        type: "codeBlock",
        language: "typescript",
        children: [{ type: "text", text: 'const price = "$5";' }],
      },
    ]);
  });

  it("accepts ordinary blank-line-separated prose through markdown and rejects ambiguous payloads", async () => {
    const harness = createHarness();
    await harness.tool("insert_body_content").execute({
      expectedRevision: 0,
      targetId: "p_existing",
      markdown: "第一段落。\n\n第二段落。",
    });
    harness.apply();
    expect(harness.getDocument().content.slice(1, 3)).toMatchObject([
      { type: "paragraph", children: [{ type: "text", text: "第一段落。" }] },
      { type: "paragraph", children: [{ type: "text", text: "第二段落。" }] },
    ]);

    expect(() => harness.tool("insert_body_content").execute({
      expectedRevision: 1,
      markdown: "$x$",
      blocks: ["x"],
    })).toThrow("Pass exactly one of markdown or blocks.");
    expect(() => harness.tool("insert_body_content").execute({ expectedRevision: 1 })).toThrow(
      "Pass exactly one of markdown or blocks.",
    );
  });

  it.each([
    "a",
    "x^2+y^2=1",
    String.raw`\frac{a+b}{c}`,
    String.raw`\sqrt{x+1}`,
    String.raw`\sum_{k=1}^{n} k`,
    String.raw`\prod_{i=1}^{m} a_i`,
    String.raw`\int_0^1 x^2\,dx`,
    String.raw`\lim_{x\to0}\frac{\sin x}{x}`,
    String.raw`a\leqq b`,
    String.raw`x\in\mathbb{R}`,
    String.raw`\mathrm{O}`,
    String.raw`\vec{AB}`,
    String.raw`\overline{AB}`,
    String.raw`\left(1-\frac{2a}{3R}\right)`,
    String.raw`\begin{pmatrix}a&b\\c&d\end{pmatrix}`,
    String.raw`f'(x)=2x`,
    String.raw`x=\pm2`,
    String.raw`\theta=\frac{\pi}{3}`,
    String.raw`\Phi_a=\pi B_0a^2`,
    String.raw`\text{価格は\$5}`,
  ])("round-trips common TeX exactly through the Markdown MCP path: %s", async (tex) => {
    const harness = createHarness();
    await harness.tool("insert_body_content").execute({
      expectedRevision: 0,
      targetId: "p_existing",
      markdown: `式 $${tex}$。`,
    });
    harness.apply();
    const inserted = harness.getDocument().content[1];
    expect(inserted).toMatchObject({ type: "paragraph" });
    if (inserted?.type !== "paragraph") return;
    expect(inserted.children.find((node) => node.type === "mathInline")).toMatchObject({ tex });
  });

  it("keeps unmatched dollars as text and rejects unsupported TeX before publishing a proposal", async () => {
    const unmatched = createHarness();
    await unmatched.tool("insert_body_content").execute({
      expectedRevision: 0,
      targetId: "p_existing",
      markdown: "未完の式 $x+1 は文字のまま。",
    });
    unmatched.apply();
    expect(unmatched.getDocument().content[1]).toMatchObject({
      type: "paragraph",
      children: [{ type: "text", text: "未完の式 $x+1 は文字のまま。" }],
    });

    const invalid = createHarness();
    expect(() => invalid.tool("insert_body_content").execute({
      expectedRevision: 0,
      targetId: "p_existing",
      markdown: String.raw`式 $\notacommand{x}$。`,
    })).toThrow();
    expect(invalid.getProposal()).toBeNull();
  });

  it("updates rich content with typed runs including inline math", async () => {
    const harness = createHarness();
    await harness.tool("update_rich_content").execute({ expectedRevision: 0, blockId: "p_existing", expectedContent: "Original text", runs: ["答えは ", { type: "math", id: "math_answer", tex: "x=2" }, " です。"] });
    harness.apply();
    expect(findBlock(harness.getDocument(), "p_existing")).toMatchObject({ id: "p_existing", type: "paragraph", children: [{ text: "答えは " }, { type: "mathInline", tex: "x=2" }, { text: " です。" }] });
  });

  it("creates and then partially updates problem content without replacing untouched areas", async () => {
    const harness = createHarness();
    await harness.tool("create_problem_content").execute({
      expectedRevision: 0, targetId: "p_second", id: "problem_1",
      prompt: { id: "prompt_1", runs: ["方程式 ", { type: "math", tex: "x^2-4=0" }, " を解け。"] },
      answerTex: "x=\\pm2", solution: { id: "solution_1", text: "因数分解する。" }, hints: { id: "hint_1", text: "平方差を使う。" },
    });
    harness.apply();
    const problem = findBlock(harness.getDocument(), "problem_1");
    expect(problem).toMatchObject({ type: "problem", answer: { type: "math", expected: "x=\\pm2" } });
    await harness.tool("update_problem_content").execute({ expectedRevision: 1, targetId: "problem_1", expectedProblem: problem, solution: [{ id: "solution_2", runs: ["よって ", { type: "math", tex: "x=\\pm2" }, "。"] }] });
    harness.apply();
    expect(findBlock(harness.getDocument(), "problem_1")).toMatchObject({
      type: "problem", prompt: [expect.objectContaining({ id: "prompt_1" })], hints: [expect.objectContaining({ id: "hint_1" })],
      solution: [expect.objectContaining({ id: "solution_2", children: expect.arrayContaining([expect.objectContaining({ type: "mathInline" })]) })],
    });
  });

  it("updates one table cell while preserving widths, styles, and every other cell", async () => {
    const props = createTableShapeProps("plain", 320, 140);
    const tableShape: OverlayShape = {
      id: "table_1", type: "tableShape", x: 80, y: 160,
      props: {
        ...props,
        table: {
          ...props.table,
          columns: props.table.columns.map((column, index) => ({ ...column, width: { mode: "fixed", value: index === 0 ? 110 : index === 1 ? 90 : 120 } })),
          cells: props.table.cells.map((cell, index) => index === 0 ? { ...cell, content: [{ type: "paragraph", id: "table_cell_text", children: [{ type: "text", text: "A" }] }] } : cell),
        },
      },
    };
    const harness = createHarness(baseDocument([tableShape]));
    await harness.tool("update_table").execute({ expectedRevision: 0, shapeId: "table_1", expectedShape: tableShape, cellPatches: [{ row: 0, col: 0, content: "B" }] });
    harness.apply();
    const updated = currentShape(harness.getDocument(), "table_1");
    expect(updated.type).toBe("tableShape");
    if (updated.type !== "tableShape" || tableShape.type !== "tableShape") return;
    expect(updated.props.table.columns.map((column) => column.width)).toEqual([
      { mode: "fixed", value: 110 }, { mode: "fixed", value: 90 }, { mode: "fixed", value: 120 },
    ]);
    expect(updated.props.table.grid).toEqual(tableShape.props.table.grid);
    expect(updated.props.table.defaultCellStyle).toEqual(tableShape.props.table.defaultCellStyle);
    expect(updated.props.table.cells[0]?.content).toEqual([expect.objectContaining({ type: "paragraph", children: [{ type: "text", text: "B" }] })]);
    expect(updated.props.table.cells.slice(1)).toEqual(tableShape.props.table.cells.slice(1));
  });

  it("reports a missing expected shape separately from a stale shape", () => {
    const props = createTableShapeProps("plain", 320, 140);
    const tableShape: OverlayShape = { id: "table_1", type: "tableShape", x: 80, y: 160, props };
    const harness = createHarness(baseDocument([tableShape]));
    expect(() => harness.tool("update_table").execute({ expectedRevision: 0, shapeId: "table_1", cellPatches: [{ row: 0, col: 0, content: "B" }] })).toThrow(
      "MISSING_EXPECTED_SHAPE: Pass the exact shape object returned by inspect_document (overlayShapes) as expectedShape.",
    );
  });

  it("partially updates a shape in place and converts degrees to radians", async () => {
    const shape: OverlayShape = { id: "shape_1", type: "geo", x: 20, y: 30, rotation: 0, props: { w: 120, h: 80, geo: "rectangle", fill: "none", color: "#111827", labelColor: "#111827", dash: "solid", size: "m" } };
    const harness = createHarness(baseDocument([shape]));
    await harness.tool("update_shape").execute({ expectedRevision: 0, shapeId: "shape_1", expectedShape: shape, x: 64, rotationDeg: 90, color: "#dc2626" });
    harness.apply();
    expect(currentShape(harness.getDocument(), "shape_1")).toMatchObject({ id: "shape_1", type: "geo", x: 64, y: 30, rotation: Math.PI / 2, props: { w: 120, h: 80, color: "#dc2626", fill: "none" } });
  });

  it("updates text shapes through the canonical overlay block model", async () => {
    const shape: OverlayShape = {
      id: "text_1",
      type: "text",
      x: 20,
      y: 30,
      props: {
        w: 120,
        h: 24,
        blocks: [{ type: "paragraph", id: "text_p_1", children: [{ type: "text", text: "Before" }] }],
        color: "#111827",
        size: "m",
      },
    };
    const harness = createHarness(baseDocument([shape]));
    await harness.tool("update_shape").execute({
      expectedRevision: 0,
      shapeId: "text_1",
      expectedShape: shape,
      text: "After",
      w: 180,
      fontSize: 18,
    });
    harness.apply();

    const updated = currentShape(harness.getDocument(), "text_1");
    expect(updated.type).toBe("text");
    if (updated.type !== "text") return;
    expect(updated.props.w).toBe(180);
    expect(updated.props.h).toBeGreaterThanOrEqual(24);
    expect(updated.props.blocks).toEqual([
      expect.objectContaining({
        type: "paragraph",
        children: [{ type: "text", text: "After" }],
      }),
    ]);
    expect(updated.props).not.toHaveProperty("richText");
  });

  it("preserves the legacy public sizing field while canonical normalization discards it", async () => {
    const shape: OverlayShape = {
      id: "text_legacy_sizing",
      type: "text",
      x: 20,
      y: 30,
      props: {
        w: 120,
        h: 24,
        blocks: [{ type: "paragraph", id: "legacy_p", children: [{ type: "text", text: "Unchanged" }] }],
        color: "#111827",
        size: "m",
      },
    };
    const document = baseDocument([shape]);
    const harness = createHarness(document, "public");
    const tool = harness.tool("update_overlay");

    expect(tool.inputSchema.properties).toHaveProperty("autoSize", { type: "boolean" });
    await tool.execute({
      expectedRevision: 0,
      shapeId: shape.id,
      expectedShape: shape,
      autoSize: true,
    });
    expect(harness.getDocument()).toBe(document);
    expect(harness.getProposal()).not.toBeNull();
    harness.apply();
    expect(currentShape(harness.getDocument(), shape.id)).toEqual(shape);
    expect(currentShape(harness.getDocument(), shape.id).props).not.toHaveProperty("autoSize");
  });

  it("replaces a text shape with multi-block Markdown", async () => {
    const shape: OverlayShape = {
      id: "text_markdown_update",
      type: "text",
      x: 20,
      y: 30,
      props: {
        w: 180,
        h: 24,
        blocks: [{ type: "paragraph", id: "text_markdown_before", children: [{ type: "text", text: "Before" }] }],
        color: "#111827",
        size: "m",
      },
    };
    const harness = createHarness(baseDocument([shape]), "public");
    await harness.tool("update_overlay").execute({
      expectedRevision: 0,
      shapeId: shape.id,
      expectedShape: shape,
      markdown: "## After\n\n値は $x^2$。\n\n- 一つ",
    });
    harness.apply();

    const updated = currentShape(harness.getDocument(), shape.id);
    expect(updated.type === "text" ? updated.props.blocks.map((block) => block.type) : []).toEqual(["heading", "paragraph", "list"]);
  });

  it("formats canonical overlay blocks without restoring the retired richText document", async () => {
    const shape: OverlayShape = {
      id: "text_1",
      type: "text",
      x: 20,
      y: 30,
      props: {
        w: 120,
        h: 24,
        blocks: [{ type: "paragraph", id: "text_p_1", children: [{ type: "text", text: "Styled" }] }],
        color: "#111827",
        size: "m",
      },
    };
    const harness = createHarness(baseDocument([shape]));
    await harness.tool("apply_edits").execute({
      expectedRevision: 0,
      operations: [{
        op: "format_inline",
        target: { type: "shape", shapeId: "text_1" },
        style: { fontFamily: "serif" },
      }],
    });
    harness.apply();

    const updated = currentShape(harness.getDocument(), "text_1");
    expect(updated.type).toBe("text");
    if (updated.type !== "text") return;
    expect(updated.props.blocks[0]).toMatchObject({
      type: "paragraph",
      children: [{ type: "text", text: "Styled", fontFamily: "serif" }],
    });
    expect(updated.props).not.toHaveProperty("richText");
  });

  it("partially updates page layout and preserves unrelated layout settings", async () => {
    const harness = createHarness(); const before = harness.getDocument().pageLayout!;
    await harness.tool("update_page_layout").execute({ expectedRevision: 0, orientation: "landscape", marginsMm: { left: 18 } });
    harness.apply(); const after = harness.getDocument().pageLayout!;
    expect(after.orientation).toBe("landscape"); expect(after.marginsMm.left).toBe(18); expect(after.flow).toEqual(before.flow);
    expect(after.header?.enabled).toBe(false); expect(after.footer?.enabled).toBe(false);
  });

  it("accumulates two writes into one proposal and withdraws the whole draft", async () => {
    const harness = createHarness();
    parseResult(await harness.tool("insert_body_content").execute({ expectedRevision: 0, targetId: "p_existing", blocks: [{ id: "p_added", text: "Added" }] }));
    const second = parseResult(await harness.tool("update_rich_content").execute({ expectedRevision: 0, blockId: "p_second", expectedContent: "Second paragraph", text: "Updated second" }));
    expect(second).toMatchObject({ proposalId: WEB_MCP_PROPOSAL_ID, operationCount: 2 });
    expect(harness.getProposalUpdates()).toHaveLength(2); expect(harness.getProposal()?.operationCount).toBe(2);
    expect(parseResult(await harness.tool("get_pending_proposal").execute({}))).toMatchObject({ pending: true, operationCount: 2 });
    expect(parseResult(await harness.tool("withdraw_pending_proposal").execute({}))).toMatchObject({ withdrawn: true });
    expect(harness.getProposal()).toBeNull(); expect(findBlock(harness.getDocument(), "p_added")).toBeNull();
  });

  it("rebases an update and a following operation over an unrelated human block edit (acceptance 1)", async () => {
    const harness = createHarness();
    await harness.tool("update_rich_content").execute({ expectedRevision: 0, blockId: "p_existing", expectedContent: "Original text", text: "Agent edit" });
    harness.humanEdit({
      ...harness.getDocument(),
      content: [harness.getDocument().content[0]!, { type: "paragraph", id: "p_second", children: [{ type: "text", text: "Human edit B" }] }],
    });
    await harness.tool("insert_body_content").execute({ expectedRevision: 0, targetId: END_OF_DOCUMENT_TARGET, blocks: [{ id: "p_added", text: "Agent addition" }] });
    harness.apply();
    expect(blockToReferenceText(findBlock(harness.getDocument(), "p_existing")!)).toBe("Agent edit");
    expect(blockToReferenceText(findBlock(harness.getDocument(), "p_second")!)).toBe("Human edit B");
    expect(blockToReferenceText(findBlock(harness.getDocument(), "p_added")!)).toBe("Agent addition");
  });

  it("rejects a human change to the updated block with its target ID (acceptance 2)", async () => {
    const harness = createHarness();
    expect(() => harness.tool("update_rich_content").execute({ expectedRevision: 0, blockId: "p_existing", expectedContent: "stale", text: "No" })).toThrow("STALE_TARGET");
    await harness.tool("update_rich_content").execute({ expectedRevision: 0, blockId: "p_existing", expectedContent: "Original text", text: "Agent edit" });
    const pending = harness.getProposal()!;
    harness.humanEdit({ ...harness.getDocument(), content: [{ type: "paragraph", id: "p_existing", children: [{ type: "text", text: "Human edit" }] }, harness.getDocument().content[1]!] });
    expect(() => pending.apply(harness.getDocument())).toThrow(/STALE_DRAFT.*p_existing/);
    expect(() => harness.tool("insert_body_content").execute({ expectedRevision: 0, targetId: "p_second", blocks: ["Another edit"] })).toThrow(/STALE_DRAFT.*p_existing/);
  });

  it("rebases insertion after A over an unrelated B edit (acceptance 3)", async () => {
    const harness = createHarness();
    await harness.tool("insert_body_content").execute({ expectedRevision: 0, targetId: "p_existing", blocks: [{ id: "p_ai", text: "AI" }] });
    harness.humanEdit({ ...harness.getDocument(), content: [harness.getDocument().content[0]!, { type: "paragraph", id: "p_second", children: [{ type: "text", text: "Human B" }] }] });
    harness.apply();
    expect(harness.getDocument().content.map((block) => block.id)).toEqual(["p_existing", "p_ai", "p_second"]);
    expect(blockToReferenceText(findBlock(harness.getDocument(), "p_second")!)).toBe("Human B");
  });

  it("rejects insertion when its anchor was deleted (acceptance 4)", async () => {
    const harness = createHarness();
    await harness.tool("insert_body_content").execute({ expectedRevision: 0, targetId: "p_existing", blocks: [{ id: "p_ai", text: "AI" }] });
    const pending = harness.getProposal()!;
    harness.humanEdit({ ...harness.getDocument(), content: [harness.getDocument().content[1]!] });
    expect(() => pending.apply(harness.getDocument())).toThrow(/STALE_DRAFT.*p_existing/);
  });

  it("inserts at the current document end after unrelated revision drift (acceptance 5)", async () => {
    const harness = createHarness();
    await harness.tool("insert_body_content").execute({ expectedRevision: 0, targetId: END_OF_DOCUMENT_TARGET, blocks: [{ id: "p_ai", text: "AI end" }] });
    harness.humanEdit({ ...harness.getDocument(), content: [...harness.getDocument().content, { type: "paragraph", id: "p_human", children: [{ type: "text", text: "Human end" }] }] });
    harness.apply();
    expect(harness.getDocument().content.map((block) => block.id).slice(-2)).toEqual(["p_human", "p_ai"]);
  });

  it("preserves the call order of multiple END_OF_DOCUMENT insertions during replay", async () => {
    const harness = createHarness();
    await harness.tool("insert_body_content").execute({ expectedRevision: 0, targetId: END_OF_DOCUMENT_TARGET, blocks: [{ id: "p_ai_first", text: "AI first" }] });
    await harness.tool("insert_body_content").execute({ expectedRevision: 0, targetId: END_OF_DOCUMENT_TARGET, blocks: [{ id: "p_ai_second", text: "AI second" }] });
    harness.humanEdit({
      ...harness.getDocument(),
      content: [...harness.getDocument().content, { type: "paragraph", id: "p_human_end", children: [{ type: "text", text: "Human end" }] }],
    });
    expect(harness.getProposal()!.previewDraft.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: "insertAfter", targetId: "p_human_end", insertedBlock: expect.objectContaining({ id: "p_ai_first" }) }),
      expect.objectContaining({ operation: "insertAfter", targetId: "p_ai_first", insertedBlock: expect.objectContaining({ id: "p_ai_second" }) }),
    ]));
    harness.apply();
    expect(harness.getDocument().content.map((block) => block.id).slice(-3)).toEqual(["p_human_end", "p_ai_first", "p_ai_second"]);
  });

  it("preserves a human edit to shape B while updating shape A (acceptance 6)", async () => {
    const shapeA: OverlayShape = { id: "shape_a", type: "geo", x: 10, y: 20, props: { w: 80, h: 50, geo: "rectangle", fill: "none", color: "#111827", labelColor: "#111827", dash: "solid", size: "m" } };
    const shapeB: OverlayShape = { ...shapeA, id: "shape_b", x: 120 };
    const harness = createHarness(baseDocument([shapeA, shapeB]));
    await harness.tool("update_shape").execute({ expectedRevision: 0, shapeId: "shape_a", expectedShape: shapeA, x: 40 });
    harness.humanEdit({ ...harness.getDocument(), pageLayout: { ...harness.getDocument().pageLayout!, overlay: { ...harness.getDocument().pageLayout!.overlay!, overlaySnapshot: { version: 1, assets: {}, shapes: [shapeA, { ...shapeB, y: 90 }] } } } });
    harness.apply();
    expect(currentShape(harness.getDocument(), "shape_a").x).toBe(40);
    expect(currentShape(harness.getDocument(), "shape_b").y).toBe(90);
  });

  it("rejects concurrent changes to the same page-settings region (acceptance 7)", async () => {
    const harness = createHarness();
    await harness.tool("update_page_layout").execute({ expectedRevision: 0, orientation: "landscape" });
    const pending = harness.getProposal()!;
    harness.humanEdit({ ...harness.getDocument(), pageLayout: { ...harness.getDocument().pageLayout!, marginsMm: { ...harness.getDocument().pageLayout!.marginsMm, left: 25 } } });
    expect(() => pending.apply(harness.getDocument())).toThrow(/STALE_DRAFT.*pageLayout/);
  });

  it("accepts comments and updatedAt-only drift (acceptance 8)", async () => {
    const harness = createHarness();
    await harness.tool("update_rich_content").execute({ expectedRevision: 0, blockId: "p_existing", expectedContent: "Original text", text: "Agent edit" });
    harness.humanEdit({
      ...harness.getDocument(),
      updatedAt: "2026-08-30T01:00:00.000Z",
      comments: [{ id: "comment_human", anchor: { type: "block", blockId: "p_second" }, messages: [{ id: "message_human", body: [{ type: "text", text: "Keep" }], createdAt: "2026-08-30T01:00:00.000Z" }], createdAt: "2026-08-30T01:00:00.000Z" }],
    });
    harness.apply();
    expect(harness.getDocument().comments?.[0]?.id).toBe("comment_human");
    expect(blockToReferenceText(findBlock(harness.getDocument(), "p_existing")!)).toBe("Agent edit");
  });

  it("accepts revision-only drift when the structure is equal (acceptance 9)", async () => {
    const harness = createHarness();
    await harness.tool("update_rich_content").execute({ expectedRevision: 0, blockId: "p_existing", expectedContent: "Original text", text: "Agent edit" });
    harness.humanEdit(structuredClone(harness.getDocument()));
    harness.apply();
    expect(blockToReferenceText(findBlock(harness.getDocument(), "p_existing")!)).toBe("Agent edit");
  });

  it("rejects an occupied generated ID and keeps the generated ID stable across replay (acceptance 10)", async () => {
    const harness = createHarness();
    await harness.tool("insert_body_content").execute({ expectedRevision: 0, targetId: "p_existing", blocks: [{ text: "Generated ID" }] });
    const inserted = harness.getProposal()!.previewDraft.operations.find((operation) => operation.operation === "insertAfter");
    if (!inserted || inserted.operation !== "insertAfter") throw new Error("Missing inserted operation");
    const generatedId = inserted.insertedBlock.id;
    harness.humanEdit({ ...harness.getDocument(), content: [...harness.getDocument().content, { type: "paragraph", id: generatedId, children: [{ type: "text", text: "Collision" }] }] });
    expect(() => harness.getProposal()!.apply(harness.getDocument())).toThrow(new RegExp(`STALE_DRAFT.*${generatedId}`));
    expect(harness.getProposal()!.previewDraft.operations.find((operation) => operation.operation === "insertAfter")).toMatchObject({ insertedBlock: { id: generatedId } });
  });

  it("rejects a human collision with an ID nested inside an inserted problem", async () => {
    const harness = createHarness();
    await harness.tool("create_problem_content").execute({
      expectedRevision: 0,
      targetId: "p_second",
      id: "problem_with_nested_ids",
      prompt: { id: "prompt_collision", text: "Solve it." },
    });
    const pending = harness.getProposal()!;
    harness.humanEdit({
      ...harness.getDocument(),
      content: [
        ...harness.getDocument().content,
        { type: "paragraph", id: "prompt_collision", children: [{ type: "text", text: "Human block" }] },
      ],
    });
    expect(() => pending.apply(harness.getDocument())).toThrow(/STALE_DRAFT.*prompt_collision/);
  });

  it("keeps an implicitly generated post-problem paragraph stable when a later draft operation edits it", async () => {
    const harness = createHarness();
    await harness.tool("create_problem_content").execute({
      expectedRevision: 0,
      targetId: "p_second",
      id: "problem_generated_body",
      prompt: { id: "prompt_generated_body", text: "Solve it." },
    });
    const draftDocument = parseResult(await harness.tool("read_document").execute({ detail: "full" })).document as SigmaDocument;
    const problemIndex = draftDocument.content.findIndex((item) => item.type === "problem");
    expect(problemIndex).toBeGreaterThanOrEqual(0);
    const generatedParagraphId = draftDocument.content[problemIndex + 1]?.id;
    expect(generatedParagraphId).toMatch(/^p_[0-9a-f-]+$/);
    expect(harness.getProposal()!.previewDraft.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: "insertAfter", insertedBlock: expect.objectContaining({ id: generatedParagraphId }) }),
    ]));
    await harness.tool("update_rich_content").execute({
      expectedRevision: 0,
      blockId: generatedParagraphId,
      expectedContent: "",
      text: "Agent edited generated paragraph",
    });
    harness.humanEdit({
      ...harness.getDocument(),
      content: [{ type: "paragraph", id: "p_existing", children: [{ type: "text", text: "Human unrelated" }] }, harness.getDocument().content[1]!],
    });
    harness.apply();
    expect(blockToReferenceText(findBlock(harness.getDocument(), generatedParagraphId!)!)).toBe("Agent edited generated paragraph");
  });

  it("keeps an implicitly generated layout-section ID stable for a following section update", async () => {
    const harness = createHarness();
    await harness.tool("update_column_layout").execute({
      expectedRevision: 0,
      scope: "blocks",
      blockIds: ["p_existing", "p_second"],
      columnCount: 2,
    });
    const outline = parseResult(await harness.tool("get_document_outline").execute({})).outline as Array<{ id: string; type: string }>;
    const sectionId = outline.find((item) => item.type === "layoutSection")?.id;
    expect(sectionId).toMatch(/^layout_/);
    await harness.tool("update_column_layout").execute({ expectedRevision: 0, scope: "section", sectionId, columnCount: 3 });
    harness.humanEdit({ ...harness.getDocument(), metadata: { ...harness.getDocument().metadata, title: "Human title" } });
    harness.apply();
    expect(findBlock(harness.getDocument(), sectionId!)).toMatchObject({ type: "layoutSection", layout: { columnCount: 3 } });
  });

  it("rejects a human insertion inside a pending column-wrap range with target IDs", async () => {
    const harness = createHarness();
    await harness.tool("update_column_layout").execute({
      expectedRevision: 0,
      scope: "blocks",
      blockIds: ["p_existing", "p_second"],
      columnCount: 2,
    });
    const pending = harness.getProposal()!;
    harness.humanEdit({
      ...harness.getDocument(),
      content: [
        harness.getDocument().content[0]!,
        { type: "paragraph", id: "p_human_inside", children: [{ type: "text", text: "Human inside" }] },
        harness.getDocument().content[1]!,
      ],
    });
    expect(() => pending.apply(harness.getDocument())).toThrow(/STALE_DRAFT.*p_existing.*p_second/);
  });

  it("rebases an insert-then-wrap draft over an unrelated human edit", async () => {
    const harness = createHarness();
    await harness.tool("insert_body_content").execute({
      expectedRevision: 0,
      targetId: "p_existing",
      blocks: [{ id: "p_ai_first", text: "AI first" }, { id: "p_ai_second", text: "AI second" }],
    });
    await harness.tool("update_column_layout").execute({
      expectedRevision: 0,
      scope: "blocks",
      blockIds: ["p_ai_first", "p_ai_second"],
      columnCount: 2,
    });
    harness.humanEdit({ ...harness.getDocument(), metadata: { ...harness.getDocument().metadata, title: "Human title" } });
    harness.apply();
    expect(findBlock(harness.getDocument(), "p_ai_first")).not.toBeNull();
    expect(findBlock(harness.getDocument(), "p_ai_second")).not.toBeNull();
    expect(harness.getDocument().metadata.title).toBe("Human title");
  });

  it("rebases a move-then-wrap draft when the move makes the range contiguous", async () => {
    const initial = baseDocument();
    initial.content.splice(1, 0, { type: "paragraph", id: "p_middle", children: [{ type: "text", text: "Middle" }] });
    const harness = createHarness(initial);
    await harness.tool("move_blocks").execute({
      expectedRevision: 0,
      blockIds: ["p_second"],
      targetId: "p_existing",
      position: "after",
    });
    await harness.tool("update_column_layout").execute({
      expectedRevision: 0,
      scope: "blocks",
      blockIds: ["p_existing", "p_second"],
      columnCount: 2,
    });
    harness.humanEdit({ ...harness.getDocument(), metadata: { ...harness.getDocument().metadata, title: "Human title" } });
    harness.apply();
    expect(harness.getDocument().content[0]).toMatchObject({
      type: "layoutSection",
      children: [expect.objectContaining({ id: "p_existing" }), expect.objectContaining({ id: "p_second" })],
    });
    expect(harness.getDocument().metadata.title).toBe("Human title");
  });

  it("rebases a column wrap over an outside insertion and unrelated edit", async () => {
    const harness = createHarness();
    await harness.tool("update_column_layout").execute({
      expectedRevision: 0,
      scope: "blocks",
      blockIds: ["p_existing", "p_second"],
      columnCount: 2,
    });
    harness.humanEdit({
      ...harness.getDocument(),
      metadata: { ...harness.getDocument().metadata, title: "Human title" },
      content: [
        ...harness.getDocument().content,
        { type: "paragraph", id: "p_human_outside", children: [{ type: "text", text: "Human outside" }] },
      ],
    });
    harness.apply();
    expect(harness.getDocument().content).toEqual([
      expect.objectContaining({
        type: "layoutSection",
        children: [expect.objectContaining({ id: "p_existing" }), expect.objectContaining({ id: "p_second" })],
      }),
      expect.objectContaining({ id: "p_human_outside" }),
    ]);
    expect(harness.getDocument().metadata.title).toBe("Human title");
  });

  it("rejects a concurrent human relocation of a block targeted by move_blocks", async () => {
    const harness = createHarness();
    await harness.tool("move_blocks").execute({ expectedRevision: 0, blockIds: ["p_existing"], targetId: "p_second", position: "after" });
    const pending = harness.getProposal()!;
    harness.humanEdit({ ...harness.getDocument(), content: [harness.getDocument().content[1]!, harness.getDocument().content[0]!] });
    expect(() => pending.apply(harness.getDocument())).toThrow(/STALE_DRAFT.*p_existing/);
  });

  it("rejects a concurrent placement change around a concrete move_blocks destination", async () => {
    const initial = baseDocument();
    initial.content.push({ type: "paragraph", id: "p_tail", children: [{ type: "text", text: "Tail" }] });
    const harness = createHarness(initial);
    await harness.tool("move_blocks").execute({ expectedRevision: 0, blockIds: ["p_existing"], targetId: "p_second", position: "before" });
    const pending = harness.getProposal()!;
    harness.humanEdit({
      ...harness.getDocument(),
      content: [
        harness.getDocument().content[0]!,
        harness.getDocument().content[1]!,
        { type: "paragraph", id: "p_human", children: [{ type: "text", text: "Human" }] },
        harness.getDocument().content[2]!,
      ],
    });
    expect(() => pending.apply(harness.getDocument())).toThrow(/STALE_DRAFT.*p_second/);
  });

  it("validates repeated moves sequentially after an unrelated human edit", async () => {
    const initial = baseDocument();
    initial.content.push({ type: "paragraph", id: "p_third", children: [{ type: "text", text: "Third" }] });
    const harness = createHarness(initial);
    await harness.tool("move_blocks").execute({ expectedRevision: 0, blockIds: ["p_existing"], targetId: "p_second", position: "after" });
    await harness.tool("move_blocks").execute({ expectedRevision: 0, blockIds: ["p_existing"], targetId: "p_third", position: "after" });
    harness.humanEdit({ ...harness.getDocument(), metadata: { ...harness.getDocument().metadata, title: "Human title" } });
    harness.apply();
    expect(harness.getDocument().content.map((block) => block.id)).toEqual(["p_second", "p_third", "p_existing"]);
  });

  it("validates a move against the replayed state of a preceding column wrap", async () => {
    const initial = baseDocument();
    initial.content.push({ type: "paragraph", id: "p_tail", children: [{ type: "text", text: "Tail" }] });
    const harness = createHarness(initial);
    await harness.tool("update_column_layout").execute({ expectedRevision: 0, scope: "blocks", blockIds: ["p_existing", "p_second"], columnCount: 2 });
    await harness.tool("move_blocks").execute({ expectedRevision: 0, blockIds: ["p_existing"], targetId: "p_tail", position: "after" });
    harness.humanEdit({ ...harness.getDocument(), metadata: { ...harness.getDocument().metadata, title: "Human title" } });
    harness.apply();
    expect(harness.getDocument().content.map((block) => block.id).slice(-2)).toEqual(["p_tail", "p_existing"]);
    expect(findBlock(harness.getDocument(), "p_second")).not.toBeNull();
  });

  it("keeps END_OF_DOCUMENT dynamic when replaying move_blocks", async () => {
    const harness = createHarness();
    await harness.tool("move_blocks").execute({ expectedRevision: 0, blockIds: ["p_existing"], targetId: END_OF_DOCUMENT_TARGET, position: "after" });
    harness.humanEdit({
      ...harness.getDocument(),
      content: [...harness.getDocument().content, { type: "paragraph", id: "p_human_end", children: [{ type: "text", text: "Human end" }] }],
    });
    harness.apply();
    expect(harness.getDocument().content.map((block) => block.id).slice(-2)).toEqual(["p_human_end", "p_existing"]);
  });

  it("rejects applying an end insertion after the open document changes", async () => {
    const harness = createHarness();
    await harness.tool("insert_body_content").execute({ expectedRevision: 0, targetId: END_OF_DOCUMENT_TARGET, blocks: [{ id: "p_ai", text: "AI" }] });
    const pending = harness.getProposal()!;
    harness.humanEdit({ ...harness.getDocument(), docId: "doc_other" });
    expect(() => pending.apply(harness.getDocument())).toThrow(/STALE_DRAFT.*docId/);
    expect(parseResult(await harness.tool("get_pending_proposal").execute({}))).toMatchObject({ currentRevision: 1, conflictIds: ["docId"] });
  });

  it("applies no part of a multi-operation draft when one target conflicts (acceptance 11)", async () => {
    const harness = createHarness();
    await harness.tool("update_rich_content").execute({ expectedRevision: 0, blockId: "p_existing", expectedContent: "Original text", text: "AI A" });
    await harness.tool("update_rich_content").execute({ expectedRevision: 0, blockId: "p_second", expectedContent: "Second paragraph", text: "AI B" });
    const pending = harness.getProposal()!;
    harness.humanEdit({ ...harness.getDocument(), content: [harness.getDocument().content[0]!, { type: "paragraph", id: "p_second", children: [{ type: "text", text: "Human B" }] }] });
    expect(() => pending.apply(harness.getDocument())).toThrow(/STALE_DRAFT.*p_second/);
    expect(blockToReferenceText(findBlock(harness.getDocument(), "p_existing")!)).toBe("Original text");
    expect(blockToReferenceText(findBlock(harness.getDocument(), "p_second")!)).toBe("Human B");
  });

  it("regenerates the preview over the latest human document (acceptance 12)", async () => {
    const harness = createHarness();
    await harness.tool("update_rich_content").execute({ expectedRevision: 0, blockId: "p_existing", expectedContent: "Original text", text: "AI A" });
    harness.humanEdit({ ...harness.getDocument(), content: [harness.getDocument().content[0]!, { type: "paragraph", id: "p_second", children: [{ type: "text", text: "Human B" }] }] });
    await harness.tool("insert_body_content").execute({ expectedRevision: 0, targetId: END_OF_DOCUMENT_TARGET, blocks: [{ id: "p_ai", text: "AI end" }] });
    const proposal = harness.getProposal()!;
    expect(proposal.previewDraft.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetId: "p_existing", replacementBlock: expect.objectContaining({ id: "p_existing" }) }),
      expect.objectContaining({ insertedBlock: expect.objectContaining({ id: "p_ai" }) }),
    ]));
    const previewed = proposal.apply(harness.getDocument()).document;
    expect(blockToReferenceText(findBlock(previewed, "p_second")!)).toBe("Human B");
    expect(findBlock(previewed, "p_ai")).not.toBeNull();
  });

  it("keeps human insertions at a shared insertion point before AI insertions", async () => {
    const harness = createHarness();
    await harness.tool("insert_body_content").execute({ expectedRevision: 0, targetId: "p_existing", blocks: [{ id: "p_ai", text: "AI" }] });
    harness.humanEdit({ ...harness.getDocument(), content: [harness.getDocument().content[0]!, { type: "paragraph", id: "p_human", children: [{ type: "text", text: "Human" }] }, harness.getDocument().content[1]!] });
    expect(harness.getProposal()!.previewDraft.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: "insertAfter", targetId: "p_human", insertedBlock: expect.objectContaining({ id: "p_ai" }) }),
    ]));
    harness.apply();
    expect(harness.getDocument().content.map((block) => block.id)).toEqual(["p_existing", "p_human", "p_ai", "p_second"]);
  });

  it("keeps the latest human document as the single Undo boundary (acceptance 13)", async () => {
    const harness = createHarness();
    await harness.tool("update_rich_content").execute({ expectedRevision: 0, blockId: "p_existing", expectedContent: "Original text", text: "AI A" });
    harness.humanEdit({ ...harness.getDocument(), content: [harness.getDocument().content[0]!, { type: "paragraph", id: "p_second", children: [{ type: "text", text: "Human B" }] }] });
    const latestBeforeApply = structuredClone(harness.getDocument());
    harness.apply();
    harness.undo();
    expect(harness.getDocument()).toEqual(latestBeforeApply);
  });

  it("returns the live document and structured conflict details after approval fails", async () => {
    const harness = createHarness();
    await harness.tool("update_rich_content").execute({ expectedRevision: 0, blockId: "p_existing", expectedContent: "Original text", text: "AI edit" });
    const pending = harness.getProposal()!;
    harness.humanEdit({
      ...harness.getDocument(),
      content: [{ type: "paragraph", id: "p_existing", children: [{ type: "text", text: "Human edit" }] }, harness.getDocument().content[1]!],
    });
    expect(() => pending.apply(harness.getDocument())).toThrow(/STALE_DRAFT.*p_existing/);
    const read = parseResult(await harness.tool("read_document").execute({ detail: "full" }));
    expect(blockToReferenceText(findBlock(read.document as SigmaDocument, "p_existing")!)).toBe("Human edit");
    expect(parseResult(await harness.tool("get_pending_proposal").execute({}))).toMatchObject({
      pending: true,
      currentRevision: 1,
      conflictIds: ["p_existing"],
    });
  });

  it("rolls back every apply_edits operation when a later operation fails", async () => {
    const harness = createHarness();
    expect(() => harness.tool("apply_edits").execute({
      expectedRevision: 0,
      operations: [
        { op: "replace_text", target: { type: "text", blockId: "p_existing", text: "Original" }, replacement: "Changed" },
        { op: "replace_text", target: { type: "text", blockId: "missing", text: "anything" }, replacement: "No" },
      ],
    })).toThrow("Editable paragraph or heading not found");
    expect(parseResult(await harness.tool("get_pending_proposal").execute({}))).toMatchObject({ pending: false });
    await harness.tool("update_rich_content").execute({ expectedRevision: 0, blockId: "p_existing", expectedContent: "Original text", text: "Clean retry" });
    expect(harness.getProposal()).toMatchObject({ operationCount: 1 });
  });

  it("keeps each published proposal bound to its reviewed immutable document snapshot", async () => {
    const harness = createHarness();
    await harness.tool("update_rich_content").execute({ expectedRevision: 0, blockId: "p_existing", expectedContent: "Original text", text: "First draft" });
    const firstProposal = harness.getProposal()!;
    await harness.tool("update_rich_content").execute({ expectedRevision: 0, blockId: "p_second", expectedContent: "Second paragraph", text: "Second draft" });
    const firstDocument = firstProposal.apply(harness.getDocument()).document;
    expect(blockToReferenceText(findBlock(firstDocument, "p_existing")!)).toBe("First draft");
    expect(blockToReferenceText(findBlock(firstDocument, "p_second")!)).toBe("Second paragraph");
  });

  it("pins an AI comment to an exact phrase, records who wrote it, and applies without approval", async () => {
    const harness = createHarness(baseDocument(), "public");
    const result = parseResult(await harness.tool("add_comment").execute({
      author: { name: "ChatGPT", vendor: "openai", model: "gpt-5" },
      target: { blockId: "p_existing", text: "Original" },
      text: "ここは $x^2$ の説明に寄せた方が読みやすいです。",
    }));

    expect(result).toMatchObject({ ok: true, status: "posted" });
    expect(harness.getProposal()).toBeNull();
    const thread = harness.getDocument().comments?.[0];
    expect(thread?.anchor).toEqual({
      type: "textRange",
      start: { blockId: "p_existing", offset: 0 },
      end: { blockId: "p_existing", offset: 8 },
      quote: "Original",
    });
    expect(thread?.messages[0]).toMatchObject({ authorName: "ChatGPT", agent: { vendor: "openai", model: "gpt-5" } });
    expect(thread?.messages[0]?.body).toEqual([
      { type: "text", text: "ここは " },
      expect.objectContaining({ type: "mathInline", tex: "x^2" }),
      { type: "text", text: " の説明に寄せた方が読みやすいです。" },
    ]);
  });

  it("normalizes a product name into the vendor whose logo is drawn", async () => {
    const harness = createHarness(baseDocument(), "public");
    await harness.tool("add_comment").execute({
      author: { name: "Claude", vendor: "Claude Opus" },
      target: { blockId: "p_second" },
      text: "図を1つ足すと伝わりやすいです。",
    });
    expect(harness.getDocument().comments?.[0]?.messages[0]?.agent).toEqual({ vendor: "anthropic" });
  });

  it("anchors to a whole block, an inline formula, and an overlay shape", async () => {
    const shape: OverlayShape = { id: "shape_note", type: "geo", x: 20, y: 30, rotation: 0, props: { w: 120, h: 80, geo: "rectangle", fill: "none", color: "#111827", labelColor: "#111827", dash: "solid", size: "m" } };
    const document = baseDocument([shape]);
    const harness = createHarness({
      ...document,
      content: [
        { type: "paragraph", id: "p_math", children: [{ type: "text", text: "式 " }, { type: "mathInline", id: "m_1", tex: "x^2", display: "inline" }] },
        ...document.content,
      ],
    }, "public");

    await harness.tool("add_comment").execute({ author: { name: "ChatGPT", vendor: "openai" }, target: { blockId: "p_math" }, text: "全体への指摘" });
    await harness.tool("add_comment").execute({ author: { name: "ChatGPT", vendor: "openai" }, target: { blockId: "p_math", mathInlineId: "m_1" }, text: "数式への指摘" });
    await harness.tool("add_comment").execute({ author: { name: "ChatGPT", vendor: "openai" }, target: { shapeIds: ["shape_note"] }, text: "図形への指摘" });

    expect(harness.getDocument().comments?.map((thread) => thread.anchor.type)).toEqual(["block", "inlineMath", "overlayShape"]);
    expect(harness.getDocument().comments?.[1]?.anchor).toMatchObject({ type: "inlineMath", blockId: "p_math", mathInlineId: "m_1", tex: "x^2" });
  });

  it("rejects a comment whose target is not in the document", async () => {
    const harness = createHarness(baseDocument(), "public");
    expect(() => harness.tool("add_comment").execute({
      author: { name: "ChatGPT", vendor: "openai" },
      target: { blockId: "p_existing", text: "not present" },
      text: "…",
    })).toThrow(/Text not found/);
    expect(harness.getDocument().comments ?? []).toHaveLength(0);
  });

  it("replies, resolves, and lists threads with the author on each message", async () => {
    const harness = createHarness(baseDocument(), "public");
    const created = parseResult(await harness.tool("add_comment").execute({
      author: { name: "ChatGPT", vendor: "openai" },
      target: { blockId: "p_second" },
      text: "この段落は結論が先の方がよいです。",
    })) as { threadId: string };

    await harness.tool("reply_comment").execute({ author: { name: "Claude", vendor: "anthropic" }, threadId: created.threadId, text: "同意です。" });
    expect(parseResult(await harness.tool("resolve_comment").execute({ threadId: created.threadId }))).toMatchObject({ status: "resolved", resolved: true });
    expect(parseResult(await harness.tool("resolve_comment").execute({ threadId: created.threadId }))).toMatchObject({ status: "unchanged" });

    expect(parseResult(await harness.tool("list_comments").execute({}))).toMatchObject({ total: 0 });
    const listed = parseResult(await harness.tool("list_comments").execute({ includeResolved: true })) as { threads: Array<Record<string, unknown>> };
    expect(listed.threads[0]).toMatchObject({
      resolved: true,
      messages: [
        { author: "ChatGPT", agent: { vendor: "openai" } },
        { author: "Claude", agent: { vendor: "anthropic" }, text: "同意です。" },
      ],
    });
  });

  it("lets an agent comment while its own edit draft is pending, and carries the comment through approval", async () => {
    const harness = createHarness();
    await harness.tool("update_rich_content").execute({ expectedRevision: 0, blockId: "p_existing", expectedContent: "Original text", text: "Agent edit" });

    await harness.tool("add_comment").execute({
      author: { name: "ChatGPT", vendor: "openai" },
      target: { blockId: "p_second" },
      text: "こちらは次の推敲で直します。",
    });

    // コメントで revision が進んでも、エージェントが握っている本文の前提は動かない。
    expect(parseResult(await harness.tool("get_document_outline").execute({}))).toMatchObject({ revision: 0 });
    await harness.tool("update_rich_content").execute({ expectedRevision: 0, blockId: "p_second", expectedContent: "Second paragraph", text: "Agent edit 2" });

    harness.apply();
    expect(blockToReferenceText(findBlock(harness.getDocument(), "p_existing")!)).toBe("Agent edit");
    expect(harness.getDocument().comments).toHaveLength(1);
  });

  it("keeps a human comment made while a draft is pending", async () => {
    const harness = createHarness();
    await harness.tool("update_rich_content").execute({ expectedRevision: 0, blockId: "p_existing", expectedContent: "Original text", text: "Agent edit" });
    const pending = harness.getProposal()!;
    harness.humanEdit({
      ...harness.getDocument(),
      comments: [{ id: "comment_human", anchor: { type: "block", blockId: "p_second" }, messages: [{ id: "msg_human", authorName: "ゲスト", body: [{ type: "text", text: "確認しました" }], createdAt: "2026-08-30T00:30:00.000Z" }], createdAt: "2026-08-30T00:30:00.000Z" }],
    });
    const applied = pending.apply(harness.getDocument()).document;
    expect(applied.comments?.map((thread) => thread.id)).toEqual(["comment_human"]);
    expect(blockToReferenceText(findBlock(applied, "p_existing")!)).toBe("Agent edit");
  });
});
