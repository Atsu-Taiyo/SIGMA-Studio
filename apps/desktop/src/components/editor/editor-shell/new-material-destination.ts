import { canMutateWorkspaceItem } from "@/components/workspace/workspace-sharing-permissions";
import { getRuntimeTarget } from "@/lib/runtime";
import type { RuntimeTarget } from "@/lib/runtime/types";
import { SHARED_ITEMS_WORKSPACE_ID } from "@/lib/runtime/shared-catalog";
import {
  listWorkspaceOverview,
  type WorkspaceFileSummary,
  type WorkspaceOverview,
} from "@/lib/workspace-repository";

/**
 * 新規教材の作成先 (Issue #211)。
 *
 * - そのまま押した (⌘N・ファイルメニュー・タブの「新規教材」・教材一覧の「新規教材」) ときは、
 *   直前まで開いていた教材と同じワークスペースに作る。フォルダは従来どおり、その教材と同じフォルダ。
 * - その場所に作れない (読み取り専用の共有・共有アイテムの最上位・同期が止まっている共有) ときは、
 *   直前の教材が無いときと同じ既定の作成先 (このPCの最初のワークスペースの直下) に作る。
 *   何でもクラウドへ作ることはしない。
 * - ホバーで開くメニューでは、作れるワークスペースだけを選択肢に出す。選んだワークスペースが
 *   直前の教材と同じなら同じフォルダ、別のワークスペースならその直下に作る。
 *
 * 作成後は、実際に保存された場所 (作成結果のメタデータ) からワークスペース名とフォルダの階層を引き直して見せる。
 */

export interface NewMaterialLocation {
  workspaceId: string;
  folderId: string | null;
}

/** 作成先がどう決まったか。 */
export type NewMaterialOrigin =
  /** 直前の教材と同じ場所。 */
  | "previous"
  /** 直前の教材の場所には作れないので、既定の作成先にした。 */
  | "fallback"
  /** メニューでワークスペースを選んだ。 */
  | "chosen"
  /** 直前の教材が無い (起動中など)。保存先の既定に任せた。 */
  | "default";

export interface NewMaterialWorkspaceOption {
  workspaceId: string;
  /** 共有アイテムの名前は呼び出し側が辞書で引く (`sharedItems`)。 */
  name: string;
  sharedItems: boolean;
  /** 共有 (クラウド) のワークスペースか。 */
  cloud: boolean;
  location: NewMaterialLocation;
  /** そのまま押したときの作成先。 */
  isDefault: boolean;
}

export interface NewMaterialTargetPlan {
  options: NewMaterialWorkspaceOption[];
  /** そのまま押したときの作成先。`location` が無いときは保存先の既定に任せる。 */
  clickTarget: { location?: NewMaterialLocation; origin: "previous" | "fallback" };
}

type PreviousMaterial = Pick<WorkspaceFileSummary, "workspaceId" | "folderId">;
type TargetOverview = Pick<WorkspaceOverview, "workspaces" | "folders" | "catalog">;

function canCreateIn(
  item: { sharing?: WorkspaceOverview["workspaces"][number]["sharing"]; sharingPending?: boolean } | undefined,
  catalog: WorkspaceOverview["catalog"],
): boolean {
  return Boolean(item) && !item?.sharingPending && canMutateWorkspaceItem(item?.sharing, catalog, "createChildren");
}

/**
 * 直前の教材と一覧 (直前の教材のワークスペースを開いた一覧) から、選べる作成先とそのまま押したときの作成先を決める。
 * `overview.folders` は直前の教材のワークスペースのものを渡す (フォルダに作れるかを見るため)。
 */
export function planNewMaterialTargets(
  previous: PreviousMaterial | undefined,
  overview: TargetOverview,
): NewMaterialTargetPlan {
  const { catalog } = overview;
  const previousWorkspace = previous
    ? overview.workspaces.find((workspace) => workspace.id === previous.workspaceId)
    : undefined;
  const previousFolder = previous?.folderId
    ? overview.folders.find((folder) => folder.id === previous.folderId && folder.workspaceId === previous.workspaceId)
    : undefined;
  const previousParentCreatable = Boolean(previous) && (previous?.folderId
    ? canCreateIn(previousFolder, catalog)
    : previous?.workspaceId !== SHARED_ITEMS_WORKSPACE_ID && canCreateIn(previousWorkspace, catalog));

  const options: Omit<NewMaterialWorkspaceOption, "isDefault">[] = [];
  for (const workspace of overview.workspaces) {
    const sharedItems = workspace.id === SHARED_ITEMS_WORKSPACE_ID;
    const base = { workspaceId: workspace.id, name: workspace.name, sharedItems, cloud: sharedItems || Boolean(workspace.sharing) };
    if (previous && previousParentCreatable && workspace.id === previous.workspaceId) {
      // 直前の教材のワークスペースは、そのまま押したときと同じフォルダに作る。
      options.push({ ...base, cloud: base.cloud || Boolean(previousFolder?.sharing), location: { workspaceId: workspace.id, folderId: previous.folderId } });
    } else if (!sharedItems && canCreateIn(workspace, catalog)) {
      options.push({ ...base, location: { workspaceId: workspace.id, folderId: null } });
    }
  }

  const previousOption = previousParentCreatable
    ? options.find((option) => option.workspaceId === previous?.workspaceId)
    : undefined;
  // 既定の作成先は、直前の教材が無いときの保存先の既定 (台帳で最初のワークスペースの直下) に合わせ、
  // 共有のワークスペースは選ばない。
  const fallbackOption = options.find((option) => !option.cloud);
  const clickTarget: NewMaterialTargetPlan["clickTarget"] = previousOption
    ? { location: previousOption.location, origin: "previous" }
    : { location: fallbackOption ? { workspaceId: fallbackOption.workspaceId, folderId: null } : undefined, origin: "fallback" };
  const defaultWorkspaceId = clickTarget.location?.workspaceId ?? null;
  return {
    options: options.map((option) => ({ ...option, isDefault: option.workspaceId === defaultWorkspaceId })),
    clickTarget,
  };
}

