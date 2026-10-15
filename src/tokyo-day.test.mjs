// ============================================================
// tokyo-day.test.mjs - 東京日キー / 日境界のユニットテスト
// ============================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { tokyoDayKey, msUntilNextTokyoMidnight } from "./tokyo-day.mjs";

test("固定 UTC 時刻から東京日キーを YYYY-MM-DD で返す", () => {
  // 2025-05-20 00:00 UTC は東京で 09:00（同日）
  const d = new Date("2025-05-20T00:00:00Z");
  assert.equal(tokyoDayKey(d), "2025-05-20");
});

test("23:59 JST と 00:01 JST は別の日キーになる", () => {
  // 2025-05-20 23:59 JST = 2025-05-20 14:59 UTC
  const before = new Date("2025-05-20T14:59:00Z");
  // 2025-05-21 00:01 JST = 2025-05-20 15:01 UTC
  const after = new Date("2025-05-20T15:01:00Z");
  assert.equal(tokyoDayKey(before), "2025-05-20");
  assert.equal(tokyoDayKey(after), "2025-05-21");
});

test("UTC 深夜前後で東京日は翌日になる", () => {
  // 2025-12-31 20:00 UTC = 2026-01-01 05:00 JST
  const d = new Date("2025-12-31T20:00:00Z");
  assert.equal(tokyoDayKey(d), "2026-01-01");
});

test("msUntilNextTokyoMidnight は 0 より大きく 1 日以内", () => {
  const d = new Date("2025-05-20T14:59:00Z"); // 23:59 JST
  const ms = msUntilNextTokyoMidnight(d);
  assert.ok(ms > 0);
  assert.ok(ms <= 24 * 60 * 60 * 1000);
  // 23:59 JST なら残りはおよそ 60 秒程度（60,000ms 前後）
  assert.ok(ms <= 61 * 1000);
});
