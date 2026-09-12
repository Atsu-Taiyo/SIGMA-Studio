import type { RenderUnit } from "./types";

export interface TextRunGroupAssignment {
  groupId: string;
  order: number;
}

/**
 * `units` を唯一の文書順として、本文を編集する全ユニットを 1 つの選択対象へ束ねる。
 * 浮遊図形や単体ブロックは TextFlowEditor ではないので登録しない。
 */
export function assignTextRunGroupIds(
  units: readonly RenderUnit[],
  documentId?: string,
): ReadonlyMap<string, TextRunGroupAssignment> {
  const assignments = new Map<string, TextRunGroupAssignment>();
  const groupId = documentId ?? units.find(isTextRunUnit)?.id;
  if (!groupId) {
    return assignments;
  }
  let order = 0;

  for (const unit of units) {
    if (!isTextRunUnit(unit)) {
      continue;
    }
    assignments.set(unit.id, { groupId, order });
    order += 1;
  }

  return assignments;
}

function isTextRunUnit(
  unit: RenderUnit,
): unit is Extract<RenderUnit, { type: "textFlow" | "problemArea" | "layoutSection" | "problemLayoutSection" }> {
  return unit.type === "textFlow"
    || unit.type === "problemArea"
    || unit.type === "layoutSection"
    || unit.type === "problemLayoutSection";
}
