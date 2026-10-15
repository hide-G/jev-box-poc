// ============================================================
// tokyo-day.mjs - Asia/Tokyo 日境界と日キー算出（環境非依存）
// ------------------------------------------------------------
// 外部ライブラリを使わず Intl.DateTimeFormat で算出する。
// 日キー(YYYY-MM-DD, 東京基準)が変わることで「本日分リセット」を
// 自然に表現する（明示的なリセット処理は持たない）。
// ============================================================

// ------------------------------------------------------------
// 与えられた時刻の「東京日付」を YYYY-MM-DD で返す。
// en-CA ロケールは YYYY-MM-DD 並びになる性質を利用する。
// ------------------------------------------------------------
export function tokyoDayKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const map = {};
  for (const p of parts) map[p.type] = p.value;
  // "2025-05-20" の形で返す
  return `${map.year}-${map.month}-${map.day}`;
}

// ------------------------------------------------------------
// 次の東京深夜(00:00 JST)までの残りミリ秒を返す。
// ローカルのリセットタイマや DynamoDB の TTL 算出に利用できる。
// ------------------------------------------------------------
export function msUntilNextTokyoMidnight(date = new Date()) {
  // 東京の現在時刻（時・分・秒・ミリ秒）を取得する
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const map = {};
  for (const p of parts) map[p.type] = p.value;
  // en-GB の 24時間表記で "24" が返るケース（深夜0時）を 0 に正規化する
  const h = Number(map.hour) % 24;
  const m = Number(map.minute);
  const s = Number(map.second);
  const ms = date.getMilliseconds();

  // 現在の東京時刻を「本日経過ミリ秒」に換算し、1日(86,400,000ms)との差を取る
  const elapsed = ((h * 60 + m) * 60 + s) * 1000 + ms;
  const dayMs = 24 * 60 * 60 * 1000;
  return dayMs - elapsed;
}
