import type {
  BoxBlockChildBlock,
  BoxBlockNode,
  BoxDecorationSpec,
  BoxFrameSpec,
  Graph2DSpec,
  InlineNode,
  LayoutSectionChildBlock,
  PageOverlay,
  ProblemAreaBlock,
  RichBlock,
  SigmaBlock,
  SigmaDocument,
} from "./types.js";
import type {
  OverlayShape,
  OverlayTextBlock,
  OverlaySnapshot,
  SigmaChartSpec,
  SigmaTableCellContent,
  SigmaTableCellStyle,
  SigmaTableGridLineStyle,
  SigmaTableSpec,
} from "./overlay-types.js";
import type {
  Graph3DBounds,
  Graph3DExpressionRange,
  Graph3DExpressionVector3,
  Graph3DFillStyle,
  Graph3DObjectStyle,
  Graph3DPlaneDefinition,
  Graph3DSpec,
} from "./graph3d-types.js";

const MAX_GRAPH3D_EXPRESSION_LENGTH = 4_096;
const MAX_GRAPH3D_COLLECTION_LENGTH = 4_096;

/**
 * The CSS scalar rules live in Sigma Studio's canonical normalization boundary
 * (`features/document/css-safety.ts`) and are aliased in at build time, exactly like the print
 * surface and the schema. A hand-copied second implementation is how the viewer's stylesheet
 * mirror silently rotted before, and this package must not disagree with the boundary that decides
 * what a document may store. The module id keeps desktop source paths out of the published `.d.ts`
 * (`package-boundary.test.ts`) and pins the alias to that one leaf file rather than the feature
 * barrel, so the whole document feature does not enter the browser bundle.
 */
import {
  isSafeCssColor,
  isSafeCssFontFamily,
  isSafeCssScalar,
} from "@sigma-studio/viewer-internal/css-safety";

const MAX_SAFETY_ISSUES = 100;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const XML_UNSAFE_CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
/** Any control character. A data URL that carries one is malformed regardless of its media type. */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;
const SAFE_BOX_LINE_HEIGHT = /^(?:\d+(?:\.\d+)?|\.\d+)(?:px)?$/u;
const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export class ViewerSafetyValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super("Viewerで安全に描画できないスタイル値があります。");
    this.name = "ViewerSafetyValidationError";
    this.issues = issues;
  }
}

export interface ValidatedImageDataUrl {
  src: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/svg+xml";
}

export type ImageDataUrlValidation =
  | { ok: true; value: ValidatedImageDataUrl }
  | { ok: false; reason: string };

export function assertViewerSafeDocument(document: SigmaDocument): void {
  const issues = getViewerSafetyIssues(document);
  if (issues.length > 0) {
    throw new ViewerSafetyValidationError(issues);
  }
}

export function getViewerSafetyIssues(document: SigmaDocument): string[] {
  const issues: string[] = [];
  const report = (path: string, message: string) => {
    if (issues.length < MAX_SAFETY_ISSUES) {
      issues.push(`${path}: ${message}`);
    }
  };

  document.content.forEach((block, index) => visitSigmaBlock(block, `content.${index}`, report));
  visitRunningBlocks(document.pageLayout?.header?.blocks, "pageLayout.header.blocks", report);
  visitRunningBlocks(document.pageLayout?.footer?.blocks, "pageLayout.footer.blocks", report);
  visitPageOverlay(document.pageLayout?.overlay, "pageLayout.overlay", report);
  visitPageOverlay(document.pageLayout?.header?.overlay, "pageLayout.header.overlay", report);
  visitPageOverlay(document.pageLayout?.footer?.overlay, "pageLayout.footer.overlay", report);

  return issues;
}

export function validateImageDataUrl(source: string): ImageDataUrlValidation {
  const src = source.trim();
  if (!src) {
    return { ok: false, reason: "画像sourceが空です。" };
  }
  if (CONTROL_CHARACTER.test(src)) {
    return { ok: false, reason: "画像data URLに制御文字があります。" };
  }

  const commaIndex = src.indexOf(",");
  if (commaIndex < 0) {
    return { ok: false, reason: "画像sourceはdata URLではありません。" };
  }
  const header = src.slice(0, commaIndex).toLowerCase();
  const payload = src.slice(commaIndex + 1);

  if (header === "data:image/png;base64") {
    return validateRasterPayload(src, payload, "image/png", isPngPayload);
  }
  if (header === "data:image/jpeg;base64") {
    return validateRasterPayload(src, payload, "image/jpeg", isJpegPayload);
  }
  if (header === "data:image/webp;base64") {
    return validateRasterPayload(src, payload, "image/webp", isWebpPayload);
  }

  const svgBase64 = header === "data:image/svg+xml;base64" ||
    header === "data:image/svg+xml;charset=utf-8;base64" ||
    header === "data:image/svg+xml;charset=us-ascii;base64";
  const svgText = header === "data:image/svg+xml" ||
    header === "data:image/svg+xml;charset=utf-8" ||
    header === "data:image/svg+xml;charset=us-ascii";
  if (!svgBase64 && !svgText) {
    return { ok: false, reason: "画像はPNG・JPEG・WebP・SVGのdata URLのみ表示できます。" };
  }

  let svg: string;
  try {
    if (svgBase64) {
      const bytes = decodeStrictBase64(payload);
      if (!bytes) {
        return { ok: false, reason: "SVG画像のbase64 payloadが不正です。" };
      }
      svg = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } else {
      svg = decodeURIComponent(payload);
    }
  } catch {
    return { ok: false, reason: "SVG画像のpayloadをUTF-8として読み取れません。" };
  }

  const svgIssue = getSvgPayloadIssue(svg);
  if (svgIssue) {
    return { ok: false, reason: svgIssue };
  }
  return { ok: true, value: { src, mimeType: "image/svg+xml" } };
}

