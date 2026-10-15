// ============================================================
// handlers.test.mjs - ハンドラのユニットテスト（deps 全モック）
// ------------------------------------------------------------
// jev 上限で未呼び出し / jev 失敗で refund(todayKey) / 成功で
// counters 返却 / 翻訳上限で translateText 未呼び出し /
// 翻訳失敗で refund("TR#"+todayKey) を検証する。
// ============================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { handleBox, handleTranslate } from "./handlers.mjs";
import { tokyoDayKey } from "./tokyo-day.mjs";

// 100文字超の妥当な base64
const VALID_B64 = "A".repeat(200);
// 固定時刻（東京日キーを安定させる）
const FIXED = new Date("2025-05-20T03:00:00Z");
const TODAY = tokyoDayKey(FIXED);

const baseConfig = {
  DAILY_LIMIT: 100,
  TRANSLATE_DAILY_LIMIT: 100,
  JEV_ENDPOINT: "https://example.test/jev",
  JEV_MODEL: "jev-1.14.0",
  BEDROCK_MODEL: "amazon.nova-lite-v1:0",
};

// 呼び出し記録を取れるスパンを作る補助
function spy(fn) {
  const calls = [];
  const wrapped = (...args) => {
    calls.push(args);
    return fn(...args);
  };
  wrapped.calls = calls;
  return wrapped;
}

