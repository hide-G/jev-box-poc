// ============================================================
// counter.mjs - IP レートリミッタ（環境非依存・メモリ上）
// ------------------------------------------------------------
// 固定ウィンドウカウンタで「数 req/分」の軽い制限をかける。
//   Map<ip, { windowStart, count }>
// ローカルは単一プロセスなので正確に効く。
// Lambda はインスタンスごとにメモリが別なので best-effort。
// ============================================================

// ------------------------------------------------------------
// 固定ウィンドウ IP レートリミッタを生成する。
//   max      : ウィンドウ内の最大リクエスト数（既定 10）
//   windowMs : ウィンドウ幅ミリ秒（既定 60000）
//   now      : 現在時刻を返す関数（テスト時に差し替え可能）
// check(ip) -> { allowed:boolean }
// ------------------------------------------------------------
export function createRateLimiter({ max = 10, windowMs = 60000, now = () => Date.now() } = {}) {
  const buckets = new Map();

  return {
    check(ip) {
      const t = now();
      const key = ip || "unknown";
      const b = buckets.get(key);

      // ウィンドウが無い or 期限切れなら新しいウィンドウを開始する
      if (!b || t - b.windowStart >= windowMs) {
        buckets.set(key, { windowStart: t, count: 1 });
        return { allowed: true };
      }

      // 同一ウィンドウ内: 上限に達していれば拒否
      if (b.count >= max) {
        return { allowed: false };
      }

      b.count += 1;
      return { allowed: true };
    },
  };
}