function visitRunningBlocks(
  blocks: RichBlock[] | undefined,
  path: string,
  report: SafetyReporter,
) {
  blocks?.forEach((block, index) => {
    validateBlockSpaceAfterPx(block.spaceAfterPx, `${path}.${index}.spaceAfterPx`, report);
    visitRichBlock(block, `${path}.${index}`, report);
  });
}

/**
 * ブロック 1 つにつき下余白の検査は **1 回だけ**。この関数群は「入れ物 → 中身」へ委譲して
 * 回るので、委譲先 (`visitRichBlock` など) にも同じ検査を置くと同じ path が二重に報告される。
 * 検査は「そのノードを最初に受け取る場所」= 各ディスパッチャの入口と、委譲を経ない
 * 走査 (ヘッダー/フッター・入れ子リスト・箱の中の段組) の呼び出し側にだけ置く。
 */
function visitSigmaBlock(block: SigmaBlock, path: string, report: SafetyReporter) {
  validateBlockSpaceAfterPx(block.spaceAfterPx, `${path}.spaceAfterPx`, report);
  if (block.type === "section") {
    validateLineHeight(block.lineHeight, `${path}.lineHeight`, report);
    return;
  }
  if (block.type === "heading" || block.type === "paragraph" || block.type === "list") {
    visitRichBlock(block, path, report);
    return;
  }
  if (block.type === "problem") {
    (["lead", "prompt", "hints", "solution"] as const).forEach((area) => {
      block[area].forEach((child, index) => visitProblemAreaBlock(child, `${path}.${area}.${index}`, report));
    });
    return;
  }
  if (block.type === "layoutSection") {
    block.children.forEach((child, index) => visitLayoutChild(child, `${path}.children.${index}`, report));
    return;
  }
  // 区切り線は検査する値を持たない (id だけ)。
  if (block.type === "divider") {
    return;
  }
  if (block.type === "quote") {
    block.blocks.forEach((child, index) => visitLayoutChild(child, `${path}.blocks.${index}`, report));
    return;
  }
  if (block.type === "codeBlock") {
    return;
  }
  visitBoxBlock(block, path, report);
}

/**
 * A shape's own blocks: prose, quotes, code and rules.
 *
 * A code block's runs are walked rather than skipped. The body's walkers stop at one because its
 * source is plain, but the type carries `InlineNode`, and this validator exists precisely so that
 * no styling reaches the renderer unchecked — a colour smuggled into a shape's code block would
 * otherwise be the one unvalidated route on the surface this change opens.
 *
 * `ancestors` is threaded for the same reason `visitRichBlock` threads it: a quote holding blocks
 * is a second place the walk descends into itself, and this validator also runs on in-memory
 * documents, where a block really can be its own ancestor. Without the guard that overflows the
 * stack inside the thing that is supposed to be gating the renderer.
 */
function visitOverlayTextBlock(
  block: OverlayTextBlock,
  path: string,
  report: SafetyReporter,
  ancestors: Set<object> = new Set(),
) {
  validateBlockSpaceAfterPx(block.spaceAfterPx, `${path}.spaceAfterPx`, report);
  if (block.type === "divider") {
    return;
  }
  if (block.type === "quote") {
    if (ancestors.has(block)) {
      report(path, "ブロックに循環参照があります。");
      return;
    }
    const nested = new Set(ancestors).add(block);
    block.blocks.forEach((child, index) => (
      visitOverlayTextBlock(child as OverlayTextBlock, `${path}.blocks.${index}`, report, nested)
    ));
    return;
  }
  if (block.type === "codeBlock") {
    block.children.forEach((node, index) => visitInlineNode(node, `${path}.children.${index}`, report));
    return;
  }
  visitRichBlock(block, path, report, ancestors);
}

function visitProblemAreaBlock(block: ProblemAreaBlock, path: string, report: SafetyReporter) {
  validateBlockSpaceAfterPx(block.spaceAfterPx, `${path}.spaceAfterPx`, report);
  if (block.type === "layoutSection") {
    block.children.forEach((child, index) => visitLayoutChild(child, `${path}.children.${index}`, report));
    return;
  }
  if (block.type === "boxBlock") {
    visitBoxBlock(block, path, report);
    return;
  }
  if (block.type === "divider" || block.type === "codeBlock") {
    return;
  }
  if (block.type === "quote") {
    block.blocks.forEach((child, index) => visitLayoutChild(child, `${path}.blocks.${index}`, report));
    return;
  }
  visitRichBlock(block, path, report);
}