test("handleBox: 成功で 200・counters 返却", async () => {
  const store = {
    tryConsume: spy(async () => ({ allowed: true, today: 1, total: 1 })),
    refund: spy(async () => {}),
  };
  const callJevBox = spy(async () => ({
    response: { answers: { target: { box: {} } } },
    requestForLog: { model: "jev-1.14.0" },
  }));
  const deps = {
    store,
    rateLimiter: { check: () => ({ allowed: true }) },
    getApiKey: async () => "KEY",
    callJevBox,
    now: () => FIXED,
    config: baseConfig,
  };

  const r = await handleBox({
    bodyJson: { instructions: "数字", imageBase64: VALID_B64 },
    clientIp: "1.2.3.4",
    deps,
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.counters, { today: 1, total: 1, limit: 100 });
  assert.equal(store.tryConsume.calls[0][0], TODAY); // 本日キーで消費
  assert.equal(store.tryConsume.calls[0][1], 100); // limit は呼び出し側から
  assert.equal(callJevBox.calls.length, 1);
  assert.equal(store.refund.calls.length, 0);
});

test("handleBox: 日次上限で jev 未呼び出し・429", async () => {
  const callJevBox = spy(async () => ({ response: {}, requestForLog: {} }));
  const store = {
    tryConsume: async () => ({ allowed: false, today: 100, total: 123 }),
    refund: spy(async () => {}),
  };
  const deps = {
    store,
    rateLimiter: { check: () => ({ allowed: true }) },
    getApiKey: async () => "KEY",
    callJevBox,
    now: () => FIXED,
    config: baseConfig,
  };
  const r = await handleBox({
    bodyJson: { instructions: "x", imageBase64: VALID_B64 },
    clientIp: "ip",
    deps,
  });
  assert.equal(r.status, 429);
  assert.equal(r.json.reason, "daily_limit");
  assert.equal(r.json.limit, 100);
  assert.deepEqual(r.json.counters, { today: 100, total: 123 });
  assert.equal(callJevBox.calls.length, 0); // jev を呼ばない
});

test("handleBox: jev 失敗で refund(todayKey)・502", async () => {
  const store = {
    tryConsume: async () => ({ allowed: true, today: 1, total: 1 }),
    refund: spy(async () => {}),
  };
  const deps = {
    store,
    rateLimiter: { check: () => ({ allowed: true }) },
    getApiKey: async () => "KEY",
    callJevBox: async () => {
      throw new Error("jev ダウン");
    },
    now: () => FIXED,
    config: baseConfig,
  };
  const r = await handleBox({
    bodyJson: { instructions: "x", imageBase64: VALID_B64 },
    clientIp: "ip",
    deps,
  });
  assert.equal(r.status, 502);
  assert.equal(store.refund.calls.length, 1);
  assert.equal(store.refund.calls[0][0], TODAY); // 本日キーで返金
});

test("handleBox: バリデーション NG で 400・store 未呼び出し", async () => {
  const store = { tryConsume: spy(async () => ({})), refund: spy(async () => {}) };
  const deps = {
    store,
    rateLimiter: { check: () => ({ allowed: true }) },
    getApiKey: async () => "KEY",
    callJevBox: async () => ({}),
    now: () => FIXED,
    config: baseConfig,
  };
  const r = await handleBox({ bodyJson: { imageBase64: VALID_B64 }, clientIp: "ip", deps });
  assert.equal(r.status, 400);
  assert.equal(store.tryConsume.calls.length, 0);
});

test("handleBox: レートリミット超過で 429 reason:rate", async () => {
  const store = { tryConsume: spy(async () => ({})), refund: spy(async () => {}) };
  const deps = {
    store,
    rateLimiter: { check: () => ({ allowed: false }) },
    getApiKey: async () => "KEY",
    callJevBox: async () => ({}),
    now: () => FIXED,
    config: baseConfig,
  };
  const r = await handleBox({
    bodyJson: { instructions: "x", imageBase64: VALID_B64 },
    clientIp: "ip",
    deps,
  });
  assert.equal(r.status, 429);
  assert.equal(r.json.reason, "rate");
  assert.equal(store.tryConsume.calls.length, 0);
});

test("handleTranslate: 成功で 200（counters なし）", async () => {
  const store = {
    tryConsume: spy(async () => ({ allowed: true, today: 1, total: null })),
    refund: spy(async () => {}),
  };
  const deps = {
    store,
    rateLimiter: { check: () => ({ allowed: true }) },
    translateText: async (t) => ({
      source: t,
      translated: "number",
      direction: "ja->en",
      model: "nova",
    }),
    now: () => FIXED,
    config: baseConfig,
  };
  const r = await handleTranslate({ bodyJson: { text: "数字" }, clientIp: "ip", deps });
  assert.equal(r.status, 200);
  assert.equal(r.json.translated, "number");
  assert.equal(r.json.counters, undefined); // 翻訳応答に counters は含めない
  assert.equal(store.tryConsume.calls[0][0], "TR#" + TODAY); // 翻訳名前空間
});

test("handleTranslate: 翻訳上限で translateText 未呼び出し・429", async () => {
  const translateText = spy(async () => ({ translated: "x" }));
  const store = {
    tryConsume: async () => ({ allowed: false, today: 100, total: null }),
    refund: spy(async () => {}),
  };
  const deps = {
    store,
    rateLimiter: { check: () => ({ allowed: true }) },
    translateText,
    now: () => FIXED,
    config: baseConfig,
  };
  const r = await handleTranslate({ bodyJson: { text: "x" }, clientIp: "ip", deps });
  assert.equal(r.status, 429);
  assert.equal(r.json.reason, "translate_daily_limit");
  assert.equal(translateText.calls.length, 0);
});

test("handleTranslate: 翻訳失敗で refund('TR#'+todayKey)・502", async () => {
  const store = {
    tryConsume: async () => ({ allowed: true, today: 1, total: null }),
    refund: spy(async () => {}),
  };
  const deps = {
    store,
    rateLimiter: { check: () => ({ allowed: true }) },
    translateText: async () => {
      throw new Error("Bedrock ダウン");
    },
    now: () => FIXED,
    config: baseConfig,
  };
  const r = await handleTranslate({ bodyJson: { text: "x" }, clientIp: "ip", deps });
  assert.equal(r.status, 502);
  assert.equal(store.refund.calls.length, 1);
  assert.equal(store.refund.calls[0][0], "TR#" + TODAY);
});
