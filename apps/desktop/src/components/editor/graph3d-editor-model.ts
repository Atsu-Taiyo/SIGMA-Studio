import type {
  Graph3DExpressionVector3,
  Graph3DFillStyle,
  Graph3DObject,
  Graph3DObjectIntersectionRegion,
  Graph3DPlaneDefinition,
  Graph3DSpec,
} from "@/features/document";
import {
  formatGraphInequalityTex,
  graphExpressionToTex,
  parseGraphInequalityTex,
  texToGraphExpressionWithError,
} from "@/lib/graph-tex";
import { createId } from "@/lib/id";
import { createCurrentLocaleTranslator, type Translate } from "@/lib/i18n";

const DEFAULT_TRANSLATE = createCurrentLocaleTranslator("shape");

/** What a settings field accepts: a bare expression, an equation, or a single inequality. */
export type Graph3DExpressionMode = "expression" | "equation" | "inequality";

export function parseGraph3DExpressionTex(
  tex: string,
  mode: Graph3DExpressionMode,
  t: Translate<"shape"> = DEFAULT_TRANSLATE,
): { expression: string } | { error: string } {
  const trimmed = tex.trim();
  if (!trimmed) return { error: t("graph3dEditor.error.expressionRequired") };

  if (mode === "equation") {
    const parts = trimmed.split("=");
    if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) {
      return { error: t("graph3dEditor.error.equationRequired") };
    }
    const left = texToGraphExpressionWithError(parts[0].trim());
    const right = texToGraphExpressionWithError(parts[1].trim());
    if ("error" in left || "error" in right) {
      return { error: t("graph3dEditor.error.equationUnreadable") };
    }
    return { expression: `${left.expression}=${right.expression}` };
  }

  if (mode === "inequality") {
    const list = parseGraph3DInequalityListTex(trimmed, t);
    if ("error" in list) return list;
    return { expression: list.expressions.join(", ") };
  }

  const result = texToGraphExpressionWithError(trimmed);
  // graph-tex はコードを返す (texError 辞書が唯一の文言の出典)。この関数の error は
  // 表示にそのまま出る契約なので、コードはここで文言に解決してから返す。
  if ("error" in result) return { error: t(`texError.${result.error}`) };
  return result;
}

export function graph3DExpressionToTex(expression: string, mode: Graph3DExpressionMode): string {
  if (mode === "equation") {
    const parts = expression.split("=");
    if (parts.length !== 2) return expression;
    return `${graphExpressionToTex(parts[0].trim())}=${graphExpressionToTex(parts[1].trim())}`;
  }
  if (mode === "inequality") {
    // 1つの欄が `z >= 0, x^2 <= y` のように複数の条件を持てる。最初の不等号だけで割ると、
    // 2つ目以降が評価式のまま TeX として描かれていた (`0, x^2 <= y` がそのまま数式になる)。
    return splitTopLevelList(expression)
      .map((clause) => {
        const parts = parseGraph3DInequality(clause);
        return parts ? formatGraphInequalityTex(parts.left, parts.operator, parts.right) : clause;
      })
      .join(",\\ ");
  }
  return graphExpressionToTex(expression);
}

/**
 * What the "add" tile offers, grouped the way a figure is thought about rather than the way the
 * model is typed.
 *
 * Each entry is drawn in the picker from the object it actually creates, so the card shows the
 * shape the click will produce. `z = f(x, y)` and the triangular extrusion are deliberately absent:
 * a height field is the parametric surface with `x = u, y = v`, and a prism is the polyhedron or
 * the inequality solid, so both only added a second name for a shape already there.
 */
export interface Graph3DObjectChoiceGroup {
  title: string;
  choices: Array<{ value: string; label: string }>;
}

export function buildGraph3DObjectChoiceGroups(t: Translate<"shape"> = DEFAULT_TRANSLATE): Graph3DObjectChoiceGroup[] {
  return [
  {
    title: t("graph3dEditor.group.solid"),
    choices: [
      { value: "box", label: t("graph3dEditor.name.box") },
      { value: "sphere", label: t("graph3dEditor.name.sphere") },
      { value: "cylinder", label: t("graph3dEditor.name.cylinder") },
      { value: "cone", label: t("graph3dEditor.name.cone") },
      { value: "revolution", label: t("graph3dEditor.name.revolution") },
      { value: "tetrahedron", label: t("graph3dEditor.name.boundedSolid") },
      { value: "polyhedron", label: t("graph3dEditor.name.polyhedronChoice") },
    ],
  },
  {
    title: t("graph3dEditor.group.surfaceCurve"),
    choices: [
      { value: "parametricSurface", label: t("graph3dEditor.name.parametricSurface") },
      { value: "implicit", label: t("graph3dEditor.name.implicitSurfaceChoice") },
      { value: "parametricCurve", label: t("graph3dEditor.name.spaceCurve") },
    ],
  },
  {
    title: t("graph3dEditor.group.pointLinePlane"),
    choices: [
      { value: "plane", label: t("graph3dEditor.name.plane") },
      { value: "segment", label: t("graph3dEditor.name.segment") },
      { value: "point", label: t("graph3dEditor.name.point") },
    ],
  },
  ];
}