function visitLayoutChild(block: LayoutSectionChildBlock, path: string, report: SafetyReporter) {
  validateBlockSpaceAfterPx(block.spaceAfterPx, `${path}.spaceAfterPx`, report);
  if (block.type === "section") {
    validateLineHeight(block.lineHeight, `${path}.lineHeight`, report);
  } else if (block.type === "boxBlock") {
    visitBoxBlock(block, path, report);
  } else if (block.type === "quote") {
    block.blocks.forEach((child, index) => visitLayoutChild(child, `${path}.blocks.${index}`, report));
  } else if (block.type !== "divider" && block.type !== "codeBlock") {
    visitRichBlock(block, path, report);
  }
}

function visitBoxChild(block: BoxBlockChildBlock, path: string, report: SafetyReporter) {
  if (block.type === "problem") {
    visitSigmaBlock(block, path, report);
  } else if (block.type === "layoutSection") {
    validateBlockSpaceAfterPx(block.spaceAfterPx, `${path}.spaceAfterPx`, report);
    block.children.forEach((child, index) => visitLayoutChild(child, `${path}.children.${index}`, report));
  } else {
    visitLayoutChild(block, path, report);
  }
}

function visitBoxBlock(block: BoxBlockNode, path: string, report: SafetyReporter) {
  block.title?.forEach((node, index) => visitInlineNode(node, `${path}.title.${index}`, report));
  block.blocks.forEach((child, index) => visitBoxChild(child, `${path}.blocks.${index}`, report));
  validateBoxFrame(block.frame, `${path}.frame`, report);
}

/**
 * `ancestors` is the set of blocks currently on the walk. A document parsed from JSON cannot hold
 * a cycle, but this validator also runs on in-memory documents, and the list branch is the one
 * place the walk descends into itself — without the guard a block that is its own ancestor would
 * recurse until the stack gives out instead of being reported.
 */
function visitRichBlock(
  block: RichBlock,
  path: string,
  report: SafetyReporter,
  ancestors: Set<object> = new Set(),
) {
  if (ancestors.has(block)) {
    report(path, "ブロックに循環参照があります。");
    return;
  }
  if (block.type === "heading" || block.type === "paragraph") {
    validateLineHeight(block.lineHeight, `${path}.lineHeight`, report);
    validateTextAlign(block.align, `${path}.align`, report);
    block.children.forEach((node, index) => visitInlineNode(node, `${path}.children.${index}`, report));
    return;
  }
  ancestors.add(block);
  block.items.forEach((item, itemIndex) => {
    const itemPath = `${path}.items.${itemIndex}`;
    validateTextAlign(item.align, `${itemPath}.align`, report);
    item.children.forEach((node, index) => visitInlineNode(node, `${itemPath}.children.${index}`, report));
    // A list item can carry further blocks under the same marker. They were never walked, so a
    // colour or font-family placed there reached the renderer unchecked — the one branch of the
    // block tree this validator did not descend into.
    item.continuations?.forEach((continuation, index) => {
      const continuationPath = `${itemPath}.continuations.${index}`;
      validateBlockSpaceAfterPx(continuation.spaceAfterPx, `${continuationPath}.spaceAfterPx`, report);
      if (continuation.type === "divider") {
        return;
      }
      visitRichBlock(continuation, continuationPath, report, ancestors);
    });
    item.nested?.forEach((nested, index) => {
      const nestedPath = `${itemPath}.nested.${index}`;
      validateBlockSpaceAfterPx(nested.spaceAfterPx, `${nestedPath}.spaceAfterPx`, report);
      visitRichBlock(nested, nestedPath, report, ancestors);
    });
  });
  ancestors.delete(block);
}

/**
 * Every inline check in one place. `fontSize` and `boxedPaddingY` used to be checked only on the
 * overlay path (text shapes had their own walker) even though the body renders the same node
 * through the same CSS custom properties — the split, not the values, was the accident.
 */
function visitInlineNode(node: InlineNode, path: string, report: SafetyReporter) {
  validateColor(node.color, `${path}.color`, report);
  validateColor(node.backgroundColor, `${path}.backgroundColor`, report);
  validateFontFamily(node.fontFamily, `${path}.fontFamily`, report);
  if (node.fontSize !== undefined && !isSafePositiveCssNumber(node.fontSize, 512)) {
    report(`${path}.fontSize`, "font-sizeが不正です。");
  }
  if (
    node.boxedPaddingY !== undefined
    && !isSafePositiveCssNumber(node.boxedPaddingY, 100, true)
  ) {
    report(`${path}.boxedPaddingY`, "paddingが不正です。");
  }
}

function validateTextAlign(value: unknown, path: string, report: SafetyReporter) {
  if (value === undefined) return;
  if (typeof value !== "string" || !["left", "center", "right", "justify"].includes(value)) {
    report(path, "許可されていないtext-alignです。");
  }
}

function validateBoxFrame(frame: BoxFrameSpec | undefined, path: string, report: SafetyReporter) {
  if (!frame) return;
  for (const key of ["borderColor", "backgroundColor", "titleBackgroundColor", "titleColor", "bodyColor"] as const) {
    validateColor(frame[key], `${path}.${key}`, report);
  }
  validateFontFamily(frame.titleFontFamily, `${path}.titleFontFamily`, report);
  validateFontFamily(frame.bodyFontFamily, `${path}.bodyFontFamily`, report);
  validateBoxLineHeight(frame.titleLineHeight, `${path}.titleLineHeight`, report);
  validateBoxLineHeight(frame.bodyLineHeight, `${path}.bodyLineHeight`, report);
  if (frame.titlePosition !== undefined && !["l", "c", "r"].includes(frame.titlePosition)) {
    report(`${path}.titlePosition`, "タイトル位置はl・c・rのいずれかで指定してください。");
  }
  frame.decorations?.forEach((decoration, index) => validateBoxDecoration(decoration, `${path}.decorations.${index}`, report));
}

