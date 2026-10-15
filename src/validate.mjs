// ============================================================
// validate.mjs - 入力バリデーション（環境非依存）
// ------------------------------------------------------------
// /api/box と /api/translate の入力検証を関数化し、
// ローカル/Lambda どちらのアダプタでも同じ検証を走らせる。
// NG 時は { ok:false, status:400, error:'<日本語>' } を返す。
// OK 時は { ok:true, value:{...} }（正規化済みの値）を返す。
// ============================================================

// 入力テキストの最大文字数
const MAX_TEXT_LEN = 1000;
// decode 後の画像サイズ上限（32 MiB。jev のリクエスト上限に合わせる）
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
// base64 妥当性チェック用の正規表現
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

// ------------------------------------------------------------
// /api/box の入力を検証する。
//   instructions: 必須・string・trim後非空・最大1000文字
//   imageBase64 : 必須・string・base64妥当・decode後32MiB上限
//                 （data URL プレフィックスは剥がす）
//   format      : 省略時 png。png|jpg|jpeg のみ
// ------------------------------------------------------------
export function validateBoxInput({ instructions, imageBase64, format } = {}) {
  // instructions の検証
  if (typeof instructions !== "string") {
    return { ok: false, status: 400, error: "instructions（プロンプト）は必須です" };
  }
  const instr = instructions.trim();
  if (!instr) {
    return { ok: false, status: 400, error: "instructions（プロンプト）は必須です" };
  }
  if (instr.length > MAX_TEXT_LEN) {
    return {
      ok: false,
      status: 400,
      error: `instructions（プロンプト）は最大 ${MAX_TEXT_LEN} 文字です`,
    };
  }

  // imageBase64 の検証
  if (typeof imageBase64 !== "string" || !imageBase64) {
    return { ok: false, status: 400, error: "imageBase64（画像）は必須です" };
  }
  // data URL プレフィックス（例: "data:image/png;base64,"）を剥がす
  let b64 = imageBase64;
  const comma = b64.indexOf(",");
  if (b64.startsWith("data:") && comma >= 0) {
    b64 = b64.slice(comma + 1);
  }
  b64 = b64.trim();
  if (b64.length <= 100 || !BASE64_RE.test(b64)) {
    return { ok: false, status: 400, error: "imageBase64（画像）の形式が不正です" };
  }
  // decode 後サイズを base64 長から概算（4文字 → 3バイト、末尾 = を補正）
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  const decodedBytes = Math.floor((b64.length * 3) / 4) - padding;
  if (decodedBytes > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      status: 400,
      error: "imageBase64（画像）が大きすぎます（32MiB 上限）",
    };
  }

  // format の検証（既定 png）
  const fmt = (format || "png").toLowerCase();
  if (!["png", "jpg", "jpeg"].includes(fmt)) {
    return { ok: false, status: 400, error: "format は png / jpg / jpeg のいずれかです" };
  }

  return { ok: true, value: { instructions: instr, imageBase64: b64, format: fmt } };
}

// ------------------------------------------------------------
// /api/translate の入力を検証する。
//   text: 必須・string・trim後非空・最大1000文字
// ------------------------------------------------------------
export function validateTranslateInput({ text } = {}) {
  if (typeof text !== "string") {
    return { ok: false, status: 400, error: "text（翻訳する文字列）は必須です" };
  }
  const t = text.trim();
  if (!t) {
    return { ok: false, status: 400, error: "text（翻訳する文字列）は必須です" };
  }
  if (t.length > MAX_TEXT_LEN) {
    return {
      ok: false,
      status: 400,
      error: `text（翻訳する文字列）は最大 ${MAX_TEXT_LEN} 文字です`,
    };
  }
  return { ok: true, value: { text: t } };
}
