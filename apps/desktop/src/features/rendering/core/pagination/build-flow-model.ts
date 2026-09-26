import type { FlowBand, FlowBlank, FlowColumn, FlowItem, FlowLine, FlowModel, FlowSection } from "./model";
import type { ProbeInk, ProbeNode, ProbeTree, ProbeUnit } from "./probe-types";

/**
 * 自然配置の計測 (ProbeTree) を、配置エンジンが詰める行モデルへ変換する。
 *
 * - 行 = 縦に重なる描画 (文字の行片・行内原子・空行・付属物) の和集合。重ならない 2 つの
 *   行の間でだけ切れる。問題番号は重なる行と 1 つになり、本文と離れない。
 * - 見える縁 (箱の枠・コード背景・問題文の枠) の開き側は最初の行に、閉じ側は最後の行に接着する。
 *   見えない padding / margin は行の間の隙間として残し、送った先では詰める。
 * - 最小高さの予約は分割できる空白。手動改ページはその行の前の改ページ (段組では改段)。
 */

export interface BuiltNode {
  id: string;
  unitId: string;
  /** 独立段組の列のキー (本文直下なら null)。 */
  columnKey: string | null;
  top: number;
  bottom: number;
  left: number;
  width: number;
  lineKeys: string[];
  breakBefore: boolean;
}

export interface BuiltUnit {
  id: string;
  top: number;
  bottom: number;
  left: number;
  width: number;
  nodes: BuiltNode[];
  /** ユニットが所有する行 (付属物・分割できない中身) のキー。 */
  ownLineKeys: string[];
  /** ユニットの全項目 (行と空白) のキーを文書順に。 */
  itemKeys: string[];
  frame?: ProbeUnit["frame"];
  reservationKey?: string;
  placeholderKey?: string;
  breakBefore: boolean;
}

export interface BuiltFlowModel {
  model: FlowModel;
  units: BuiltUnit[];
  /** 行キー → 行 (描画計画が自然座標を引くため)。 */
  lines: Map<string, FlowLine>;
  blanks: Map<string, FlowBlank>;
}

export interface BuildFlowModelOptions {
  /** 段組のページでは手動改ページは改段になる。 */
  breakTarget: "page" | "column";
}

interface Band {
  top: number;
  bottom: number;
}

/** 重なり判定の許容。丸めで 1px 未満触れているだけの行は別の行として扱う。 */
const OVERLAP_TOLERANCE_PX = 1;
/**
 * 同じ行とみなす重なりの割合 (小さい方の高さに対して)。文字の矩形はフォントの ascent+descent で、
 * 行送りが詰まった段落 (line-height が文字の高さより小さい) では隣の行の矩形と重なる。
 * 少し触れているだけの重なりで同じ行にすると、段落全体が 1 行になって分割できなくなる。
 */
const SAME_LINE_OVERLAP_RATIO = 0.5;

export function groupInkIntoBands(ink: readonly Pick<ProbeInk, "top" | "bottom">[]): Band[] {
  const sorted = ink
    .filter((item) => Number.isFinite(item.top) && Number.isFinite(item.bottom) && item.bottom - item.top > 0.25)
    .map((item) => ({ top: item.top, bottom: item.bottom }))
    .sort((a, b) => a.top - b.top || a.bottom - b.bottom);
  const bands: Band[] = [];
  for (const item of sorted) {
    const last = bands.at(-1);
    const overlap = last ? Math.min(last.bottom, item.bottom) - item.top : 0;
    const required = last
      ? Math.max(OVERLAP_TOLERANCE_PX, SAME_LINE_OVERLAP_RATIO * Math.min(item.bottom - item.top, last.bottom - last.top))
      : 0;
    if (last && overlap > required) {
      last.bottom = Math.max(last.bottom, item.bottom);
    } else {
      bands.push({ ...item });
    }
  }
  // 重なったまま別の行になった隣どうしは、重なりの中ほどを境にする (行ボックスの境に当たる)。
  // 境をずらさないと、前の行の下端で切ったときに次の行の頭が前のページに覗く。
  for (let index = 1; index < bands.length; index += 1) {
    const previous = bands[index - 1];
    const current = bands[index];
    if (previous.bottom > current.top) {
      const boundary = (previous.bottom + current.top) / 2;
      previous.bottom = boundary;
      current.top = boundary;
    }
  }
  return bands;
}