function validateBoxDecoration(decoration: BoxDecorationSpec, path: string, report: SafetyReporter) {
  if ("color" in decoration) validateColor(decoration.color, `${path}.color`, report);
  if ("borderColor" in decoration) validateColor(decoration.borderColor, `${path}.borderColor`, report);
  if ("backgroundColor" in decoration) validateColor(decoration.backgroundColor, `${path}.backgroundColor`, report);
  if ("ruleColor" in decoration) validateColor(decoration.ruleColor, `${path}.ruleColor`, report);
  if ("guideColor" in decoration) validateColor(decoration.guideColor, `${path}.guideColor`, report);
  if ("lineColor" in decoration) validateColor(decoration.lineColor, `${path}.lineColor`, report);
  if ("bindingColor" in decoration) validateColor(decoration.bindingColor, `${path}.bindingColor`, report);
  if ("ringColor" in decoration) validateColor(decoration.ringColor, `${path}.ringColor`, report);
}

function visitPageOverlay(overlay: PageOverlay | undefined, path: string, report: SafetyReporter) {
  if (!overlay?.overlaySnapshot) return;
  visitOverlaySnapshot(overlay.overlaySnapshot, `${path}.overlaySnapshot`, report);
}

function visitOverlaySnapshot(snapshot: OverlaySnapshot, path: string, report: SafetyReporter) {
  snapshot.shapes.forEach((shape, index) => visitOverlayShape(shape, `${path}.shapes.${index}`, report));
}

function visitOverlayShape(shape: OverlayShape, path: string, report: SafetyReporter) {
  switch (shape.type) {
    case "geo":
      validateColor(shape.props.color, `${path}.props.color`, report);
      validateColor(shape.props.fillColor, `${path}.props.fillColor`, report);
      validateColor(shape.props.labelColor, `${path}.props.labelColor`, report);
      break;
    case "arc":
      validateColor(shape.props.color, `${path}.props.color`, report);
      validateColor(shape.props.fillColor, `${path}.props.fillColor`, report);
      break;
    case "arrow":
      validateColor(shape.props.color, `${path}.props.color`, report);
      validateColor(shape.props.labelColor, `${path}.props.labelColor`, report);
      break;
    case "line":
      validateColor(shape.props.color, `${path}.props.color`, report);
      validateColor(shape.props.fillColor, `${path}.props.fillColor`, report);
      validateColor(shape.props.labelColor, `${path}.props.labelColor`, report);
      break;
    case "text":
    case "callout":
      validateColor(shape.props.color, `${path}.props.color`, report);
      shape.props.blocks.forEach((block, index) => {
        visitOverlayTextBlock(block, `${path}.props.blocks.${index}`, report);
      });
      break;
    case "graph2dShape":
      validateGraphSpec(shape.props.spec, `${path}.props.spec`, report);
      break;
    case "graph3dShape":
      validateGraph3DSpec(shape.props.spec, `${path}.props.spec`, report);
      break;
    case "tableShape":
      validateTableSpec(shape.props.table, `${path}.props.table`, report);
      break;
    case "chartShape":
      validateChartSpec(shape.props.spec, `${path}.props.spec`, report);
      break;
    default:
      break;
  }
}

