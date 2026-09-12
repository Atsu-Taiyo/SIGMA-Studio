import { describe, expect, it } from "vitest";

import { createSettlingMeasureScheduler } from "./settling-measure-scheduler";

function createFrameQueue() {
  const callbacks = new Map<number, () => void>();
  let nextId = 1;
  return {
    request: (callback: () => void) => {
      const id = nextId;
      nextId += 1;
      callbacks.set(id, callback);
      return id;
    },
    cancel: (id: number) => {
      callbacks.delete(id);
    },
    flush: () => {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) {
        callback();
      }
    },
    get pending() {
      return callbacks.size;
    },
  };
}

describe("createSettlingMeasureScheduler", () => {
  it("collapses several requests in the same frame into one measurement", () => {
    const frames = createFrameQueue();
    let measured = 0;
    const scheduler = createSettlingMeasureScheduler(() => { measured += 1; }, frames);

    scheduler.refresh();
    scheduler.refresh();
    frames.flush();

    expect(measured).toBe(1);
  });

  it("runs one more pass when the measurement says it owes one", () => {
    // 枠は「1 パス目の装飾が入った DOM」からしか読めないので 2 パス必要になる。2 パス目を
    // 呼べる合図 (自分の dispatch と、それによる DOM 変化) は必ず計測窓の内側に着くため、
    // 計測自身に申告させないと 2 パス目が永久に来ない (実測: 囲み枠が一切描かれなくなる)。
    const frames = createFrameQueue();
    let measured = 0;
    const scheduler = createSettlingMeasureScheduler(() => {
      measured += 1;
      return measured === 1;
    }, frames);

    scheduler.refresh();
    frames.flush();
    expect(measured).toBe(1);

    frames.flush();
    frames.flush();
    frames.flush();
    expect(measured).toBe(2);

    for (let index = 0; index < 4; index += 1) {
      frames.flush();
    }
    expect(measured).toBe(2);
  });

  it("drops requests that arrive while measuring so a measurement cannot chase itself", () => {
    // 計測が自分で起こした DOM 変化を新しい依頼として取り込み続けると 60Hz で回り続ける。
    // 外から来た依頼も次の更新で拾い直せるので、窓の内側は落として構わない。
    const frames = createFrameQueue();
    let measured = 0;
    const scheduler = createSettlingMeasureScheduler(() => {
      measured += 1;
      scheduler.refresh();
    }, frames);

    scheduler.refresh();
    for (let index = 0; index < 8; index += 1) {
      frames.flush();
    }

    expect(measured).toBe(1);
  });

  it("caps the self-driven passes so a never-satisfied measurement cannot run forever", () => {
    // 「もう 1 パス要る」が永久に true のままになる DOM (解決できない入れ物など) があっても、
    // 外から何も起きていないのに 3 フレームごとの強制レイアウトが回り続けてはいけない。
    const frames = createFrameQueue();
    let measured = 0;
    const scheduler = createSettlingMeasureScheduler(() => {
      measured += 1;
      return true;
    }, frames);

    scheduler.refresh();
    for (let index = 0; index < 20; index += 1) {
      frames.flush();
    }
    expect(measured).toBe(2);

    // 外からの依頼が来れば、また 1 回だけ追いパスを許す。
    scheduler.refresh();
    for (let index = 0; index < 20; index += 1) {
      frames.flush();
    }
    expect(measured).toBe(4);
  });

  it("stops once nothing asks for another measurement", () => {
    const frames = createFrameQueue();
    let measured = 0;
    const scheduler = createSettlingMeasureScheduler(() => { measured += 1; }, frames);

    scheduler.refresh();
    for (let index = 0; index < 6; index += 1) {
      frames.flush();
    }

    expect(measured).toBe(1);
    expect(frames.pending).toBe(0);
  });

  it("cancels its frames on destroy and stays inert afterwards", () => {
    const frames = createFrameQueue();
    let measured = 0;
    const scheduler = createSettlingMeasureScheduler(() => { measured += 1; }, frames);

    scheduler.refresh();
    scheduler.destroy();
    frames.flush();

    expect(measured).toBe(0);
    expect(frames.pending).toBe(0);

    scheduler.refresh();
    frames.flush();
    expect(measured).toBe(0);
  });
});