export function createGraph3DObjectFromChoice(choice: string, t: Translate<"shape"> = DEFAULT_TRANSLATE): Graph3DObject | null {
  const id = createId("graph3d_object");
  switch (choice) {
    case "parametricSurface":
      return {
        id,
        name: t("graph3dEditor.name.parametricSurface"),
        kind: "parametricSurface",
        x: "(2 + cos(v))*cos(u)",
        y: "(2 + cos(v))*sin(u)",
        z: "sin(v)",
        u: { min: "0", max: "2*pi", samples: 48 },
        v: { min: "0", max: "2*pi", samples: 24 },
        style: defaultStyle(0.55),
      };
    case "parametricCurve":
      return {
        id,
        name: t("graph3dEditor.name.spaceCurve"),
        kind: "parametricCurve",
        x: "cos(t)",
        y: "sin(t)",
        z: "t/3",
        parameter: "t",
        range: { min: "-3*pi", max: "3*pi", samples: 160 },
        style: { color: "#2563eb", opacity: 1 },
      };
    case "revolution":
      return {
        id,
        name: t("graph3dEditor.name.revolution"),
        kind: "solidOfRevolution",
        axis: "z",
        radius: "sqrt(2*z^2 + 1)",
        axisRange: { min: "-3", max: "3", samples: 28 },
        angleRange: { min: "0", max: "2*pi", samples: 48 },
        capped: true,
        style: defaultStyle(0.35),
      };
    case "box":
    case "sphere":
    case "cylinder":
    case "cone":
      return {
        id,
        name: ({ box: t("graph3dEditor.name.box"), sphere: t("graph3dEditor.name.sphere"), cylinder: t("graph3dEditor.name.cylinder"), cone: t("graph3dEditor.name.cone") })[choice],
        kind: "primitive",
        primitive: choice,
        center: graph3DVector("0", "0", "0"),
        size: graph3DVector("2", "2", "2"),
        style: defaultStyle(0.45),
      };
    case "polyhedron":
      // 四角錐。四面体にすると「不等式で囲む立体」の既定と同じ形になり、カードが2枚とも
      // 同じ絵になる。底面のある立体のほうが「頂点と面で作る」入口としても分かりやすい。
      return {
        id,
        name: t("graph3dEditor.name.squarePyramid"),
        kind: "polyhedron",
        vertices: [
          graph3DVector("-1", "-1", "0"),
          graph3DVector("1", "-1", "0"),
          graph3DVector("1", "1", "0"),
          graph3DVector("-1", "1", "0"),
          graph3DVector("0", "0", "2"),
        ],
        faces: [[0, 3, 2, 1], [0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4]],
        style: defaultStyle(0.45),
      };
    case "tetrahedron":
      return {
        id,
        name: t("graph3dEditor.name.boundedSolid"),
        kind: "boundedSolid",
        inequalities: ["x >= 0", "y >= 0", "z >= 0", "x+y+z <= 3"],
        bounds: {
          x: { min: "-1", max: "4" },
          y: { min: "-1", max: "4" },
          z: { min: "-1", max: "4" },
        },
        style: defaultStyle(0.4),
      };
    case "implicit":
      // タングルキューブ (4次曲面)。既定が球だったときは、「球」のカードと同じ絵が2枚並ぶうえ、
      // `x^2+y^2+z^2=1` は名前が約束する F(x,y,z)=0 の形ですらなかった。他のどのカードでも
      // 作れない形を既定にすると、このカードが何のためにあるのかが一目で分かる。
      // 定数 11.8 はこの曲面の定義そのもので、丸めると8つの塊がつながらなくなる。
      return {
        id,
        name: t("graph3dEditor.name.tanglecube"),
        kind: "implicitSurface",
        expression: "x^4 - 5*x^2 + y^4 - 5*y^2 + z^4 - 5*z^2 + 11.8 = 0",
        bounds: {
          x: { min: "-3.2", max: "3.2" },
          y: { min: "-3.2", max: "3.2" },
          z: { min: "-3.2", max: "3.2" },
        },
        resolution: 44,
        style: { color: "#64748b", opacity: 0.55, wireframe: false },
      };
    case "point":
      return { id, name: t("graph3dEditor.name.point"), kind: "point", position: graph3DVector("0", "0", "0") };
    case "segment":
      return {
        id,
        name: t("graph3dEditor.name.segment"),
        kind: "segment",
        from: graph3DVector("0", "0", "0"),
        to: graph3DVector("1", "1", "1"),
      };
    case "plane":
      return {
        id,
        name: t("graph3dEditor.name.plane"),
        kind: "plane",
        plane: createGraph3DPlaneDefinition("equation"),
        size: graph3DVector("6", "6", "0"),
        style: { color: "#94a3b8", opacity: 0.2 },
      };
    default:
      return null;
  }
}

export const GRAPH3D_INEQUALITY_OPERATORS = ["<=", ">=", "<", ">"] as const;
export type Graph3DInequalityOperator = typeof GRAPH3D_INEQUALITY_OPERATORS[number];