function validateGraph3DSpec(spec: Graph3DSpec, path: string, report: SafetyReporter) {
  validateColor(spec.view.backgroundColor, `${path}.view.backgroundColor`, report);
  if (spec.view.axisColors) {
    validateColor(spec.view.axisColors.x, `${path}.view.axisColors.x`, report);
    validateColor(spec.view.axisColors.y, `${path}.view.axisColors.y`, report);
    validateColor(spec.view.axisColors.z, `${path}.view.axisColors.z`, report);
  }
  validateGraph3DCollection(spec.parameters, `${path}.parameters`, report);
  validateGraph3DCollection(spec.objects, `${path}.objects`, report);
  validateGraph3DCollection(spec.cuts, `${path}.cuts`, report);
  validateGraph3DCollection(spec.regions, `${path}.regions`, report);
  validateGraph3DCollection(spec.annotations, `${path}.annotations`, report);

  spec.objects.forEach((object, index) => {
    const objectPath = `${path}.objects.${index}`;
    validateGraph3DObjectStyle(object.style, `${objectPath}.style`, report);
    if (object.rotation) validateGraph3DExpressionVector(object.rotation, `${objectPath}.rotation`, report);
    if (object.translation) validateGraph3DExpressionVector(object.translation, `${objectPath}.translation`, report);
    if (object.scale) validateGraph3DExpressionVector(object.scale, `${objectPath}.scale`, report);
    switch (object.kind) {
      case "implicitSurface":
        validateGraph3DExpression(object.expression, `${objectPath}.expression`, report);
        validateGraph3DBounds(object.bounds, `${objectPath}.bounds`, report);
        break;
      case "parametricCurve":
        validateGraph3DExpressionVector(object, objectPath, report);
        validateGraph3DRange(object.range, `${objectPath}.range`, report);
        break;
      case "parametricSurface":
        validateGraph3DExpressionVector(object, objectPath, report);
        validateGraph3DRange(object.u, `${objectPath}.u`, report);
        validateGraph3DRange(object.v, `${objectPath}.v`, report);
        break;
      case "primitive":
        validateGraph3DExpressionVector(object.center, `${objectPath}.center`, report);
        validateGraph3DExpressionVector(object.size, `${objectPath}.size`, report);
        break;
      case "solidOfRevolution":
        if (typeof object.axis !== "string") {
          object.axis.equations.forEach((equation, equationIndex) => {
            validateGraph3DExpression(
              equation,
              `${objectPath}.axis.equations.${equationIndex}`,
              report,
            );
          });
        }
        validateGraph3DExpression(object.radius, `${objectPath}.radius`, report);
        validateGraph3DRange(object.axisRange, `${objectPath}.axisRange`, report);
        if (object.angleRange) validateGraph3DRange(object.angleRange, `${objectPath}.angleRange`, report);
        break;
      case "polyhedron":
        validateGraph3DCollection(object.vertices, `${objectPath}.vertices`, report);
        validateGraph3DCollection(object.faces, `${objectPath}.faces`, report);
        object.vertices.forEach((vertex, vertexIndex) => {
          validateGraph3DExpressionVector(vertex, `${objectPath}.vertices.${vertexIndex}`, report);
        });
        object.faces.forEach((face, faceIndex) => {
          validateGraph3DCollection(face, `${objectPath}.faces.${faceIndex}`, report);
        });
        break;
      case "boundedSolid":
        validateGraph3DCollection(object.inequalities, `${objectPath}.inequalities`, report);
        object.inequalities.forEach((expression, expressionIndex) => {
          validateGraph3DExpression(expression, `${objectPath}.inequalities.${expressionIndex}`, report);
        });
        validateGraph3DBounds(object.bounds, `${objectPath}.bounds`, report);
        break;
      case "point":
        validateGraph3DExpressionVector(object.position, `${objectPath}.position`, report);
        break;
      case "segment":
        validateGraph3DExpressionVector(object.from, `${objectPath}.from`, report);
        validateGraph3DExpressionVector(object.to, `${objectPath}.to`, report);
        break;
      case "plane":
        validateGraph3DPlane(object.plane, `${objectPath}.plane`, report);
        if (object.size) validateGraph3DExpressionVector(object.size, `${objectPath}.size`, report);
        break;
    }
  });

  spec.cuts.forEach((cut, index) => {
    const cutPath = `${path}.cuts.${index}`;
    validateGraph3DCollection(cut.targetObjectIds, `${cutPath}.targetObjectIds`, report);
    validateGraph3DPlane(cut.plane, `${cutPath}.plane`, report);
    validateGraph3DFill(cut.section?.fill, `${cutPath}.section.fill`, report);
    validateColor(cut.section?.lineColor, `${cutPath}.section.lineColor`, report);
    if (cut.section?.lineWidth !== undefined && !isSafePositiveCssNumber(cut.section.lineWidth, 32)) {
      report(`${cutPath}.section.lineWidth`, "輪郭の太さは0より大きく32以下の数値にしてください。");
    }
    if (cut.section?.overlapMode !== undefined && cut.section.overlapMode !== "add" && cut.section.overlapMode !== "subtract") {
      report(`${cutPath}.section.overlapMode`, "断面の重なりはaddまたはsubtractにしてください。");
    }
    validateColor(cut.trail?.color, `${cutPath}.trail.color`, report);
  });

  spec.regions.forEach((region, index) => {
    const regionPath = `${path}.regions.${index}`;
    validateGraph3DFill(region.fill, `${regionPath}.fill`, report);
    if (region.kind === "objectIntersection") {
      validateGraph3DCollection(region.objectIds, `${regionPath}.objectIds`, report);
      validateColor(region.edgeColor, `${regionPath}.edgeColor`, report);
    }
    if (region.kind === "inequality") {
      validateGraph3DCollection(region.inequalities, `${regionPath}.inequalities`, report);
      region.inequalities.forEach((expression, expressionIndex) => {
        validateGraph3DExpression(expression, `${regionPath}.inequalities.${expressionIndex}`, report);
      });
      validateGraph3DBounds(region.bounds, `${regionPath}.bounds`, report);
    }
  });

  spec.annotations.forEach((annotation, index) => {
    const annotationPath = `${path}.annotations.${index}`;
    validateColor(annotation.color, `${annotationPath}.color`, report);
    validateGraph3DExpression(annotation.labelTex, `${annotationPath}.labelTex`, report);
    if (annotation.kind === "label") {
      validateGraph3DExpressionVector(annotation.position, `${annotationPath}.position`, report);
    } else {
      validateGraph3DExpressionVector(annotation.from, `${annotationPath}.from`, report);
      validateGraph3DExpressionVector(annotation.to, `${annotationPath}.to`, report);
      if (annotation.lineWidth !== undefined && !isSafePositiveCssNumber(annotation.lineWidth, 32)) {
        report(`${annotationPath}.lineWidth`, "寸法線の太さは0より大きく32以下の数値にしてください。");
      }
    }
  });
}

