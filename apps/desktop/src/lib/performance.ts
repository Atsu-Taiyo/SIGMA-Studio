type PerformanceBucket = {
  counters: Record<string, number>;
  measures: Array<{ name: string; duration: number; at: number }>;
  /**
   * 本番ビルドかどうか。
   *
   * 計測が有効なだけでは「本番ビルドを測った」証明にならない: development ビルドは
   * 常に計測が有効なので、`next dev` を相手にしても計測の有無だけでは見分けが付かない。
   * React の development ビルドは打鍵コストが数倍に膨らむため、その数字で予算を判定すると
   * 意味が逆転する。ここに焼いておけば probe 側で弾ける。
   */
  productionBuild: boolean;
};

declare global {
  interface Window {
    __SIGMA_STUDIO_PERFORMANCE__?: PerformanceBucket;
  }
}

const MAX_MEASURE_ENTRIES = 2000;
// Enabled in development, or in any build when NEXT_PUBLIC_SIGMA_PERF=1 (so production
// builds can be profiled on demand without shipping the overhead by default).
const PERFORMANCE_ENABLED =
  process.env.NODE_ENV !== "production" || process.env.NEXT_PUBLIC_SIGMA_PERF === "1";

function getBucket(): PerformanceBucket | null {
  if (!PERFORMANCE_ENABLED || typeof window === "undefined") {
    return null;
  }

  window.__SIGMA_STUDIO_PERFORMANCE__ ??= {
    counters: {},
    measures: [],
    productionBuild: process.env.NODE_ENV === "production",
  };
  return window.__SIGMA_STUDIO_PERFORMANCE__;
}

export function countPerformanceEvent(name: string): void {
  const bucket = getBucket();
  if (!bucket) {
    return;
  }

  bucket.counters[name] = (bucket.counters[name] ?? 0) + 1;
}

export function measurePerformance<T>(name: string, task: () => T): T {
  if (!PERFORMANCE_ENABLED || typeof performance === "undefined") {
    return task();
  }

  const start = performance.now();
  try {
    return task();
  } finally {
    const duration = performance.now() - start;
    const bucket = getBucket();
    if (bucket) {
      bucket.measures.push({ name, duration, at: Date.now() });
      if (bucket.measures.length > MAX_MEASURE_ENTRIES) {
        bucket.measures.splice(0, bucket.measures.length - MAX_MEASURE_ENTRIES);
      }
    }
  }
}
