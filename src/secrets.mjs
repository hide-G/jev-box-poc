// ============================================================
// secrets.mjs - Secrets Manager から jev APIキーを取得（環境非依存）
// ------------------------------------------------------------
// 既存 server.mjs の getApiKey() のロジックを切り出したもの。
//   - SecretsManagerClient + GetSecretValueCommand で取得
//   - JSON 形式なら代表的なキー名を順に探す / 平文ならそのまま
//   - プロセス起動中はキーをキャッシュ（モジュールスコープ変数）
// 接続情報(client/secretId)は呼び出し側から注入する。
// ============================================================

import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

// プロセス起動中はキーをキャッシュする（コールドスタート時のみ取得）
let cachedApiKey = null;

// ------------------------------------------------------------
// Secrets Manager から jev APIキーを取得する（キャッシュ付き）。
//   client  : SecretsManagerClient（省略時は region から生成）
//   secretId: 取得する Secret 名
// ------------------------------------------------------------
export async function getApiKey({ client, secretId, region } = {}) {
  if (cachedApiKey) return cachedApiKey;
  if (!secretId) throw new Error("SECRET_ID が未設定です");

  const sm = client || new SecretsManagerClient({ region: region || "ap-northeast-1" });
  const res = await sm.send(new GetSecretValueCommand({ SecretId: secretId }));
  const raw = (res.SecretString || "").trim();
  if (!raw) throw new Error("Secret が空です: " + secretId);

  let key = raw;
  if (raw.startsWith("{")) {
    try {
      const obj = JSON.parse(raw);
      key =
        obj.apiKey ||
        obj.api_key ||
        obj.key ||
        obj.token ||
        obj.JEV_API_KEY ||
        "";
    } catch {
      // JSON でなければ平文として扱う
      key = raw;
    }
  }
  if (!key) throw new Error("Secret から有効な API キーを取得できませんでした");
  cachedApiKey = key;
  return key;
}

// ------------------------------------------------------------
// テスト用: キャッシュをクリアする
// ------------------------------------------------------------
export function _resetApiKeyCache() {
  cachedApiKey = null;
}