function validateGraph3DObjectStyle(
  style: Graph3DObjectStyle | undefined,
  path: string,
  report: SafetyReporter,
) {
  if (!style) return;
  validateColor(style.color, `${path}.color`, report);
  validateColor(style.wireframeColor, `${path}.wireframeColor`, report);
  validateGraph3DFill(style.fill, `${path}.fill`, report);
}

function validateGraph3DFill(
  fill: Graph3DFillStyle | undefined,
  path: string,
  report: SafetyReporter,
) {
  if (fill && fill.mode !== "none") {
    validateColor(fill.color, `${path}.color`, report);
  }
}

function validateGraph3DPlane(
  plane: Graph3DPlaneDefinition,
  path: string,
  report: SafetyReporter,
) {
  if (plane.kind === "equation") {
    validateGraph3DExpression(plane.expression, `${path}.expression`, report);
  } else if (plane.kind === "threePoints") {
    plane.points.forEach((point, index) => {
      validateGraph3DExpressionVector(point, `${path}.points.${index}`, report);
    });
  } else {
    validateGraph3DExpressionVector(plane.point, `${path}.point`, report);
    validateGraph3DExpressionVector(plane.normal, `${path}.normal`, report);
  }
}

function validateGraph3DBounds(bounds: Graph3DBounds, path: string, report: SafetyReporter) {
  validateGraph3DRange(bounds.x, `${path}.x`, report);
  validateGraph3DRange(bounds.y, `${path}.y`, report);
  validateGraph3DRange(bounds.z, `${path}.z`, report);
}

function validateGraph3DRange(range: Graph3DExpressionRange, path: string, report: SafetyReporter) {
  validateGraph3DExpression(range.min, `${path}.min`, report);
  validateGraph3DExpression(range.max, `${path}.max`, report);
}

function validateGraph3DExpressionVector(
  vector: Graph3DExpressionVector3,
  path: string,
  report: SafetyReporter,
) {
  validateGraph3DExpression(vector.x, `${path}.x`, report);
  validateGraph3DExpression(vector.y, `${path}.y`, report);
  validateGraph3DExpression(vector.z, `${path}.z`, report);
}

function validateGraph3DExpression(expression: string, path: string, report: SafetyReporter) {
  if (expression.length > MAX_GRAPH3D_EXPRESSION_LENGTH) {
    report(path, `3D数式は${MAX_GRAPH3D_EXPRESSION_LENGTH}文字以内で指定してください。`);
  }
}

function validateGraph3DCollection(collection: readonly unknown[], path: string, report: SafetyReporter) {
  if (collection.length > MAX_GRAPH3D_COLLECTION_LENGTH) {
    report(path, `3Dデータの要素数は${MAX_GRAPH3D_COLLECTION_LENGTH}件以内で指定してください。`);
  }
}

function validateGraphSpec(spec: Graph2DSpec, path: string, report: SafetyReporter) {
  validateColor(spec.axes.axisColor, `${path}.axes.axisColor`, report);
  spec.curves.forEach((curve, index) => validateColor(curve.color, `${path}.curves.${index}.color`, report));
  spec.points?.forEach((point, index) => validateColor(point.color, `${path}.points.${index}.color`, report));
  spec.fills?.forEach((fill, index) => validateColor(fill.color, `${path}.fills.${index}.color`, report));
}

function validateTableSpec(table: SigmaTableSpec, path: string, report: SafetyReporter) {
  validateColor(table.grid.borderColor, `${path}.grid.borderColor`, report);
  table.grid.lineOverrides?.forEach((override, index) => validateTableGridStyle(override.style, `${path}.grid.lineOverrides.${index}.style`, report));
  validateTableCellStyle(table.defaultCellStyle, `${path}.defaultCellStyle`, report);
  table.cells.forEach((cell, cellIndex) => {
    validateTableCellStyle(cell.style, `${path}.cells.${cellIndex}.style`, report);
    cell.content.forEach((content, index) => validateTableCellContent(content, `${path}.cells.${cellIndex}.content.${index}`, report));
  });
}

function validateChartSpec(spec: SigmaChartSpec, path: string, report: SafetyReporter) {
  // `seriesColors` is the chart's only CSS-valued field; the data it draws is numbers and text.
  // The record is walked rather than the keys the data declares, for the same reason a trend cell's
  // decoy `children` is walked above: the structural guard does not reject extra keys.
  const seriesColors = spec.seriesColors as Record<string, unknown> | undefined;
  if (!seriesColors) return;
  for (const key of Object.keys(seriesColors)) {
    validateColor(seriesColors[key] as string | undefined, `${path}.seriesColors.${key}`, report);
  }
}

function validateTableGridStyle(style: SigmaTableGridLineStyle, path: string, report: SafetyReporter) {
  validateColor(style.borderColor, `${path}.borderColor`, report);
}

function validateTableCellStyle(style: Partial<SigmaTableCellStyle> | undefined, path: string, report: SafetyReporter) {
  if (!style) return;
  validateColor(style.color, `${path}.color`, report);
  validateColor(style.backgroundColor, `${path}.backgroundColor`, report);
  validateFontFamily(style.fontFamily, `${path}.fontFamily`, report);
}

