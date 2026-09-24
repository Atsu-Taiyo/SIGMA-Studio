import * as Y from "yjs";
import {
  createRichFragment,
  isInlineContent,
  patchRichFragment,
  readRichFragment,
} from "./rich-text";
import {
  assertJsonValue,
  isObject,
  sameValue,
  type ObjectValue,
  type Value,
} from "./value";
import { MAX_DOCUMENT_BYTES, MAX_UPDATE_BYTES } from "./protocol";
import {
  recordCommentPositions,
  resolveCommentPositions,
} from "./comment-positions";

const REF = "$sigma:ref";
const TRANSFORM = "$sigma:transform";
const TRANSFORM_FIELDS = ["x", "y", "rotation"] as const;
const DIMENSION_FIELDS = ["w", "h", "r", "rx", "ry"];
type Entry = { id: string; token: string };
type Placement = Entry & { list: string };
type Stored = Value | Y.Map<Stored> | Y.Array<Stored> | Y.XmlFragment;
export const INITIALIZE_ORIGIN = Symbol("collaboration.initialize");
export const REMOTE_ORIGIN = Symbol("collaboration.remote");
export const LOCAL_ORIGIN = Symbol("collaboration.local");

/** One CRDT history. JSON is only an adapter projection, never a second editable store. */
export class SharedDocument {
  readonly doc: Y.Doc;
  private readonly root: Y.Map<Stored>;
  private readonly entities: Y.Map<Y.Map<Stored>>;
  private readonly placements: Y.Map<Placement>;
  private readonly deleted: Y.Map<boolean>;
  private readonly header: Y.Map<Value>;
  private readonly commentPositions: Y.Map<{ start: string; end: string }>;
  private projectingPlacements?: Map<string, Placement>;

  constructor(state?: Uint8Array) {
    this.doc = new Y.Doc({ gc: true });
    this.root = this.doc.getMap("document");
    this.entities = this.doc.getMap("entities");
    this.placements = this.doc.getMap("placements");
    this.deleted = this.doc.getMap("deleted");
    this.header = this.doc.getMap("header");
    this.commentPositions = this.doc.getMap("commentPositions");
    if (state) Y.applyUpdate(this.doc, state, INITIALIZE_ORIGIN);
  }

  initialize(
    document: Value,
    identity: { sharedDocumentId: string; epoch: number },
  ): void {
    if (this.header.size || this.root.size)
      throw new Error("ALREADY_INITIALIZED");
    assertJsonValue(document);
    if (!isObject(document)) throw new Error("INVALID_DOCUMENT");
    assertUniqueIds(document);
    this.doc.transact(() => {
      this.header.set("protocol", 1);
      this.header.set("sharedDocumentId", identity.sharedDocumentId);
      this.header.set("epoch", identity.epoch);
      this.patchObject(this.root, {}, document, "document");
      recordCommentPositions(this.commentPositions, {}, document, (id) =>
        this.getRichFragment(id, "children"),
      );
    }, INITIALIZE_ORIGIN);
  }

  identity(): { sharedDocumentId: string; epoch: number; protocol: number } {
    const sharedDocumentId = this.header.get("sharedDocumentId");
    const epoch = this.header.get("epoch");
    const protocol = this.header.get("protocol");
    if (
      typeof sharedDocumentId !== "string" ||
      typeof epoch !== "number" ||
      protocol !== 1
    )
      throw new Error("PROTOCOL_ERROR");
    return { sharedDocumentId, epoch, protocol };
  }