/** メニューに出す作成先を読む。直前の教材のワークスペースを開いた一覧を使う (そのフォルダに作れるかを見るため)。 */
export async function loadNewMaterialTargets(previous: PreviousMaterial | undefined): Promise<NewMaterialTargetPlan | null> {
  const result = await listWorkspaceOverview(previous?.workspaceId);
  return result.state === "ready" ? planNewMaterialTargets(previous, result.overview) : null;
}

/**
 * 作る直前に作成先を決め直す (メニューを開いた後に共有や権限が変わっていても、今の状態で決める)。
 * 選んだワークスペースに作れなくなっていたら `FORBIDDEN` で止め、別の場所へは作らない。
 */
export async function resolveNewMaterialDestination(
  previous: PreviousMaterial | undefined,
  chosenWorkspaceId?: string,
): Promise<{ location?: NewMaterialLocation; origin: NewMaterialOrigin }> {
  if (!previous && !chosenWorkspaceId) return { origin: "default" };
  const plan = await loadNewMaterialTargets(previous).catch(() => null);
  if (chosenWorkspaceId) {
    const option = plan?.options.find((item) => item.workspaceId === chosenWorkspaceId);
    if (!option) throw new Error("FORBIDDEN");
    return { location: option.location, origin: "chosen" };
  }
  // 一覧を読めないときは、従来どおり直前の教材と同じ場所を保存先へ渡す (作れなければ保存先が断る)。
  if (!plan) return { location: previous && { workspaceId: previous.workspaceId, folderId: previous.folderId }, origin: "previous" };
  return plan.clickTarget;
}

/** 完了ダイアログに出す、実際に作った場所。 */
export interface CreatedMaterialNotice {
  kind: "material" | "whiteboard";
  title: string;
  workspaceId: string;
  /** 読めなかったときは null。 */
  workspaceName: string | null;
  sharedItems: boolean;
  /** ワークスペースから作成先のフォルダまでの名前。直下なら空。読めなかったときは null。 */
  folderPath: string[] | null;
  /** 保存先。共有 (クラウド) か、この端末 (デスクトップはこのPC、ブラウザ版はこのブラウザ) か。 */
  storage: "cloud" | "device" | "browser";
  origin: NewMaterialOrigin;
}

export function describeCreatedMaterial(
  created: Pick<WorkspaceFileSummary, "workspaceId" | "folderId" | "title" | "sharing">,
  overview: Pick<WorkspaceOverview, "workspaces" | "folders"> | null,
  options: { kind: CreatedMaterialNotice["kind"]; origin: NewMaterialOrigin; runtimeTarget: RuntimeTarget },
): CreatedMaterialNotice {
  const workspace = overview?.workspaces.find((item) => item.id === created.workspaceId);
  const sharedItems = created.workspaceId === SHARED_ITEMS_WORKSPACE_ID;
  let folderPath: string[] | null = [];
  if (created.folderId) {
    const names: string[] = [];
    const seen = new Set<string>();
    let current = overview?.folders.find((folder) => folder.id === created.folderId && folder.workspaceId === created.workspaceId);
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      names.unshift(current.name);
      const parentId: string | null = current.parentFolderId;
      current = parentId && parentId !== current.id
        ? overview?.folders.find((folder) => folder.id === parentId && folder.workspaceId === created.workspaceId)
        : undefined;
    }
    folderPath = names.length > 0 ? names : null;
  }
  return {
    kind: options.kind,
    title: created.title,
    workspaceId: created.workspaceId,
    workspaceName: workspace?.name ?? null,
    sharedItems,
    folderPath,
    storage: sharedItems || created.sharing || workspace?.sharing ? "cloud" : options.runtimeTarget === "web" ? "browser" : "device",
    origin: options.origin,
  };
}

/** 作った教材の場所を、保存先から読み直して説明する (作ろうとした場所ではなく、実際に保存された場所を見せる)。 */
export async function loadCreatedMaterialNotice(
  created: Pick<WorkspaceFileSummary, "workspaceId" | "folderId" | "title" | "sharing">,
  options: { kind: CreatedMaterialNotice["kind"]; origin: NewMaterialOrigin },
): Promise<CreatedMaterialNotice> {
  const result = await listWorkspaceOverview(created.workspaceId).catch(() => null);
  return describeCreatedMaterial(created, result?.state === "ready" ? result.overview : null, { ...options, runtimeTarget: getRuntimeTarget() });
}
