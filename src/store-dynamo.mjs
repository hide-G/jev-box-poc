// ============================================================
// store-dynamo.mjs - CounterStore 実装（DynamoDB）
// ------------------------------------------------------------
// 日次使用上限と来訪者カウンタの永続化先（AWS 用）。
// store-file.mjs と同一の CounterStore 契約を実装する。
//
// 契約（CounterStore 共通・store-file.mjs と同一挙動）:
//   tryConsume(nsDayKey, limit) -> { allowed, today, total }
//   refund(nsDayKey)            -> Promise<void>（本日 count のみ -1・total 不変）
//   peek(nsDayKey)              -> { today, total }
//
// nsDayKey が "TR#" 始まり    → pk="DAYTR#<日付>"（翻訳系・total:null）
// nsDayKey がそれ以外（日付） → pk="DAY#<日付>"  （jev 系・成功時 total++）
//
// DynamoDB スキーマ（単一テーブル・pk パーティションキーのみ）:
//   pk="DAY#2025-05-20"   { count, expireAt(TTL) }  jev 本日カウンタ
//   pk="TOTAL"            { count }                  jev 累計カウンタ
//   pk="DAYTR#2025-05-20" { count, expireAt(TTL) }   翻訳 本日カウンタ
//
// テーブル名は環境変数 COUNTER_TABLE で注入する（ハードコードしない）。
// ============================================================

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  UpdateCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";

// 本日 item の TTL（当日から何日後に自動削除するか）
const TTL_DAYS = 3;

// ------------------------------------------------------------
// nsDayKey を解析して { pk, dayKey, isTr } に分解する。
//   "TR#2025-05-20" -> { pk:'DAYTR#2025-05-20', dayKey:'2025-05-20', isTr:true }
//   "2025-05-20"    -> { pk:'DAY#2025-05-20',   dayKey:'2025-05-20', isTr:false }
// ------------------------------------------------------------
function parseNsDayKey(nsDayKey) {
  if (nsDayKey.startsWith("TR#")) {
    const dayKey = nsDayKey.slice(3);
    return { pk: "DAYTR#" + dayKey, dayKey, isTr: true };
  }
  return { pk: "DAY#" + nsDayKey, dayKey: nsDayKey, isTr: false };
}

// 本日 item の TTL（epoch 秒）を計算する
function computeExpireAt(now = Date.now()) {
  return Math.floor(now / 1000) + TTL_DAYS * 24 * 60 * 60;
}

