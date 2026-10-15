// ============================================================
// config.mjs - 環境変数の読み出しと既定値（環境非依存）
// ------------------------------------------------------------
// ローカル(server.mjs)と Lambda(lambda/index.mjs)の両方が
// この loadConfig() を呼び、同じ既定値体系で設定を得る。
// 既存 server.mjs の設定ブロックの既定値を踏襲している。
// ============================================================

// ------------------------------------------------------------
// 環境変数(env)から設定オブジェクトを組み立てて返す。
// 引数 env は省略時 process.env（テスト時は任意オブジェクトを注入可能）。
// ------------------------------------------------------------
export function loadConfig(env = process.env) {
  return {
    // ローカルサーバーの待ち受けポート
    PORT: Number(env.PORT || 8787),
    // AWS リージョン（既定は東京）
    AWS_REGION: env.AWS_REGION || "ap-northeast-1",
    // jev APIキーを格納した Secrets Manager の Secret 名（接続情報は環境変数で注入）
    SECRET_ID: env.SECRET_ID || "",
    // jev(TypeSafe AI System One) のエンドポイント
    JEV_ENDPOINT: env.JEV_ENDPOINT || "https://api.typesafe.ai/v1/systemone",
    // Box 質問には Jev 1.14 が必要
    JEV_MODEL: env.JEV_MODEL || "jev-1.14.0",
    // 翻訳に使う Amazon Bedrock のモデル（軽量・高速な Nova Lite を既定にする）
    BEDROCK_MODEL: env.BEDROCK_MODEL || "amazon.nova-lite-v1:0",
    // jev(/api/box) の 1 日あたりの上限回数
    DAILY_LIMIT: Number(env.DAILY_LIMIT || 100),
    // 翻訳(/api/translate) の 1 日あたりの上限回数（コスト制御専用・表示しない）
    TRANSLATE_DAILY_LIMIT: Number(env.TRANSLATE_DAILY_LIMIT || 100),
    // IP レートリミット: ウィンドウ内の最大リクエスト数
    RATE_MAX: Number(env.RATE_MAX || 10),
    // IP レートリミット: ウィンドウ幅（ミリ秒）
    RATE_WINDOW_MS: Number(env.RATE_WINDOW_MS || 60000),
    // DynamoDB のカウンタテーブル名（AWS 用。ローカルでは未使用）
    COUNTER_TABLE: env.COUNTER_TABLE || "",
    // CORS 許可オリジン（AWS 用。CloudFront ドメインを注入）
    ALLOWED_ORIGIN: env.ALLOWED_ORIGIN || "",
  };
}
