// ============================================================
// jev Box PoC - ローカル中継サーバー (Node.js 20+, ESM)
// ------------------------------------------------------------
// 役割（薄い HTTP アダプタ）:
//   1. ブラウザ(public/)からのリクエストを受け取り JSON を読む
//   2. ビジネスロジックは src/handlers.mjs に委譲する
//      （バリデーション・レートリミット・日次上限・jev/翻訳呼び出し）
//   3. カウンタ永続化は src/store-file.mjs（counter.json）を使う
//   4. 静的ファイル配信（public/ 配下のみ）
//
// セキュリティ:
//   - APIキーは Secrets Manager にのみ存在し、ブラウザには返さない
//   - PoC のためローカル(localhost)専用。CORS は同一オリジン前提
//
// ★ 単一プロセス起動前提（PoC 制約）:
//   counter.json はファイルストアで単一プロセス起動を前提とする。
//   複数起動すると書き込み競合が起こりうる（詳細は src/store-file.mjs）。
// ============================================================

import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, normalize } from "node:path";
import { readFileSync, existsSync } from "node:fs";

import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";

import { loadConfig } from "./src/config.mjs";
import { getApiKey as getApiKeyImpl } from "./src/secrets.mjs";
import { callJevBox as callJevBoxImpl } from "./src/jev.mjs";
import { translateText as translateTextImpl } from "./src/translate.mjs";
import { createFileStore } from "./src/store-file.mjs";
import { createRateLimiter } from "./src/counter.mjs";
import { handleBox, handleTranslate } from "./src/handlers.mjs";

// ---- .env を読み込む（接続情報はリポジトリに置かず .env/環境変数で渡す） ----
// 依存を増やさないための最小ローダー。KEY=VALUE 形式のみ対応。
(function loadDotEnv() {
  const envPath = join(dirname(fileURLToPath(import.meta.url)), ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    // 前後のクォートを外す
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    // 既存の環境変数を優先（コマンドラインで渡した値を上書きしない）
    if (process.env[k] === undefined) process.env[k] = v;
  }
})();

// ---- 設定を読み込む ----
const config = loadConfig(process.env);
// AWS プロファイル。環境変数 AWS_PROFILE（または .env）で指定する。
const AWS_PROFILE = process.env.AWS_PROFILE || "";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");

// 必須の接続情報が無ければ起動時に明示エラー（公開用に既定値を持たないため）
if (!config.SECRET_ID) {
  console.error(
    "[設定エラー] 環境変数 SECRET_ID が未設定です。jev キーを格納した " +
      "Secrets Manager の Secret 名を .env か環境変数で指定してください。"
  );
  process.exit(1);
}

// ---- AWS クライアントとストア・依存オブジェクトを用意する ----
const secretsClient = new SecretsManagerClient({ region: config.AWS_REGION });
const bedrockClient = new BedrockRuntimeClient({ region: config.AWS_REGION });
const store = createFileStore(join(__dirname, "counter.json"));
const rateLimiter = createRateLimiter({
  max: config.RATE_MAX,
  windowMs: config.RATE_WINDOW_MS,
});

// handlers.mjs に注入する依存オブジェクト
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
// リクエストボディ(JSON)を読み取る
// ------------------------------------------------------------
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const LIMIT = 32 * 1024 * 1024; // 32MiB（jev のリクエスト上限に合わせる）
    req.on("data", (c) => {
      size += c.length;
      if (size > LIMIT) {
        reject(new Error("リクエストが大きすぎます（32MiB 上限）"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(new Error("JSON の解析に失敗しました: " + e.message));
      }
    });
    req.on("error", reject);
  });
}

// ------------------------------------------------------------
// 静的ファイル配信（public/ 配下のみ）
// ------------------------------------------------------------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

async function serveStatic(req, res) {
  let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  // ディレクトリトラバーサル対策
  const safePath = normalize(join(PUBLIC_DIR, urlPath));
  if (!safePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const data = await readFile(safePath);
    const mime = MIME[extname(safePath).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime }).end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not Found");
  }
}

// ------------------------------------------------------------
// JSON レスポンス補助（handlers の戻り {status,json} をそのまま返す）
// ------------------------------------------------------------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
  }).end(body);
}

// ============================================================
// HTTP サーバー本体
// ============================================================
const server = http.createServer(async (req, res) => {
  // API: jev へ Box 質問を中継
  if (req.method === "POST" && (req.url || "").startsWith("/api/box")) {
    try {
      const bodyJson = await readJsonBody(req);
      const result = await handleBox({
        bodyJson,
        clientIp: req.socket.remoteAddress,
        deps,
      });
      return sendJson(res, result.status, result.json);
    } catch (err) {
      return sendJson(res, 502, { error: String(err?.message || err) });
    }
  }

  // API: Bedrock(Nova) でプロンプトを翻訳
  if (req.method === "POST" && (req.url || "").startsWith("/api/translate")) {
    try {
      const bodyJson = await readJsonBody(req);
      const result = await handleTranslate({
        bodyJson,
        clientIp: req.socket.remoteAddress,
        deps,
      });
      return sendJson(res, result.status, result.json);
    } catch (err) {
      return sendJson(res, 502, { error: String(err?.message || err) });
    }
  }

  // それ以外は静的ファイル
  if (req.method === "GET") {
    return serveStatic(req, res);
  }

  res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" }).end("Method Not Allowed");
});

server.listen(config.PORT, () => {
  console.log("============================================================");
  console.log(" jev Box PoC サーバー起動");
  console.log(" URL        : http://localhost:" + config.PORT);
  console.log(" AWSプロファイル: " + AWS_PROFILE);
  console.log(" リージョン    : " + config.AWS_REGION);
  console.log(" Secret      : " + config.SECRET_ID);
  console.log(" jevモデル    : " + config.JEV_MODEL);
  console.log(" jevエンドポイント: " + config.JEV_ENDPOINT);
  console.log(" 翻訳モデル    : " + config.BEDROCK_MODEL + " (Amazon Bedrock)");
  console.log(" 日次上限     : jev " + config.DAILY_LIMIT + " / 翻訳 " + config.TRANSLATE_DAILY_LIMIT);
  console.log("============================================================");
});
