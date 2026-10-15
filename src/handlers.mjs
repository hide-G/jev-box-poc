// ============================================================
// handlers.mjs - /api/box と /api/translate の中核ハンドラ
// ------------------------------------------------------------
// HTTP フレームワーク非依存の「プレーンな入出力」で実装する。
// ローカルの Node http も Lambda Function URL も、
// { bodyJson, clientIp, deps } に正規化してから呼ぶ。
// 戻り値はすべて { status, json } に正規化する。
//
// deps（依存性注入）:
//   store         CounterStore 実装（file or dynamo）
//   getApiKey     () => Promise<string>
//   callJevBox    (apiKey, instructions, imageBase64, format) => { response, requestForLog }
//   translateText (text) => { source, translated, direction, model }
//   rateLimiter   { check(ip) -> { allowed } }
//   now           () => Date（テスト時に差し替え可能）
//   config        DAILY_LIMIT / TRANSLATE_DAILY_LIMIT / JEV_ENDPOINT / JEV_MODEL など
// ============================================================

import { validateBoxInput, validateTranslateInput } from "./validate.mjs";
import { tokyoDayKey } from "./tokyo-day.mjs";

// ------------------------------------------------------------
// /api/box: jev へ Box 質問を中継する。
// 処理順: バリデーション → レートリミット → 本日枠消費(上限判定)
//        → getApiKey → callJevBox → 成功 or 失敗時 refund
// ------------------------------------------------------------
export async function handleBox({ bodyJson, clientIp, deps }) {
  const { store, getApiKey, callJevBox, rateLimiter, now, config } = deps;

  // 1. 入力バリデーション
  const v = validateBoxInput(bodyJson || {});
  if (!v.ok) {
    return { status: v.status, json: { error: v.error } };
  }
  const { instructions, imageBase64, format } = v.value;

  // 2. IP レートリミット
  if (rateLimiter && !rateLimiter.check(clientIp).allowed) {
    return {
      status: 429,
      json: {
        error: "アクセスが集中しています。少し待って再試行してください。",
        reason: "rate",
      },
    };
  }

  // 3. 本日枠をアトミックに消費（カウント増分 + 上限判定を同時に）
  const todayKey = tokyoDayKey(now ? now() : new Date());
  const consumed = await store.tryConsume(todayKey, config.DAILY_LIMIT);
  if (!consumed.allowed) {
    // 本日上限に到達: jev を呼ばない
    return {
      status: 429,
      json: {
        error: "本日の上限（100回）に達しました。また明日お試しください。",
        reason: "daily_limit",
        limit: config.DAILY_LIMIT,
        counters: { today: consumed.today, total: consumed.total },
      },
    };
  }

  // 4. 枠が取れた場合のみ jev を呼ぶ
  try {
    const apiKey = await getApiKey();
    const started = Date.now();
    const { response, requestForLog } = await callJevBox(
      apiKey,
      instructions,
      imageBase64,
      format
    );
    const latencyMs = Date.now() - started;

    // 5. 成功
    return {
      status: 200,
      json: {
        request: requestForLog, // APIキー・画像base64全体は含まない
        response, // jev の生レスポンス（answers.target.box など）
        latencyMs,
        endpoint: config.JEV_ENDPOINT,
        model: config.JEV_MODEL,
        counters: {
          today: consumed.today,
          total: consumed.total,
          limit: config.DAILY_LIMIT,
        },
      },
    };
  } catch (err) {
    // 6. jev 失敗: 本日枠のみ戻す（累計は不変）。refund 失敗は握りつぶす
    try {
      await store.refund(todayKey);
    } catch {
      // refund 失敗は安全側（本日枠が 1 多く消費されるだけ）。応答は jev エラー優先
    }
    return { status: 502, json: { error: String(err?.message || err) } };
  }
}

// ------------------------------------------------------------
// /api/translate: Bedrock(Nova) でプロンプトを翻訳する。
// 翻訳も課金対象のため別名前空間 "TR#" の日次上限を適用する。
// 翻訳カウンタは来訪者カウンタ(today/total)には寄与しない。
// ------------------------------------------------------------
export async function handleTranslate({ bodyJson, clientIp, deps }) {
  const { store, translateText, rateLimiter, now, config } = deps;

  // 1. 入力バリデーション
  const v = validateTranslateInput(bodyJson || {});
  if (!v.ok) {
    return { status: v.status, json: { error: v.error } };
  }
  const { text } = v.value;

  // 2. IP レートリミット
  if (rateLimiter && !rateLimiter.check(clientIp).allowed) {
    return {
      status: 429,
      json: {
        error: "アクセスが集中しています。少し待って再試行してください。",
        reason: "rate",
      },
    };
  }

  // 3. 翻訳用の日次上限（別名前空間 "TR#"）
  const todayKey = tokyoDayKey(now ? now() : new Date());
  const trKey = "TR#" + todayKey;
  const consumed = await store.tryConsume(trKey, config.TRANSLATE_DAILY_LIMIT);
  if (!consumed.allowed) {
    return {
      status: 429,
      json: {
        error: "本日の翻訳回数の上限に達しました。また明日お試しください。",
        reason: "translate_daily_limit",
        limit: config.TRANSLATE_DAILY_LIMIT,
      },
    };
  }

  // 4. 枠が取れた場合のみ翻訳する
  try {
    const started = Date.now();
    const result = await translateText(text);
    return {
      status: 200,
      json: { ...result, latencyMs: Date.now() - started },
    };
  } catch (err) {
    // 5. 翻訳失敗: 本日の翻訳枠のみ戻す
    try {
      await store.refund(trKey);
    } catch {
      // refund 失敗は握りつぶす（安全側）
    }
    return { status: 502, json: { error: "翻訳に失敗しました: " + String(err?.message || err) } };
  }
}