export interface Graph3DInequalityParts {
  left: string;
  operator: Graph3DInequalityOperator;
  right: string;
}

/**
 * Split a stored inequality into left side, sign and right side.
 * Returns null for anything it cannot split, so a half-written draft is shown as typed
 * instead of being silently rewritten.
 */
export function parseGraph3DInequality(expression: string): Graph3DInequalityParts | null {
  const match = /^([^<>=]*)(<=|>=|<|>)(.*)$/u.exec(expression);
  if (!match) return null;
  const left = match[1].trim();
  const right = match[3].trim();
  if (!left || !right) return null;
  return { left, operator: match[2] as Graph3DInequalityOperator, right };
}

export function formatGraph3DInequality(parts: Graph3DInequalityParts): string {
  return `${parts.left} ${parts.operator} ${parts.right}`;
}

/**
 * One field may hold several inequalities, the way a textbook writes
 * `z ≧ 0, x^2 ≦ y, x^2+y^2 ≦ 4`. Commas and Japanese commas split them.
 */
export function parseGraph3DInequalityListTex(
  tex: string,
  t: Translate<"shape"> = DEFAULT_TRANSLATE,
): { expressions: string[] } | { error: string } {
  const chunks = splitInequalityListTex(tex);
  if (chunks.length === 0) return { error: t("graph3dEditor.error.expressionRequired") };
  const expressions: string[] = [];
  for (const chunk of chunks) {
    const parts = parseGraphInequalityTex(chunk);
    if (!parts) {
      return { error: t("graph3dEditor.error.inequalityRequired") };
    }
    expressions.push(formatGraph3DInequality(parts));
  }
  return { expressions };
}

/** 丸括弧の外にあるカンマだけで区切る。`max(x, y) <= 3` を割らないため。 */
function splitTopLevelList(expression: string): string[] {
  const parts = splitInequalityListTex(expression);
  return parts.length > 0 ? parts : [expression.trim()].filter(Boolean);
}

function splitInequalityListTex(tex: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < tex.length; index += 1) {
    const character = tex[index];
    if (character === "{" || character === "(" || character === "[") depth += 1;
    else if (character === "}" || character === ")" || character === "]") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (character === "," || character === ";" || character === "、")) {
      const part = tex.slice(start, index).trim();
      if (part) parts.push(part);
      start = index + 1;
    }
  }
  const last = tex.slice(start).trim();
  if (last) parts.push(last);
  return parts;
}

/**
 * A 3D material holding nothing but one common part.
 *
 * The members stay in the spec but stop being drawn: a common part is defined by the objects it is
 * taken over, so baking it into a fixed mesh would freeze it — the extracted material would stop
 * following its own parameters, and could never be taken apart again. Hiding the members leaves
 * the reader with only the shared shape while the maths behind it stays live.
 */
export function createGraph3DIntersectionOnlySpec(
  spec: Graph3DSpec,
  regionId: string,
): Graph3DSpec | null {
  const region = spec.regions.find((candidate) => candidate.id === regionId);
  if (!region || region.kind !== "objectIntersection") return null;
  const members = spec.objects.filter((object) => region.objectIds.includes(object.id));
  if (members.length < 2) return null;
  return {
    ...spec,
    objects: members.map((object) => ({ ...object, visible: false })),
    cuts: [],
    regions: [{ ...region, visible: true }],
    annotations: [],
  };
}

/** A new common part over the given objects, drawn in a colour that reads on white paper. */
export function createGraph3DIntersectionRegion(
  objectIds: string[],
  t: Translate<"shape"> = DEFAULT_TRANSLATE,
): Graph3DObjectIntersectionRegion {
  return {
    id: createId("graph3d_region"),
    kind: "objectIntersection",
    label: t("graph3dEditor.name.intersection"),
    objectIds,
    fill: { mode: "solid", color: "#d97706", opacity: 0.55 },
    showEdges: true,
  };
}

export function createGraph3DPlaneDefinition(kind: string): Graph3DPlaneDefinition {
  if (kind === "threePoints") {
    return {
      kind: "threePoints",
      points: [
        graph3DVector("0", "0", "0"),
        graph3DVector("1", "0", "0"),
        graph3DVector("0", "1", "0"),
      ],
    };
  }
  if (kind === "pointNormal") {
    return {
      kind: "pointNormal",
      point: graph3DVector("0", "0", "0"),
      normal: graph3DVector("0", "0", "1"),
    };
  }
  return { kind: "equation", expression: "z = 0" };
}

export function createGraph3DSectionFill(
  mode: "none" | "solid" | "pattern",
  color: string,
  pattern: "diagonal" | "cross" | "dots" = "diagonal",
): Graph3DFillStyle {
  if (mode === "none") return { mode: "none" };
  if (mode === "solid") return { mode: "solid", color, opacity: 0.3 };
  return { mode: "pattern", color, opacity: 0.3, pattern };
}

export function graph3DVector(x: string, y: string, z: string): Graph3DExpressionVector3 {
  return { x, y, z };
}

function defaultStyle(opacity: number) {
  return { color: "#64748b", opacity, wireframe: true } as const;
}