function validateTableCellContent(content: SigmaTableCellContent, path: string, report: SafetyReporter) {
  // Both arrays are walked rather than the one the node type says it uses: the structural guard
  // does not reject unknown keys, so a trend carrying a decoy empty `children` beside a poisoned
  // `label` would otherwise skip the check. Same reasoning as `overlay-snapshot.ts`.
  const candidate = content as { children?: unknown; label?: unknown };
  for (const key of ["children", "label"] as const) {
    const nodes = candidate[key];
    if (Array.isArray(nodes)) {
      nodes.forEach((node, index) => visitInlineNode(node as InlineNode, `${path}.${key}.${index}`, report));
    }
  }
}

function validateColor(value: string | null | undefined, path: string, report: SafetyReporter) {
  if (!isPresent(value)) return;
  if (!isSafeCssScalar(value)) {
    report(path, "CSS注入につながる文字列は指定できません。");
    return;
  }
  if (!isSafeCssColor(value)) {
    report(path, "許可されていない色表現です。");
  }
}

function validateFontFamily(value: string | null | undefined, path: string, report: SafetyReporter) {
  if (!isPresent(value)) return;
  if (!isSafeCssFontFamily(value)) {
    report(path, "font-familyに安全でない値があります。");
  }
}

function validateLineHeight(value: string | null | undefined, path: string, report: SafetyReporter) {
  if (!isPresent(value)) return;
  if (!isSafeCssScalar(value) || !/^(?:\d+(?:\.\d+)?|\.\d+)$/u.test(value.trim())) {
    report(path, "line-heightは単位なし数値だけ指定できます。");
    return;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0.5 || number > 5) {
    report(path, "line-heightが許可範囲外です。");
  }
}

/**
 * ブロック下余白 (`spaceAfterPx`)。CSS px の数値だけを受け取り、`padding-bottom` の
 * custom property へそのまま出す値なので、文字列や範囲外は描く前にここで弾く。
 */
function validateBlockSpaceAfterPx(value: unknown, path: string, report: SafetyReporter) {
  if (value === undefined || value === null) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 400) {
    report(path, "ブロック下余白は0以上400以下の数値で指定してください。");
  }
}

/**
 * boxBlock frame の titleLineHeight/bodyLineHeight はCSS lineHeightの倍率ではなく、
 * ノート罫線ピッチ(box-blocks.ts の --sigma-doc-box-*-line-height)で、
 * 単位なし倍率とpx長さの両方を正当に取り得る(bodyLineHeight: "23.35px" 等)。
 * 通常のブロックlineHeight(単位なし倍率のみ)とは別に、長さも許容する。
 */
function validateBoxLineHeight(value: string | null | undefined, path: string, report: SafetyReporter) {
  if (!isPresent(value)) return;
  const trimmed = value.trim();
  if (!isSafeCssScalar(value) || !SAFE_BOX_LINE_HEIGHT.test(trimmed)) {
    report(path, "line-heightは数値またはpx単位の長さで指定してください。");
    return;
  }
  const number = Number.parseFloat(trimmed);
  if (!Number.isFinite(number) || number < 0 || number > 999) {
    report(path, "line-heightが許可範囲外です。");
  }
}

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== undefined && value !== null;
}

function isSafePositiveCssNumber(value: unknown, max: number, allowZero = false): boolean {
  if (typeof value === "string" && (!isSafeCssScalar(value) || !/^(?:\d+(?:\.\d+)?|\.\d+)$/u.test(value.trim()))) {
    return false;
  }
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && (allowZero ? number >= 0 : number > 0) && number <= max;
}

function validateRasterPayload(
  src: string,
  payload: string,
  mimeType: ValidatedImageDataUrl["mimeType"],
  validator: (bytes: Uint8Array) => boolean,
): ImageDataUrlValidation {
  const bytes = decodeStrictBase64(payload);
  if (!bytes || !validator(bytes)) {
    return { ok: false, reason: `${mimeType}画像のpayloadが不正です。` };
  }
  return { ok: true, value: { src, mimeType } };
}

function decodeStrictBase64(payload: string): Uint8Array | null {
  if (!payload || payload.length % 4 !== 0 || payload.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !STRICT_BASE64.test(payload)) {
    return null;
  }
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  const byteLength = payload.length / 4 * 3 - padding;
  if (byteLength <= 0 || byteLength > MAX_IMAGE_BYTES) return null;
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (let index = 0; index < payload.length; index += 4) {
    const a = base64Value(payload.charCodeAt(index));
    const b = base64Value(payload.charCodeAt(index + 1));
    const c = payload[index + 2] === "=" ? 0 : base64Value(payload.charCodeAt(index + 2));
    const d = payload[index + 3] === "=" ? 0 : base64Value(payload.charCodeAt(index + 3));
    if (a < 0 || b < 0 || c < 0 || d < 0) return null;
    const packed = (a << 18) | (b << 12) | (c << 6) | d;
    if (offset < byteLength) bytes[offset++] = packed >>> 16 & 0xff;
    if (offset < byteLength) bytes[offset++] = packed >>> 8 & 0xff;
    if (offset < byteLength) bytes[offset++] = packed & 0xff;
  }
  return bytes;
}

