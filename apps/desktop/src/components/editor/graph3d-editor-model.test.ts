import { describe, expect, it } from "vitest";

import type { Graph3DSpec } from "@/features/document";
import { buildGraph3DObjectGeometry, createGraph3DThumbnailObject } from "@/features/drawing";

import {
  buildGraph3DObjectChoiceGroups,
  createGraph3DIntersectionOnlySpec,
  createGraph3DIntersectionRegion,
  createGraph3DObjectFromChoice,
  createGraph3DPlaneDefinition,
  createGraph3DSectionFill,
  formatGraph3DInequality,
  graph3DExpressionToTex,
  parseGraph3DExpressionTex,
  parseGraph3DInequality,
} from "./graph3d-editor-model";

describe("3D settings editor model", () => {
  it("creates every mathematical object offered by the insert control", () => {
    expect(createGraph3DObjectFromChoice("parametricSurface")?.kind).toBe("parametricSurface");
    expect(createGraph3DObjectFromChoice("parametricCurve")?.kind).toBe("parametricCurve");
    expect(createGraph3DObjectFromChoice("revolution")?.kind).toBe("solidOfRevolution");
    expect(createGraph3DObjectFromChoice("polyhedron")?.kind).toBe("polyhedron");
    expect(createGraph3DObjectFromChoice("tetrahedron")?.kind).toBe("boundedSolid");
    expect(createGraph3DObjectFromChoice("implicit")?.kind).toBe("implicitSurface");
    expect(createGraph3DObjectFromChoice("unknown")).toBeNull();
  });

  /**
   * A default the card's own field rejects is what shipped: the field said `F(x,y,z) = 0` while
   * holding `x^2+y^2+z^2=1`, and committing that value unchanged answered "「=」を外し…".
   */
  it("gives the implicit surface a default in the form its name promises", () => {
    const object = createGraph3DObjectFromChoice("implicit");
    expect(object?.kind).toBe("implicitSurface");
    const expression = object?.kind === "implicitSurface" ? object.expression : "";
    expect(expression.endsWith("= 0")).toBe(true);
    expect(parseGraph3DExpressionTex(graph3DExpressionToTex(expression, "equation"), "equation"))
      .toHaveProperty("expression");
  });

  /**
   * Every card is drawn from the object it creates, so a default that meshes to nothing — the usual
   * way an implicit surface goes wrong is bounds that miss it — is an empty tile in the picker.
   */
  it("draws something for every card the picker offers", () => {
    for (const choice of buildGraph3DObjectChoiceGroups().flatMap((group) => group.choices)) {
      const object = createGraph3DObjectFromChoice(choice.value);
      expect(object).not.toBeNull();
      const geometry = buildGraph3DObjectGeometry(createGraph3DThumbnailObject(object!), {});
      expect(`${choice.value}:${geometry.positions.length > 0}`).toBe(`${choice.value}:true`);
    }
  });

  /** A card that names a kind nothing can build would be a dead tile in the picker. */
  it("builds an object for every card the picker offers, and offers no other", () => {
    const offered = buildGraph3DObjectChoiceGroups().flatMap((group) => group.choices);
    expect(offered.length).toBeGreaterThan(0);
    for (const choice of offered) {
      expect(`${choice.value}:${createGraph3DObjectFromChoice(choice.value) !== null}`)
        .toBe(`${choice.value}:true`);
      expect(choice.label.length).toBeGreaterThan(0);
    }
    // 立体の種類は「なくしていい」と言われた2つを含まない: z=f(x,y) と三角形の押し出し。
    expect(offered.map((choice) => choice.value)).not.toContain("surface");
    expect(offered.map((choice) => choice.value)).not.toContain("triangularPrism");
  });

  it("switches between equation, three-point, and point-normal plane definitions", () => {
    expect(createGraph3DPlaneDefinition("equation")).toEqual({ kind: "equation", expression: "z = 0" });
    expect(createGraph3DPlaneDefinition("threePoints")).toEqual(expect.objectContaining({
      kind: "threePoints",
      points: expect.arrayContaining([
        { x: "0", y: "0", z: "0" },
        { x: "1", y: "0", z: "0" },
        { x: "0", y: "1", z: "0" },
      ]),
    }));
    expect(createGraph3DPlaneDefinition("pointNormal")).toEqual(expect.objectContaining({
      kind: "pointNormal",
      normal: { x: "0", y: "0", z: "1" },
    }));
  });

  it("keeps solid and all three pattern fills explicit", () => {
    expect(createGraph3DSectionFill("solid", "#123456")).toEqual({
      mode: "solid",
      color: "#123456",
      opacity: 0.3,
    });
    for (const pattern of ["diagonal", "cross", "dots"] as const) {
      expect(createGraph3DSectionFill("pattern", "#d97706", pattern)).toEqual({
        mode: "pattern",
        color: "#d97706",
        opacity: 0.3,
        pattern,
      });
    }
    expect(createGraph3DSectionFill("none", "#d97706")).toEqual({ mode: "none" });
  });

  it("uses the current graph MathLive conversion boundary for functions and plane equations", () => {
    expect(parseGraph3DExpressionTex("\\sin(x)+y^2", "expression")).toEqual({
      expression: "sin(x)+y^2",
    });
    expect(parseGraph3DExpressionTex("x+y=\\frac{1}{2}", "equation")).toEqual({
      expression: "x+y=1/2",
    });
    expect(graph3DExpressionToTex("x+y=1/2", "equation")).toContain("=");
  });

  it("keeps an invalid MathLive draft out of the canonical expression", () => {
    expect(parseGraph3DExpressionTex("x+", "expression")).toEqual(expect.objectContaining({
      error: expect.any(String),
    }));
    expect(parseGraph3DExpressionTex("x+y", "equation")).toEqual(expect.objectContaining({
      error: expect.any(String),
    }));
    expect(parseGraph3DExpressionTex("x+y+z", "inequality")).toEqual(expect.objectContaining({
      error: expect.any(String),
    }));
  });
});

