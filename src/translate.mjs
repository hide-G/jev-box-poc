// ============================================================
// translate.mjs - Amazon Bedrock(Nova) 翻訳（環境非依存）
// ------------------------------------------------------------
// 既存 server.mjs の translateText() / hasJapanese() を切り出したもの。
//   - 日本語を含めば 日本語→英語、それ以外は 英語→日本語
//   - BedrockRuntimeClient + ConverseCommand（Nova 向けプロンプト）
//   - jev の instructions として使える簡潔な訳文のみを返す
// クライアント/モデルは呼び出し側から注入する。
// ============================================================

import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";

// ------------------------------------------------------------
// 日本語（ひらがな・カタカナ・CJK統合漢字）が含まれるか判定する
// ------------------------------------------------------------
export function hasJapanese(text) {
  return /[\u3040-\u30ff\u3400-\u9fff]/.test(text);
}

// ------------------------------------------------------------
// プロンプトを翻訳する。
//   text: 翻訳する文字列
//   opts: { client, model, region }（省略時は既定値 / クライアント生成）
// 戻り値: { source, translated, direction, model }
// ------------------------------------------------------------
export async function translateText(text, opts = {}) {
  const model = opts.model || "amazon.nova-lite-v1:0";
  const client =
    opts.client ||
    new BedrockRuntimeClient({ region: opts.region || "ap-northeast-1" });

  const toEnglish = hasJapanese(text);
  const target = toEnglish ? "English" : "Japanese";

  // Nova 向けプロンプト。訳文だけを返させる（説明や引用符を付けさせない）
  const instruction =
    `You translate short UI prompts used to locate an object in an image.\n` +
    `Translate the text below into natural ${target}.\n` +
    `Output ONLY the translation. No quotes, no notes, no explanation.\n\n` +
    `Text:\n${text}`;

  const cmd = new ConverseCommand({
    modelId: model,
    messages: [{ role: "user", content: [{ text: instruction }] }],
    inferenceConfig: { maxTokens: 300, temperature: 0 },
  });

  const res = await client.send(cmd);
  const parts = res?.output?.message?.content || [];
  const translated = parts
    .map((p) => p.text || "")
    .join("")
    .trim();

  if (!translated) throw new Error("翻訳結果が空でした");

  return {
    source: text,
    translated,
    direction: toEnglish ? "ja->en" : "en->ja",
    model: model,
  };
}