// ------------------------------------------------------------
// CounterStore（DynamoDB 実装）を生成する。
//   opts.tableName  カウンタテーブル名（既定: process.env.COUNTER_TABLE）
//   opts.region     リージョン（client 省略時に使用）
//   opts.client     DynamoDBClient（テスト時に注入可能）
//   opts.now        () => number（epoch ミリ秒。TTL 計算に使用。テスト用）
// ------------------------------------------------------------
export function createDynamoStore(opts = {}) {
  const tableName = opts.tableName || process.env.COUNTER_TABLE;
  if (!tableName) {
    throw new Error("COUNTER_TABLE（DynamoDB テーブル名）が未設定です。");
  }
  const now = opts.now || (() => Date.now());

  const baseClient =
    opts.client || new DynamoDBClient({ region: opts.region });
  const doc = DynamoDBDocumentClient.from(baseClient, {
    marshallOptions: { removeUndefinedValues: true },
  });

  return {
    // ----------------------------------------------------------
    // 本日枠をアトミックに 1 消費する。
    // ステップ1: 本日 item を条件付きアトミック増分（count < limit のときのみ）。
    //            ConditionalCheckFailedException は上限到達 → allowed:false。
    // ステップ2: jev 系のみ TOTAL を無条件増分し累計を得る。
    //            （翻訳系はスキップし total:null）
    // ----------------------------------------------------------
    async tryConsume(nsDayKey, limit) {
      const { pk, isTr } = parseNsDayKey(nsDayKey);

      // ---- ステップ1: 本日 item の条件付き増分 ----
      let today;
      try {
        const res = await doc.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { pk },
            // count = if_not_exists(count,0)+1、expireAt は未設定時のみセット
            UpdateExpression:
              "SET #c = if_not_exists(#c, :zero) + :one, expireAt = if_not_exists(expireAt, :exp)",
            // 本日分が存在しない or limit 未満のときのみ増分する
            ConditionExpression: "attribute_not_exists(#c) OR #c < :limit",
            ExpressionAttributeNames: { "#c": "count" },
            ExpressionAttributeValues: {
              ":zero": 0,
              ":one": 1,
              // :limit は呼び出し側から渡された limit を束縛（100 をハードコードしない）
              ":limit": limit,
              ":exp": computeExpireAt(now()),
            },
            ReturnValues: "UPDATED_NEW",
          })
        );
        today = res.Attributes.count;
      } catch (err) {
        if (err?.name === "ConditionalCheckFailedException") {
          // 上限到達: 消費せず現在値を peek で返す
          const peeked = await this.peek(nsDayKey);
          return { allowed: false, today: peeked.today, total: peeked.total };
        }
        // スロットリング/権限/接続などは呼び出し元（handlers）へ伝播
        throw err;
      }

      // ---- ステップ2: jev 系のみ累計 TOTAL を無条件増分 ----
      if (isTr) {
        // 翻訳系は累計に寄与しない
        return { allowed: true, today, total: null };
      }
      try {
        const totalRes = await doc.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { pk: "TOTAL" },
            UpdateExpression: "SET #c = if_not_exists(#c, :zero) + :one",
            ExpressionAttributeNames: { "#c": "count" },
            ExpressionAttributeValues: { ":zero": 0, ":one": 1 },
            ReturnValues: "UPDATED_NEW",
          })
        );
        return { allowed: true, today, total: totalRes.Attributes.count };
      } catch (err) {
        // 本日枠は確保済み。累計増分の失敗は warn のみで続行（total:null）
        console.warn(
          "[store-dynamo] TOTAL の累計増分に失敗しました（本日枠は確保済み）: " +
            String(err?.message || err)
        );
        return { allowed: true, today, total: null };
      }
    },

    // ----------------------------------------------------------
    // 失敗時の補償。本日 item の count のみ -1（累計 item には触れない）。
    // 負数防止のため #c > 0 のときのみ -1。失敗（0/未存在）は無視。
    // ----------------------------------------------------------
    async refund(nsDayKey) {
      const { pk } = parseNsDayKey(nsDayKey);
      try {
        await doc.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { pk },
            UpdateExpression: "SET #c = #c - :one",
            ConditionExpression: "#c > :zero",
            ExpressionAttributeNames: { "#c": "count" },
            ExpressionAttributeValues: { ":one": 1, ":zero": 0 },
          })
        );
      } catch (err) {
        if (err?.name === "ConditionalCheckFailedException") {
          // 0 または未存在: 補償不要
          return;
        }
        // その他のエラーは安全側で握りつぶす（本日枠が 1 多く消費されるだけ）
        console.warn(
          "[store-dynamo] refund に失敗しました: " + String(err?.message || err)
        );
      }
    },

    // ----------------------------------------------------------
    // 表示用の現在値取得（消費を伴わない）。
    // 本日 item の count を読む。jev 系はさらに TOTAL を読む。
    // 未存在は 0 扱い。翻訳系は total:null。
    // ----------------------------------------------------------
    async peek(nsDayKey) {
      const { pk, isTr } = parseNsDayKey(nsDayKey);
      const dayRes = await doc.send(
        new GetCommand({ TableName: tableName, Key: { pk } })
      );
      const today = dayRes.Item?.count || 0;

      if (isTr) {
        return { today, total: null };
      }
      const totalRes = await doc.send(
        new GetCommand({ TableName: tableName, Key: { pk: "TOTAL" } })
      );
      return { today, total: totalRes.Item?.count || 0 };
    },
  };
}