describe("3D の不等式入力", () => {
  it("左辺・不等号・右辺に分解する", () => {
    expect(parseGraph3DInequality("x + y + z <= 3")).toEqual({
      left: "x + y + z",
      operator: "<=",
      right: "3",
    });
    expect(parseGraph3DInequality("z>=0")).toEqual({ left: "z", operator: ">=", right: "0" });
    expect(parseGraph3DInequality("x < 2")).toEqual({ left: "x", operator: "<", right: "2" });
  });

  it("分解できない書きかけは null を返して原文編集に委ねる", () => {
    expect(parseGraph3DInequality("x + y")).toBeNull();
    expect(parseGraph3DInequality("<= 3")).toBeNull();
    expect(parseGraph3DInequality("x <=")).toBeNull();
    // 等号は不等式ではない。`<=` の一部でない `=` は分解対象にしない。
    expect(parseGraph3DInequality("x = 3")).toBeNull();
  });

  it("往復しても書式が壊れない", () => {
    const parts = parseGraph3DInequality("x+y+z<=3");
    expect(parts).not.toBeNull();
    if (!parts) return;
    const formatted = formatGraph3DInequality(parts);
    expect(formatted).toBe("x+y+z <= 3");
    expect(parseGraph3DInequality(formatted)).toEqual(parts);
  });

  it("1つの数式欄に書いた不等式をそのまま読み取る", () => {
    // MathLive が返す不等号は書き方が何通りもある。どれで書いても同じ式に落ちる。
    for (const tex of ["x+y+z \\leqq 3", "x+y+z\\le 3", "x+y+z \\leq 3"]) {
      expect(parseGraph3DExpressionTex(tex, "inequality")).toEqual({ expression: "x+y+z <= 3" });
    }
    expect(parseGraph3DExpressionTex("z \\geqq 0", "inequality")).toEqual({ expression: "z >= 0" });
    expect(parseGraph3DExpressionTex("x<2", "inequality")).toEqual({ expression: "x < 2" });
  });

  it("カンマで並んだ不等式を、別々の壁として読む", () => {
    expect(parseGraph3DExpressionTex("z \\geqq 0, x^2 \\leqq y, x^2+y^2 \\leqq 4", "inequality")).toEqual({
      expression: "z >= 0, x^2 <= y, x^2+y^2 <= 4",
    });
  });

  it("不等号が2つ以上ある式は下書きのまま理由を返す", () => {
    expect(parseGraph3DExpressionTex("0 \\leqq x \\leqq 1", "inequality")).toEqual(expect.objectContaining({
      error: expect.any(String),
    }));
  });

  it("保存された不等式を表示用 TeX へ戻す", () => {
    expect(graph3DExpressionToTex("x+y+z <= 3", "inequality")).toContain("\\leqq");
    expect(graph3DExpressionToTex("z >= 0", "inequality")).toContain("\\geqq");
    // 読めない書きかけは書いたまま見せる。
    expect(graph3DExpressionToTex("x +", "inequality")).toBe("x +");
  });
});