  snapshot(): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc);
  }
  vector(): Uint8Array {
    return Y.encodeStateVector(this.doc);
  }
  difference(vector: Uint8Array): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc, vector);
  }
  destroy(): void {
    this.doc.destroy();
  }

  project(): ObjectValue {
    this.identity();
    this.projectingPlacements = this.effectivePlacements();
    let value: ObjectValue;
    try {
      value = this.readObject(this.root, "document", new Set());
    } finally {
      this.projectingPlacements = undefined;
    }
    resolveCommentPositions(this.commentPositions, value, this.doc);
    assertJsonValue(value);
    assertUniqueIds(value);
    if (
      new TextEncoder().encode(JSON.stringify(value)).byteLength >
      MAX_DOCUMENT_BYTES
    )
      throw new Error("DOCUMENT_LIMIT");
    return value;
  }

  /** Compare to the caller's observed projection, so unobserved remote attributes survive. */
  change(
    before: ObjectValue,
    after: ObjectValue,
    origin: unknown = LOCAL_ORIGIN,
  ): void {
    assertJsonValue(after);
    assertUniqueIds(after);
    if (after.docId !== before.docId || after.version !== before.version)
      throw new Error("DOCUMENT_IDENTITY_CHANGED");
    const oldIds = collectIds(before);
    const nextIds = collectIds(after);
    this.doc.transact(() => {
      for (const id of oldIds.keys())
        if (!nextIds.has(id)) this.deleted.set(id, true);
      this.patchObject(this.root, before, after, "document");
      recordCommentPositions(this.commentPositions, before, after, (id) =>
        this.getRichFragment(id, "children"),
      );
    }, origin);
  }

  /** Validate in isolation: a Yjs transaction cannot roll back a rejected binary update. */
  prepareUpdate(
    update: Uint8Array,
    validate: (document: ObjectValue) => void,
  ): SharedDocument {
    if (update.byteLength > MAX_UPDATE_BYTES) throw new Error("PAYLOAD_LIMIT");
    const candidate = new SharedDocument(this.snapshot());
    try {
      Y.applyUpdate(candidate.doc, update, REMOTE_ORIGIN);
      if (!sameValue(this.identity(), candidate.identity()))
        throw new Error("DOCUMENT_IDENTITY_CHANGED");
      if (candidate.snapshot().byteLength > MAX_DOCUMENT_BYTES)
        throw new Error("DOCUMENT_LIMIT");
      const next = candidate.project();
      const current = this.project();
      if (next.docId !== current.docId || next.version !== current.version)
        throw new Error("DOCUMENT_IDENTITY_CHANGED");
      validate(next);
      return candidate;
    } catch (error) {
      candidate.destroy();
      throw error;
    }
  }

  applyUpdate(update: Uint8Array, origin: unknown = REMOTE_ORIGIN): void {
    Y.applyUpdate(this.doc, update, origin);
  }

  createUndoManager(
    origins: Set<unknown> = new Set([LOCAL_ORIGIN]),
  ): Y.UndoManager {
    return new Y.UndoManager(
      [
        this.root,
        this.entities,
        this.placements,
        this.deleted,
        this.commentPositions,
      ],
      {
        trackedOrigins: origins,
        captureTimeout: 500,
      },
    );
  }

  getRichFragment(entityId: string, field: string): Y.XmlFragment | undefined {
    const value = this.entities.get(entityId)?.get(field);
    return value instanceof Y.XmlFragment ? value : undefined;
  }

  private patchObject(
    target: Y.Map<Stored>,
    before: ObjectValue,
    after: ObjectValue,
    path: string,
  ): void {
    const isShape =
      typeof after.type === "string" &&
      typeof after.x === "number" &&
      typeof after.y === "number" &&
      isObject(after.props);
    if (isShape) {
      const previous = Object.fromEntries(
        TRANSFORM_FIELDS.filter((key) => key in before).map((key) => [
          key,
          before[key],
        ]),
      );
      const next = Object.fromEntries(
        TRANSFORM_FIELDS.filter((key) => key in after).map((key) => [
          key,
          after[key],
        ]),
      );
      previous.dimensions = Object.fromEntries(
        DIMENSION_FIELDS.filter(
          (key) => isObject(before.props) && key in before.props,
        ).map((key) => [key, (before.props as ObjectValue)[key]]),
      );
      next.dimensions = Object.fromEntries(
        DIMENSION_FIELDS.filter(
          (key) => key in (after.props as ObjectValue),
        ).map((key) => [key, (after.props as ObjectValue)[key]]),
      );
      if (!sameValue(previous, next)) target.set(TRANSFORM, next);
    }
    for (const key of Object.keys(before))
      if (!(key in after)) target.delete(key);
    for (const [key, value] of Object.entries(after)) {
      if (isShape && (TRANSFORM_FIELDS as readonly string[]).includes(key))
        continue;
      // Keep initial timestamps for interchange; persistence never churns content timestamps.
      if (path === "document" && key === "updatedAt" && target.has(key))
        continue;
      if (sameValue(before[key], value) && target.has(key)) continue;
      const childPath = `${path}/${encodeURIComponent(key)}`;
      const previous = before[key];
      const current = target.get(key);
      if (
        (isObject(value) &&
          typeof value.x === "number" &&
          typeof value.y === "number" &&
          !value.id) ||
        (["points", "controlPoints"].includes(key) && Array.isArray(value))
      ) {
        target.set(key, structuredClone(value));
      } else if (
        isInlineContent(value) ||
        (Array.isArray(value) &&
          (current instanceof Y.XmlFragment ||
            (key === "children" &&
              value.length === 0 &&
              ["paragraph", "heading", "listItem"].includes(
                String(after.type),
              ))))
      ) {
        if (current instanceof Y.XmlFragment)
          patchRichFragment(current, value as ObjectValue[]);
        else target.set(key, createRichFragment(value as ObjectValue[]));
      } else if (Array.isArray(value)) {
        const array =
          current instanceof Y.Array ? current : new Y.Array<Stored>();
        if (array !== current) target.set(key, array);
        this.patchArray(
          array,
          Array.isArray(previous) ? previous : [],
          value,
          childPath,
        );
      } else if (isObject(value)) {
        if (typeof value.id === "string") {
          target.set(key, { [REF]: value.id });
          this.patchEntity(value, isObject(previous) ? previous : {});
        } else {
          const map = current instanceof Y.Map ? current : new Y.Map<Stored>();
          if (map !== current) target.set(key, map);
          const withoutDimensions = (object: ObjectValue) =>
            Object.fromEntries(
              Object.entries(object).filter(
                ([field]) => !DIMENSION_FIELDS.includes(field),
              ),
            );
          this.patchObject(
            map,
            isShape && key === "props"
              ? withoutDimensions(isObject(previous) ? previous : {})
              : isObject(previous)
                ? previous
                : {},
            isShape && key === "props" ? withoutDimensions(value) : value,
            childPath,
          );
        }
      } else target.set(key, value);
    }
  }

  private patchEntity(value: ObjectValue, previous: ObjectValue): void {
    const id = String(value.id);
    if (this.deleted.get(id)) return; // Delayed edits cannot resurrect a deleted entity.
    let entity = this.entities.get(id);
    if (!entity) {
      entity = new Y.Map<Stored>();
      this.entities.set(id, entity);
    }
    this.patchObject(
      entity,
      previous,
      value,
      `entity:${encodeURIComponent(id)}`,
    );
  }

  private activeEntries(array: Y.Array<Stored>, path: string): Entry[] {
    const placements = this.projectingPlacements ?? this.effectivePlacements();
    return array.toArray().filter((value): value is Entry => {
      if (
        !isObject(value) ||
        typeof value.id !== "string" ||
        typeof value.token !== "string"
      )
        return false;
      const chosen = placements.get(value.id);
      return (
        !this.deleted.get(value.id) &&
        chosen?.list === path &&
        chosen.token === value.token
      );
    });
  }

  /** Concurrent reparenting can form A→B→A. Resolve the same edge on every
   * replica to its retained earlier placement; never create ids during repair.
   */
  private effectivePlacements(): Map<string, Placement> {
    const selected = new Map(this.placements.entries());
    const parent = (placement: Placement | undefined): string | undefined => {
      const match = placement && /^entity:([^/]+)\//.exec(placement.list);
      return match ? decodeURIComponent(match[1]) : undefined;
    };
    let candidates: Placement[] | undefined;
    const history = (): Placement[] => {
      if (candidates) return candidates;
      candidates = [];
      const visit = (value: Stored, path: string): void => {
        if (value instanceof Y.Map)
          for (const [key, child] of value.entries())
            visit(child, `${path}/${encodeURIComponent(key)}`);
        else if (value instanceof Y.Array)
          value.toArray().forEach((item, index) => {
            if (
              isObject(item) &&
              typeof item.id === "string" &&
              typeof item.token === "string"
            )
              candidates!.push({ id: item.id, token: item.token, list: path });
            else visit(item, `${path}/${index}`);
          });
      };
      visit(this.root, "document");
      for (const [id, entity] of this.entities)
        visit(entity, `entity:${encodeURIComponent(id)}`);
      return candidates;
    };
    for (const id of [...selected.keys()].sort()) {
      const chain: string[] = [];
      let current: string | undefined = id;
      while (current && selected.has(current)) {
        const index = chain.indexOf(current);
        if (index >= 0) {
          const cycle = chain.slice(index);
          const repaired = [...cycle].sort()[0];
          const alternatives = history()
            .filter(
              (entry) =>
                entry.id === repaired && !cycle.includes(parent(entry) ?? ""),
            )
            .sort(
              (a, b) =>
                a.list.localeCompare(b.list) || a.token.localeCompare(b.token),
            );
          if (alternatives[0]) selected.set(repaired, alternatives[0]);
          else selected.delete(repaired);
          break;
        }
        chain.push(current);
        current = parent(selected.get(current));
      }
    }
    return selected;
  }

  private patchArray(
    target: Y.Array<Stored>,
    before: Value[],
    after: Value[],
    path: string,
  ): void {
    if (
      (after.length > 0 &&
        after.every((item) => isObject(item) && typeof item.id === "string")) ||
      (before.length > 0 &&
        before.every((item) => isObject(item) && typeof item.id === "string"))
    ) {
      const old = new Map(
        before.filter(isObject).map((item) => [item.id, item]),
      );
      after.forEach((item, index) => {
        if (!isObject(item) || typeof item.id !== "string")
          throw new Error("INVALID_ENTITY_LIST");
        if (sameValue(before[index], item)) return;
        if (this.deleted.get(item.id)) return;
        this.patchEntity(item, old.get(item.id) ?? {});
        const active = this.activeEntries(target, path);
        if (active[index]?.id === item.id) return;
        const entry = { id: item.id, token: crypto.randomUUID() };
        const next = active[index];
        const offset = next
          ? target
              .toArray()
              .findIndex(
                (value) => isObject(value) && value.token === next.token,
              )
          : target.length;
        target.insert(offset, [entry]);
        this.placements.set(item.id, { ...entry, list: path });
      });
      return;
    }
    // Anonymous arrays (table rows/cells, coordinate vectors) retain individual shared values.
    let start = 0;
    while (
      start < before.length &&
      start < after.length &&
      sameValue(before[start], after[start])
    )
      start++;
    if (before.length === after.length) {
      for (let index = start; index < after.length; index++) {
        if (sameValue(before[index], after[index])) continue;
        const current = target.get(index);
        if (current instanceof Y.XmlFragment && Array.isArray(after[index])) {
          patchRichFragment(current, after[index] as ObjectValue[]);
        } else if (
          current instanceof Y.Map &&
          isObject(after[index]) &&
          isObject(before[index])
        ) {
          this.patchObject(
            current,
            before[index] as ObjectValue,
            after[index] as ObjectValue,
            `${path}/${index}`,
          );
        } else if (
          current instanceof Y.Array &&
          Array.isArray(after[index]) &&
          Array.isArray(before[index])
        ) {
          this.patchArray(
            current,
            before[index] as Value[],
            after[index] as Value[],
            `${path}/${index}`,
          );
        } else {
          if (index < target.length) target.delete(index, 1);
          target.insert(Math.min(index, target.length), [
            this.createStored(after[index], `${path}/${index}`),
          ]);
        }
      }
      return;
    }
    let suffix = 0;
    while (
      suffix < before.length - start &&
      suffix < after.length - start &&
      sameValue(
        before[before.length - 1 - suffix],
        after[after.length - 1 - suffix],
      )
    )
      suffix++;
    const removed = Math.min(
      before.length - start - suffix,
      Math.max(0, target.length - start),
    );
    if (removed) target.delete(start, removed);
    const inserted = after
      .slice(start, after.length - suffix)
      .map((item, i) => this.createStored(item, `${path}/${start + i}`));
    if (inserted.length)
      target.insert(Math.min(start, target.length), inserted);
  }

  private createStored(value: Value, path: string): Stored {
    if (isInlineContent(value)) return createRichFragment(value);
    // Preliminary shared types may be populated before insertion, but never read before integration.
    if (isObject(value)) {
      if (typeof value.id === "string") {
        this.patchEntity(value, {});
        return { [REF]: value.id };
      }
      const map = new Y.Map<Stored>();
      for (const [key, child] of Object.entries(value))
        map.set(
          key,
          this.createStored(child, `${path}/${encodeURIComponent(key)}`),
        );
      return map;
    }
    if (Array.isArray(value)) {
      const array = new Y.Array<Stored>();
      array.insert(
        0,
        value.map((child, index) =>
          this.createStored(child, `${path}/${index}`),
        ),
      );
      return array;
    }
    return value;
  }

  private readObject(
    map: Y.Map<Stored>,
    path: string,
    ancestors: Set<string>,
  ): ObjectValue {
    const result: ObjectValue = {};
    let dimensions: ObjectValue | undefined;
    for (const [key, value] of map.entries()) {
      if (key === TRANSFORM && isObject(value)) {
        const { dimensions: storedDimensions, ...position } = value;
        Object.assign(result, position);
        dimensions = isObject(storedDimensions) ? storedDimensions : undefined;
        continue;
      }
      const projected = this.readValue(
        value,
        `${path}/${encodeURIComponent(key)}`,
        ancestors,
      );
      if (projected !== undefined) result[key] = projected;
    }
    if (dimensions)
      result.props = {
        ...(isObject(result.props) ? result.props : {}),
        ...dimensions,
      };
    return result;
  }

  private readEntity(
    id: string,
    ancestors: Set<string>,
  ): ObjectValue | undefined {
    if (this.deleted.get(id)) return undefined;
    if (ancestors.has(id)) throw new Error("CYCLIC_DOCUMENT");
    const entity = this.entities.get(id);
    if (!entity) throw new Error("MISSING_ENTITY");
    return this.readObject(
      entity,
      `entity:${encodeURIComponent(id)}`,
      new Set([...ancestors, id]),
    );
  }

  private readValue(
    value: Stored,
    path: string,
    ancestors: Set<string>,
  ): Value | undefined {
    if (value instanceof Y.XmlFragment) return readRichFragment(value);
    if (value instanceof Y.Map) return this.readObject(value, path, ancestors);
    if (value instanceof Y.Array) {
      const items = value.toArray();
      if (
        items.some(
          (item) =>
            isObject(item) &&
            typeof item.token === "string" &&
            typeof item.id === "string",
        )
      ) {
        return this.activeEntries(value, path).flatMap((entry) => {
          const entity = this.readEntity(entry.id, ancestors);
          return entity ? [entity] : [];
        });
      }
      return items.flatMap((item, index) => {
        const child = this.readValue(item, `${path}/${index}`, ancestors);
        return child === undefined ? [] : [child];
      });
    }
    if (isObject(value) && typeof value[REF] === "string")
      return this.readEntity(value[REF], ancestors);
    return value;
  }
}

export function collectIds(
  value: Value,
  result = new Map<string, ObjectValue>(),
): Map<string, ObjectValue> {
  if (Array.isArray(value)) value.forEach((child) => collectIds(child, result));
  else if (isObject(value)) {
    if (typeof value.id === "string") result.set(value.id, value);
    Object.values(value).forEach((child) => collectIds(child, result));
  }
  return result;
}

function assertUniqueIds(value: Value): void {
  const seen = new Set<string>();
  const visit = (child: Value): void => {
    if (Array.isArray(child)) child.forEach(visit);
    else if (isObject(child)) {
      if (typeof child.id === "string") {
        if (seen.has(child.id)) throw new Error("DUPLICATE_ID");
        seen.add(child.id);
      }
      Object.values(child).forEach(visit);
    }
  };
  visit(value);
}
