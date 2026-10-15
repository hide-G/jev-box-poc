// ============================================================
// lambda/index.mjs - Lambda Function URL エントリ（薄いアダプタ）
// ------------------------------------------------------------
// 役割:
//   1. Function URL イベントを { method, path, bodyJson, clientIp } に正規化
//   2. ビジネスロジックは src/handlers.mjs に委譲する
//      （ローカルの server.mjs と同一コードを共有）
//   3. カウンタ永続化は src/store-dynamo.mjs（DynamoDB）を使う
//   4. 全応答（エラー含む）に CORS ヘッダを付与する
//   5. OPTIONS プリフライトは 204 で即応答
//   6. 静的配信はしない（S3 + CloudFront が担当）
//
// 環境変数（CDK が注入）:
//   COUNTER_TABLE / SECRET_ID / AWS_REGION(ランタイム既定) /
//   BEDROCK_MODEL / JEV_ENDPOINT / JEV_MODEL /
//   DAILY_LIMIT / TRANSLATE_DAILY_LIMIT / ALLOWED_ORIGIN
// ============================================================

import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";

import { loadConfig } from "../src/config.mjs";
import { getApiKey as getApiKeyImpl } from "../src/secrets.mjs";
import { callJevBox as callJevBoxImpl } from "../src/jev.mjs";
import { translateText as translateTextImpl } from "../src/translate.mjs";
import { createDynamoStore } from "../src/store-dynamo.mjs";
import { createRateLimiter } from "../src/counter.mjs";
import { handleBox, handleTranslate } from "../src/handlers.mjs";

// ---- 設定・クライアント・ストアはコンテナ再利用のためモジュール読込時に 1 回だけ生成 ----
const config = loadConfig(process.env);
const secretsClient = new SecretsManagerClient({ region: config.AWS_REGION });
const bedrockClient = new BedrockRuntimeClient({ region: config.AWS_REGION });
const store = createDynamoStore({
  tableName: config.COUNTER_TABLE,
  region: config.AWS_REGION,
});
const rateLimiter = createRateLimiter({
  max: config.RATE_MAX,
  windowMs: config.RATE_WINDOW_MS,
});

// handlers.mjs に注入する依存オブジェクト（ローカルと同一の形）
const deps = {
  store,
  rateLimiter,
  config,
  now: () => new Date(),
  getApiKey: () =>
    getApiKeyImpl({ client: secretsClient, secretId: config.SECRET_ID }),
  callJevBox: (apiKey, instructions, imageBase64, format) =>
    callJevBoxImpl(apiKey, instructions, imageBase64, format, {
      endpoint: config.JEV_ENDPOINT,
      model: config.JEV_MODEL,
    }),
  translateText: (text) =>
    translateTextImpl(text, { client: bedrockClient, model: config.BEDROCK_MODEL }),
};

// ------------------------------------------------------------
// CORS ヘッダを組み立てる。
// Access-Control-Allow-Origin は ALLOWED_ORIGIN と完全一致したときのみ返す
// （公開はするが「CloudFront のオリジンのみ許可」の方針）。
// ※ フロント(app.js)が送るのは Content-Type: application/json のみ。
//   認証ヘッダや独自ヘッダを足す場合は Allow-Headers に追記が必要。
// ------------------------------------------------------------
function corsHeaders(requestOrigin) {
  const headers = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  // 完全一致検証: 一致したオリジンにのみ ACAO を返す
  if (config.ALLOWED_ORIGIN && requestOrigin === config.ALLOWED_ORIGIN) {
    headers["Access-Control-Allow-Origin"] = config.ALLOWED_ORIGIN;
  }
  return headers;
}

// JSON 応答（CORS ヘッダ付与）を Function URL 形式で組み立てる
function jsonResponse(status, obj, requestOrigin) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(requestOrigin),
    },
    body: JSON.stringify(obj),
  };
}

// ------------------------------------------------------------
// Lambda ハンドラ（Function URL のペイロード format 2.0）
// ------------------------------------------------------------
export async function handler(event) {
  const http = event?.requestContext?.http || {};
  const method = http.method || "GET";
  const rawPath = http.path || event?.rawPath || "/";
  const clientIp = http.sourceIp;
  // Origin ヘッダはキーの大文字小文字が不定なので両方見る
  const reqHeaders = event?.headers || {};
  const requestOrigin = reqHeaders.origin || reqHeaders.Origin || "";

  // ---- OPTIONS プリフライトは 204 で即応答 ----
  if (method === "OPTIONS") {
    return {
      statusCode: 204,
      headers: corsHeaders(requestOrigin),
      body: "",
    };
  }

  // ---- ボディを JSON として読む（base64 エンコードされている場合は decode） ----
  let bodyJson = {};
  if (event?.body) {
    try {
      const raw = event.isBase64Encoded
        ? Buffer.from(event.body, "base64").toString("utf8")
        : event.body;
      bodyJson = raw ? JSON.parse(raw) : {};
    } catch (e) {
      return jsonResponse(
        400,
        { error: "JSON の解析に失敗しました: " + e.message },
        requestOrigin
      );
    }
  }

  // ---- ルーティング（/api/box・/api/translate のみ） ----
  try {
    if (method === "POST" && rawPath.startsWith("/api/box")) {
      const result = await handleBox({ bodyJson, clientIp, deps });
      return jsonResponse(result.status, result.json, requestOrigin);
    }
    if (method === "POST" && rawPath.startsWith("/api/translate")) {
      const result = await handleTranslate({ bodyJson, clientIp, deps });
      return jsonResponse(result.status, result.json, requestOrigin);
    }
    // それ以外は 404
    return jsonResponse(404, { error: "Not Found" }, requestOrigin);
  } catch (err) {
    return jsonResponse(
      502,
      { error: String(err?.message || err) },
      requestOrigin
    );
  }
}
