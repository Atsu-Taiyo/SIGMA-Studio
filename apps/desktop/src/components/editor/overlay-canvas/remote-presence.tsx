"use client";
import type {
  RemoteSessionOverlayPresence,
  SessionOverlayPresence,
} from "@/features/document-session/contracts";
import {
  getShapeRotation,
  getShapeRotationPivot,
  getShapeVisualBounds,
  getShapesVisualBounds
} from "@/features/drawing";
import type {
  CSSProperties
} from "react";
import {
  useEffect,
  useState
} from "react";
import { useDocumentSession } from "../document-session-context";
import {
  type OverlayInteractionMode
} from "./interaction-mode";
import {
  boundsFromPoints,
  getAxisAlignedRotatedBounds
} from "./math";
import { getSelectionTransformOriginFromPivot } from "./selection-chrome";
import type {
  OverlayBounds,
  OverlayShape
} from "./types";

export function getOverlayPresencePreviewKind(
  mode: OverlayInteractionMode,
): NonNullable<SessionOverlayPresence["preview"]>["kind"] | null {
  if (mode.id === "overlay.move") return "move";
  if (mode.id === "overlay.resize") return "resize";
  if (mode.id === "overlay.rotate") return "rotate";
  if (mode.id === "overlay.imageCropResize" || mode.id === "overlay.imageCropPan") return "crop";
  return null;
}

export function useRemoteOverlayPresence(
  session: ReturnType<typeof useDocumentSession>,
): RemoteSessionOverlayPresence[] {
  const [snapshot, setSnapshot] = useState<{
    session: ReturnType<typeof useDocumentSession>;
    presence: RemoteSessionOverlayPresence[];
  } | null>(null);
  useEffect(() => {
    if (!session?.remoteOverlayPresence || !session.subscribePresence) return;
    const update = () => setSnapshot({ session, presence: session.remoteOverlayPresence?.() ?? [] });
    return session.subscribePresence(update);
  }, [session]);
  if (!session?.remoteOverlayPresence) return [];
  return snapshot?.session === session ? snapshot.presence : session.remoteOverlayPresence();
}

export function RemoteOverlayPresenceLayer({
  shapes,
}: {
  shapes: OverlayShape[];
}) {
  const session = useDocumentSession();
  const participants = useRemoteOverlayPresence(session);
  const presentations = participants
    .map((participant) => ({ participant, frames: resolveRemoteOverlayPresenceFrames(participant, shapes) }))
    .filter((entry) => entry.frames.length > 0)
    .sort((left, right) => left.participant.clientId.localeCompare(right.participant.clientId));
  const labelSlots = new Map<string, number>();
  return (
    <div className="overlay-remote-presence-layer" aria-hidden="true">
      {presentations.map(({ participant, frames }) => {
        const labelBounds = getRemoteOverlayPresenceLabelBounds(frames);
        const labelKey = `${Math.round(labelBounds.x)}:${Math.round(labelBounds.y)}:${frames.map((frame) => frame.id).sort().join("|")}`;
        const labelSlot = labelSlots.get(labelKey) ?? 0;
        labelSlots.set(labelKey, labelSlot + 1);
        const color = remotePresenceColor(participant.clientId);
        return (
          <div
            key={participant.clientId}
            className="overlay-remote-presence"
            data-remote-client-id={participant.clientId}
            data-remote-preview-kind={participant.preview?.kind}
            style={{ "--overlay-remote-color": color } as CSSProperties}
          >
            {frames.map((frame) => (
              <div
                key={frame.id}
                className="overlay-remote-selection-box"
                data-remote-shape-id={frame.id}
                style={getRemoteOverlayPresenceFrameStyle(frame)}
              />
            ))}
            <span
              className="overlay-remote-presence-label"
              data-remote-label-slot={labelSlot}
              style={{ left: labelBounds.x, top: labelBounds.y - (labelSlot * 30) }}
            >
              <RemotePresenceAvatar participant={participant} />
              <span>{participant.displayName}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function resolveRemoteOverlayPresenceFrames(
  participant: RemoteSessionOverlayPresence,
  shapes: OverlayShape[],
): Array<NonNullable<SessionOverlayPresence["preview"]>["shapes"][number]> {
  const byId = new Map(shapes.map((shape) => [shape.id, shape]));
  const preview = participant.preview?.shapes.filter((item) => byId.has(item.id)) ?? [];
  if (preview.length > 0) return preview;
  return participant.selectedShapeIds.flatMap((id) => {
    const shape = byId.get(id);
    if (!shape) return [];
    const bounds = shape.type === "group"
      ? getShapesVisualBounds([shape], shapes) ?? getShapeVisualBounds(shape)
      : getShapeVisualBounds(shape);
    const rotation = getShapeRotation(shape);
    return [{
      id,
      ...bounds,
      ...(rotation ? { rotation, pivot: getShapeRotationPivot(shape) } : {}),
    }];
  });
}

export function getRemoteOverlayPresenceLabelBounds(
  frames: Array<NonNullable<SessionOverlayPresence["preview"]>["shapes"][number]>,
): OverlayBounds {
  const rotatedBounds = frames.map((frame) => getAxisAlignedRotatedBounds(
    frame,
    frame.rotation ?? 0,
    frame.pivot,
  ));
  return boundsFromPoints(rotatedBounds.flatMap((bounds) => [
    { x: bounds.x, y: bounds.y },
    { x: bounds.x + bounds.w, y: bounds.y + bounds.h },
  ]));
}

export function RemotePresenceAvatar({ participant }: { participant: RemoteSessionOverlayPresence }) {
  const [failed, setFailed] = useState(false);
  const initial = participant.displayName.trim().charAt(0).toLocaleUpperCase() || "?";
  return (
    <span className="overlay-remote-presence-avatar">
      {participant.avatarSource && !failed ? (
        // Electron main bounds and validates this custom-protocol image response.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={participant.avatarSource} alt="" onError={() => setFailed(true)} />
      ) : initial}
    </span>
  );
}

export function remotePresenceColor(clientId: string): string {
  const colors = ["#2563eb", "#7c3aed", "#db2777", "#059669", "#d97706", "#0891b2"];
  let hash = 0;
  for (let index = 0; index < clientId.length; index += 1)
    hash = ((hash << 5) - hash + clientId.charCodeAt(index)) | 0;
  return colors[Math.abs(hash) % colors.length];
}

export function getRemoteOverlayPresenceFrameStyle(
  frame: NonNullable<SessionOverlayPresence["preview"]>["shapes"][number],
): CSSProperties {
  return {
    left: frame.x,
    top: frame.y,
    width: frame.w,
    height: frame.h,
    transform: frame.rotation ? `rotate(${frame.rotation}rad)` : undefined,
    transformOrigin: frame.rotation && frame.pivot
      ? getSelectionTransformOriginFromPivot(frame.pivot, frame)
      : undefined,
  };
}