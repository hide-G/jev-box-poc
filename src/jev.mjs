// ============================================================
// jev.mjs - jev(TypeSafe AI System One) Box 呼び出し（環境非依存）
// ------------------------------------------------------------
// 既存 server.mjs の callJevBox() を切り出したもの。
//   - UUID の画像参照キー / TypeSafe-Danger-Zone-Images ヘッダ
//   - 429/529 は指数バックオフで最大 4 回リトライ
//   - requestForLog はキー・画像 base64 全体を含めない
// エンドポイント/モデルは呼び出し側から注入する。
// ============================================================

// ------------------------------------------------------------
// jev へ Box 質問を投げる。
//   apiKey      : jev APIキー
//   instructions: 「何を探すか」の自由入力
//   imageBase64 : 画像の base64（data URL プレフィックスは剥がし済み想定）
//   format      : "png" | "jpg" | "jpeg"
//   opts        : { endpoint, model }（省略時は既定値）
// 戻り値: { response, requestForLog }
// ------------------------------------------------------------
export async function callJevBox(apiKey, instructions, imageBase64, format, opts = {}) {
  const endpoint = opts.endpoint || "https://api.typesafe.ai/v1/systemone";
  const model = opts.model || "jev-1.14.0";

  // 画像参照用のユニークなキー（本文中の文字列と誤マッチしないよう UUID を使う）
  const ref = "img-" + crypto.randomUUID();

  const body = {
    model: model,
    // state に画像を1枚だけ置き、question(Box) から参照させる
    state: { image: ref },
    assets: {
      [ref]: {
        kind: "image",
        data_base64: imageBase64,
        format: format, // "png" | "jpg" | "jpeg"
      },
    },
    questions: {
      // 1質問 = 1ボックス。instructions で「何を探すか」を自由に指定する
      target: {
        type: "box",
        instructions: instructions,
      },
    },
  };

  const maxAttempts = 4;
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey,
        // 画像 / Box 質問を有効化するための必須ヘッダー
        "TypeSafe-Danger-Zone-Images": "true",
      },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      const json = await res.json();
      // フロントのログ表示用に、キーを含まないリクエスト概要も返す
      const requestForLog = {
        model: body.model,
        state: body.state,
        // 画像の base64 全体はログに載せない（サイズと形式のみ）
        assets: {
          [ref]: {
            kind: "image",
            format: format,
            data_base64_bytes: imageBase64.length,
          },
        },
        questions: body.questions,
      };
      return { response: json, requestForLog };
    }

    if (res.status === 429 || res.status === 529) {
      lastErr = new Error("jev 一時エラー HTTP " + res.status);
      const waitMs = 300 * Math.pow(2, attempt); // 300,600,1200,2400ms
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    const text = await res.text();
    throw new Error("jev API エラー HTTP " + res.status + ": " + text);
  }
  throw lastErr || new Error("jev API 呼び出しに失敗しました");
}
