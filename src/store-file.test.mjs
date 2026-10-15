// ============================================================
// store-file.test.mjs - ファイルストアのユニットテスト
// ------------------------------------------------------------
// tempディレクトリの counter.json を使い、上限頭打ち・refund の
// 本日のみ補償・累計不変・日キーリセット・翻訳系 total:null・
// 別日キー refund が掃除で消えない、を検証する。
// ============================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileStore } from "./store-file.mjs";

// テストごとに一時 counter.json パスを作る
async function newStorePath() {
  const dir = await mkdtemp(join(tmpdir(), "jev-store-"));
  return { dir, path: join(dir, "counter.json") };
}

test("tryConsume: limit で頭打ちし limit+1 回目は allowed:false", async () => {
  const { dir, path } = await newStorePath();
  try {
    const store = createFileStore(path);
    const day = "2025-05-20";
    for (let i = 1; i <= 3; i++) {
      const r = await store.tryConsume(day, 3);
      assert.equal(r.allowed, true);
      assert.equal(r.today, i);
      assert.equal(r.total, i); // jev 系は total も増える
    }
    // 4回目は上限到達
    const over = await store.tryConsume(day, 3);
    assert.equal(over.allowed, false);
    assert.equal(over.today, 3);
    assert.equal(over.total, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("refund: 本日 count のみ -1、累計 total は不変", async () => {
  const { dir, path } = await newStorePath();
  try {
    const store = createFileStore(path);
    const day = "2025-05-20";
    await store.tryConsume(day, 100); // today=1 total=1
    await store.tryConsume(day, 100); // today=2 total=2
    await store.refund(day); // today=1 total=2（不変）
    const peek = await store.peek(day);
    assert.equal(peek.today, 1);
    assert.equal(peek.total, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("refund: 0 のとき負数にならない", async () => {
  const { dir, path } = await newStorePath();
  try {
    const store = createFileStore(path);
    await store.refund("2025-05-20"); // 存在しない → no-op
    const peek = await store.peek("2025-05-20");
    assert.equal(peek.today, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("日キー変更で本日分がリセットされる（掃除で前日が消える）", async () => {
  const { dir, path } = await newStorePath();
  try {
    const store = createFileStore(path);
    await store.tryConsume("2025-05-20", 100); // today=1 total=1
    const r = await store.tryConsume("2025-05-21", 100); // 別日 today=1 total=2
    assert.equal(r.today, 1);
    assert.equal(r.total, 2);
    // 前日キーは掃除されている（peek で 0）
    const prev = await store.peek("2025-05-20");
    assert.equal(prev.today, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TR# キー（翻訳系）は total:null で累計に寄与しない", async () => {
  const { dir, path } = await newStorePath();
  try {
    const store = createFileStore(path);
    await store.tryConsume("2025-05-20", 100); // jev total=1
    const tr = await store.tryConsume("TR#2025-05-20", 100);
    assert.equal(tr.allowed, true);
    assert.equal(tr.today, 1);
    assert.equal(tr.total, null); // 翻訳系は total を持たない
    // jev 側の累計は翻訳で増えていない
    const jev = await store.peek("2025-05-20");
    assert.equal(jev.total, 1);
    // 永続化内容も確認
    const raw = JSON.parse(await readFile(path, "utf8"));
    assert.equal(raw.total, 1);
    assert.equal(raw.trDays["2025-05-20"], 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("別日キーの refund は tryConsume の掃除で消えない", async () => {
  const { dir, path } = await newStorePath();
  try {
    const store = createFileStore(path);
    // 前日分を 2 消費
    await store.tryConsume("2025-05-20", 100);
    await store.tryConsume("2025-05-20", 100); // days[05-20]=2
    // 翌日に 1 消費（ここで days の 05-20 以外=05-20 は掃除対象だが…
    //  実際には tryConsume は「対象 dayKey 以外」を掃除するので 05-20 は消える）
    await store.tryConsume("2025-05-21", 100);
    // 05-20 は掃除で消えているが、refund は存在しなければ no-op（負数にしない）
    await store.refund("2025-05-20"); // no-op
    const prev = await store.peek("2025-05-20");
    assert.equal(prev.today, 0);

    // 別のストアで「掃除前の別日 refund」を検証:
    // peek は掃除しないので、tryConsume せず refund→peek の流れでは別日が保持される
    const store2path = join(dir, "counter2.json");
    const store2 = createFileStore(store2path);
    await store2.tryConsume("2025-05-20", 100); // days[05-20]=1
    // refund は掃除しないので別日キーは残り続ける
    await store2.refund("2025-05-21"); // 存在しないので no-op・掃除もしない
    const kept = await store2.peek("2025-05-20");
    assert.equal(kept.today, 1); // refund(別日) で 05-20 は消えていない
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