export function buildFlowModel(tree: ProbeTree, options: BuildFlowModelOptions): BuiltFlowModel {
  const lines = new Map<string, FlowLine>();
  const blanks = new Map<string, FlowBlank>();
  const units: BuiltUnit[] = [];
  const sections: FlowSection[] = [];

  let currentSection: { key: string; span: "column" | "full"; items: FlowItem[] } | null = null;
  const sectionFor = (span: "column" | "full") => {
    if (!currentSection || currentSection.span !== span) {
      currentSection = { key: `section:${sections.length}`, span, items: [] };
      sections.push(currentSection);
    }
    return currentSection;
  };

  const registerLine = (line: FlowLine) => {
    lines.set(line.key, line);
    return line;
  };

  /** 1 つのブロックの行を作る。付属物は重なる行へ吸収する。 */
  const buildNodeLines = (node: ProbeNode, attachments: readonly ProbeInk[]): FlowLine[] => {
    const ink: Band[] = node.ink.map((item) => ({ top: item.top, bottom: item.bottom }));
    for (const attachment of attachments) ink.push({ top: attachment.top, bottom: attachment.bottom });
    let bands = groupInkIntoBands(ink);
    if (bands.length === 0) {
      bands = [{ top: node.rect.top, bottom: Math.max(node.rect.top + 1, node.rect.bottom) }];
    }
    const nodeLines: FlowLine[] = bands.map((band, index) => {
      const previous = bands[index - 1];
      // 行ボックスの上半分の行間は行に含める (送った先でも行頭の余白が自然に見える)。
      const top = previous
        ? Math.min(band.top, (previous.bottom + band.top) / 2)
        : Math.min(band.top, node.rect.top);
      return {
        kind: "line",
        key: `${node.id}#${index}`,
        ownerId: node.id,
        top,
        fitBottom: band.bottom,
        bottom: band.bottom,
        leadingSpace: 0,
      };
    });
    // 見える縁の接着。入れ子の箱も外側から順に同じ規則で。
    const chrome = [...node.chrome].sort((a, b) => a.top - b.top || b.bottom - a.bottom);
    for (const box of chrome) {
      const inside = nodeLines.filter((line) => line.fitBottom > box.top + 0.5 && line.top < box.bottom - 0.5);
      if (inside.length === 0) continue;
      const first = inside[0];
      const last = inside[inside.length - 1];
      first.top = Math.min(first.top, box.top);
      first.opens = [...(first.opens ?? []), box.id];
      last.fitBottom = Math.max(last.fitBottom, box.bottom);
      last.bottom = Math.max(last.bottom, box.bottom);
      last.closes = [...(last.closes ?? []), box.id];
    }
    return nodeLines;
  };

  for (const unit of tree.units) {
    const section = sectionFor(unit.span);
    const built: BuiltUnit = {
      id: unit.id,
      top: unit.rect.top,
      bottom: unit.rect.bottom,
      left: unit.rect.left,
      width: unit.rect.width,
      nodes: [],
      ownLineKeys: [],
      itemKeys: [],
      breakBefore: unit.breakBefore,
      ...(unit.frame ? { frame: unit.frame } : {}),
    };
    units.push(built);
    const unitItems: FlowItem[] = [];
    if (unit.breakBefore) {
      unitItems.push({ kind: "break", key: `${unit.id}#break`, ownerId: unit.id, target: options.breakTarget });
    }

    if (unit.placeholder) {
      const blank: FlowBlank = {
        kind: "blank",
        key: `${unit.id}#placeholder`,
        ownerId: unit.id,
        top: unit.rect.top,
        height: Math.max(0, unit.rect.bottom - unit.rect.top),
        virtual: false,
      };
      blanks.set(blank.key, blank);
      built.placeholderKey = blank.key;
      built.itemKeys.push(blank.key);
      unitItems.push(blank);
      section.items.push(...unitItems);
      continue;
    }

    const unitLines: FlowLine[] = [];
    let pendingAttachments = [...unit.attachments];
    const takeAttachments = (node: ProbeNode) => {
      const nodeBands = groupInkIntoBands(node.ink);
      const overlapping = pendingAttachments.filter((attachment) => nodeBands.some((band) => (
        attachment.top < band.bottom - OVERLAP_TOLERANCE_PX && attachment.bottom > band.top + OVERLAP_TOLERANCE_PX
      )));
      pendingAttachments = pendingAttachments.filter((attachment) => !overlapping.includes(attachment));
      return overlapping;
    };

    if (unit.columns && unit.columns.length > 0) {
      const columns: FlowColumn[] = unit.columns.map((column) => {
        const columnKey = `${unit.id}:column:${column.index}`;
        const items: FlowItem[] = [];
        for (const node of column.nodes) {
          const nodeLines = buildNodeLines(node, takeAttachments(node));
          nodeLines.forEach(registerLine);
          built.nodes.push({
            id: node.id,
            unitId: unit.id,
            columnKey,
            top: node.rect.top,
            bottom: node.rect.bottom,
            left: node.rect.left,
            width: node.rect.width,
            lineKeys: nodeLines.map((line) => line.key),
            breakBefore: node.breakBefore,
          });
          items.push(...nodeLines);
          unitLines.push(...nodeLines);
        }
        return {
          key: columnKey,
          ownerId: columnKey,
          xOffset: column.rect.left - unit.rect.left,
          width: column.rect.width,
          items,
        };
      });
      const columnLines = columns.flatMap((column) => column.items.filter((item): item is FlowLine => item.kind === "line"));
      if (columnLines.length > 0) {
        let bandTop = Math.min(...columns.map((column) => {
          const first = column.items.find((item): item is FlowLine => item.kind === "line");
          return first ? first.top : Number.POSITIVE_INFINITY;
        }));
        if (unit.frame?.first) bandTop = Math.min(bandTop, unit.frame.top);
        const bandBottom = Math.max(...columnLines.map((line) => line.bottom));
        if (unit.frame?.last && !unit.reservation) {
          for (const column of columns) {
            const last = [...column.items].reverse().find((item): item is FlowLine => item.kind === "line");
            if (last) {
              last.fitBottom = Math.max(last.fitBottom, unit.frame.bottom);
              last.bottom = Math.max(last.bottom, unit.frame.bottom);
            }
          }
        }
        const band: FlowBand = {
          kind: "band",
          key: `${unit.id}#band`,
          ownerId: unit.id,
          top: bandTop,
          bottom: unit.frame?.last && !unit.reservation ? Math.max(bandBottom, unit.frame.bottom) : bandBottom,
          columns,
        };
        unitItems.push(band);
        built.itemKeys.push(...columnLines.map((line) => line.key));
      }
    } else {
      unit.nodes.forEach((node, index) => {
        const nodeLines = buildNodeLines(node, takeAttachments(node));
        nodeLines.forEach(registerLine);
        built.nodes.push({
          id: node.id,
          unitId: unit.id,
          columnKey: null,
          top: node.rect.top,
          bottom: node.rect.bottom,
          left: node.rect.left,
          width: node.rect.width,
          lineKeys: nodeLines.map((line) => line.key),
          breakBefore: node.breakBefore,
        });
        if (node.breakBefore && !(index === 0 && unit.breakBefore)) {
          unitItems.push({ kind: "break", key: `${node.id}#break`, ownerId: node.id, target: options.breakTarget });
        }
        const innerBreaks = [...(node.innerBreaks ?? [])];
        nodeLines.forEach((line, lineIndex) => {
          // 箱の中の子の手動改ページ: その子の最初の行の前で切る (ブロックの先頭では切らない)。
          while (innerBreaks.length > 0 && innerBreaks[0] <= line.fitBottom - 0.5) {
            const breakY = innerBreaks.shift()!;
            if (lineIndex > 0 && breakY > nodeLines[lineIndex - 1].bottom - 0.5) {
              unitItems.push({ kind: "break", key: `${node.id}#inner${breakY.toFixed(1)}`, ownerId: node.id, target: options.breakTarget });
            }
          }
          unitItems.push(line);
        });
        unitLines.push(...nodeLines);
      });
    }

    // どの行とも重ならない付属物は、ユニットが持つ独立した行にする (文書順に差し込む)。
    for (const [index, attachment] of pendingAttachments.entries()) {
      const line = registerLine({
        kind: "line",
        key: `${unit.id}#attachment${index}`,
        ownerId: unit.id,
        top: attachment.top,
        fitBottom: attachment.bottom,
        bottom: attachment.bottom,
        leadingSpace: 0,
      });
      built.ownLineKeys.push(line.key);
      const insertAt = unitItems.findIndex((item) => item.kind === "line" && item.top > line.top);
      if (insertAt < 0) unitItems.push(line);
      else unitItems.splice(insertAt, 0, line);
      unitLines.push(line);
    }

    const flowLines = unitItems.filter((item): item is FlowLine => item.kind === "line");
    if (unit.frame?.first && flowLines[0]) {
      flowLines[0].top = Math.min(flowLines[0].top, unit.frame.top);
    }

    if (unit.reservation) {
      const closing = unit.frame?.last ? Math.max(0, unit.frame.bottom - unit.reservation.bottom) : 0;
      const blank: FlowBlank = {
        kind: "blank",
        key: `${unit.id}#reservation`,
        ownerId: unit.id,
        top: unit.reservation.top,
        height: Math.max(0, unit.reservation.bottom - unit.reservation.top),
        virtual: false,
        ...(closing > 0 ? { closingChrome: closing } : {}),
      };
      blanks.set(blank.key, blank);
      built.reservationKey = blank.key;
      unitItems.push(blank);
    } else if (unit.frame?.last && !unit.columns) {
      const last = flowLines.at(-1);
      if (last) {
        last.fitBottom = Math.max(last.fitBottom, unit.frame.bottom);
        last.bottom = Math.max(last.bottom, unit.frame.bottom);
      }
    }

    if (!unit.columns) {
      built.itemKeys.push(...unitItems.flatMap((item) => (item.kind === "line" || item.kind === "blank" ? [item.key] : [])));
    } else if (built.reservationKey) {
      built.itemKeys.push(built.reservationKey);
    }
    section.items.push(...unitItems);
  }

  return {
    model: { sections: sections.map((section) => ({ ...section, items: section.items })), containers: [] },
    units,
    lines,
    blanks,
  };
}