function base64Value(code: number): number {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  if (code === 43) return 62;
  if (code === 47) return 63;
  return -1;
}

function isPngPayload(bytes: Uint8Array): boolean {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 45 || !signature.every((byte, index) => bytes[index] === byte)) return false;
  let offset = 8;
  let sawHeader = false;
  while (offset + 12 <= bytes.length) {
    const length = readUint32Be(bytes, offset);
    const type = ascii(bytes, offset + 4, 4);
    const end = offset + 12 + length;
    if (end > bytes.length) return false;
    if (!sawHeader) {
      if (type !== "IHDR" || length !== 13 || readUint32Be(bytes, offset + 8) === 0 || readUint32Be(bytes, offset + 12) === 0) return false;
      sawHeader = true;
    }
    if (type === "IEND") return length === 0 && end === bytes.length;
    offset = end;
  }
  return false;
}

function isJpegPayload(bytes: Uint8Array): boolean {
  if (bytes.length < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return false;
  for (let index = 2; index + 1 < bytes.length - 2; index += 1) {
    if (bytes[index] !== 0xff) continue;
    const marker = bytes[index + 1];
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      return true;
    }
  }
  return false;
}

function isWebpPayload(bytes: Uint8Array): boolean {
  if (bytes.length < 20 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") return false;
  if (readUint32Le(bytes, 4) + 8 !== bytes.length) return false;
  const chunk = ascii(bytes, 12, 4);
  const chunkLength = readUint32Le(bytes, 16);
  return (chunk === "VP8 " || chunk === "VP8L" || chunk === "VP8X") && 20 + chunkLength <= bytes.length;
}

function getSvgPayloadIssue(svg: string): string | null {
  const trimmed = svg.trim();
  if (!trimmed || trimmed.length > MAX_IMAGE_BYTES || XML_UNSAFE_CONTROL_CHARACTER.test(svg)) {
    return "SVG画像が空、過大、または制御文字を含んでいます。";
  }
  const decoded = decodeXmlEntities(trimmed);
  if (decoded === null || XML_UNSAFE_CONTROL_CHARACTER.test(decoded)) {
    return "SVG画像に不正な文字参照または制御文字があります。";
  }
  if (!/^(?:<\?xml\s[^>]*>\s*)?<svg(?:\s|>)[\s\S]*<\/svg>\s*$/iu.test(decoded)) {
    return "SVG画像に有効なsvgルート要素がありません。";
  }
  if (/<!doctype\b|<!entity\b|<\?xml-stylesheet\b|<(?:script|foreignObject|iframe|object|embed)\b/iu.test(decoded)) {
    return "SVG画像に許可されていない要素があります。";
  }
  if (/\son[a-z][\w:-]*\s*=/iu.test(decoded)) {
    return "SVG画像にイベント属性があります。";
  }
  if (/(?:@import\b|expression\s*\(|javascript\s*:|vbscript\s*:|data\s*:|\/\*)/iu.test(decoded)) {
    return "SVG画像に@importまたは危険なCSSがあります。";
  }
  const withoutInternalUrls = decoded.replace(/url\s*\(\s*([^)]*?)\s*\)/giu, (token, rawTarget: string) => {
    const trimmedTarget = rawTarget.trim();
    const target = ((trimmedTarget.startsWith('"') && trimmedTarget.endsWith('"')) ||
      (trimmedTarget.startsWith("'") && trimmedTarget.endsWith("'")))
      ? trimmedTarget.slice(1, -1).trim()
      : trimmedTarget;
    return /^#[A-Za-z_][\w:.-]*$/u.test(target) ? "" : token;
  });
  if (/url\s*\(/iu.test(withoutInternalUrls)) {
    return "SVG画像のurl()は同一SVG内の要素だけ参照できます。";
  }
  const hrefPattern = /\s(?:href|xlink:href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/giu;
  for (const match of decoded.matchAll(hrefPattern)) {
    const href = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (!href.startsWith("#")) {
      return "SVG画像から外部resourceを参照できません。";
    }
  }
  return null;
}

function decodeXmlEntities(value: string): string | null {
  let valid = true;
  const decoded = value.replace(/&(?:#(\d+)|#x([\da-f]+)|amp|lt|gt|quot|apos);/giu, (entity, decimal: string | undefined, hex: string | undefined) => {
    if (decimal || hex) {
      const codePoint = decimal ? Number(decimal) : Number.parseInt(hex!, 16);
      if (!isValidXmlCodePoint(codePoint)) {
        valid = false;
        return "";
      }
      return String.fromCodePoint(codePoint);
    }
    return ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" } as Record<string, string>)[entity.toLowerCase()] ?? entity;
  });
  return valid ? decoded : null;
}

function isValidXmlCodePoint(value: number): boolean {
  return Number.isSafeInteger(value) && (
    value === 0x09 ||
    value === 0x0a ||
    value === 0x0d ||
    (value >= 0x20 && value <= 0xd7ff) ||
    (value >= 0xe000 && value <= 0xfffd) ||
    (value >= 0x10000 && value <= 0x10ffff)
  );
}

function readUint32Be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function readUint32Le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let value = "";
  for (let index = 0; index < length; index += 1) value += String.fromCharCode(bytes[offset + index]);
  return value;
}

type SafetyReporter = (path: string, message: string) => void;