describe("共通部分", () => {
  it("選んだ立体を塗る領域として作る", () => {
    const region = createGraph3DIntersectionRegion(["a", "b"]);
    expect(region).toEqual(expect.objectContaining({
      kind: "objectIntersection",
      objectIds: ["a", "b"],
      showEdges: true,
    }));
    expect(region.fill.mode).toBe("solid");
  });
});

function box(id: string, center: string): Graph3DSpec["objects"][number] {
  return {
    id,
    kind: "primitive",
    primitive: "box",
    center: { x: center, y: center, z: center },
    size: { x: "2", y: "2", z: "2" },
  };
}

const sharedSpec: Graph3DSpec = {
  version: 1,
  parameters: [{ id: "s", name: "s", value: 1, min: 0, max: 2 }],
  objects: [box("a", "0"), box("b", "1"), box("unrelated", "9")],
  cuts: [],
  regions: [{
    id: "shared",
    kind: "objectIntersection",
    objectIds: ["a", "b"],
    fill: { mode: "solid", color: "#d97706" },
    visible: false,
  }],
  annotations: [{
    id: "label",
    kind: "label",
    position: { x: "0", y: "0", z: "0" },
    labelTex: "P",
  }],
  camera: {
    projection: "perspective",
    position: { x: 4, y: -4, z: 3 },
    target: { x: 0, y: 0, z: 0 },
    up: { x: 0, y: 0, z: 1 },
  },
  view: { coordinateSystem: "zUp", showAxes: true, showGrid: true, backgroundColor: "#fff" },
};

describe("共通部分だけを取り出した3D教材", () => {
  it("元になった図形だけを、隠したまま連れていく", () => {
    const extracted = createGraph3DIntersectionOnlySpec(sharedSpec, "shared");
    expect(extracted?.objects.map((object) => object.id)).toEqual(["a", "b"]);
    expect(extracted?.objects.every((object) => object.visible === false)).toBe(true);
    // 共通部分は、元が非表示でも取り出した教材では見える。
    expect(extracted?.regions).toHaveLength(1);
    expect(extracted?.regions[0].kind === "objectIntersection" && extracted.regions[0].visible).toBe(true);
    expect(extracted?.annotations).toEqual([]);
    // 式はそのまま。パラメータを持っていかないと、取り出した先で共通部分が計算できない。
    expect(extracted?.parameters).toEqual(sharedSpec.parameters);
    expect(extracted?.camera).toEqual(sharedSpec.camera);
  });

  it("知らない共通部分や、図形が足りない共通部分は取り出さない", () => {
    expect(createGraph3DIntersectionOnlySpec(sharedSpec, "missing")).toBeNull();
    expect(createGraph3DIntersectionOnlySpec({
      ...sharedSpec,
      regions: [{ ...sharedSpec.regions[0], objectIds: ["a"] } as Graph3DSpec["regions"][number]],
    }, "shared")).toBeNull();
  });
});
