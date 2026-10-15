// ============================================================
// validate.test.mjs - 入力バリデーションのユニットテスト
// ============================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { validateBoxInput, validateTranslateInput } from "./validate.mjs";

// 100文字超の妥当な base64 文字列を作る（長さ 200 の 'A' は base64 妥当）
const VALID_B64 = "A".repeat(200);

test("validateBoxInput: 正常系（format 既定 png）", () => {
  const r = validateBoxInput({ instructions: "  数字  ", imageBase64: VALID_B64 });
  assert.equal(r.ok, true);
  assert.equal(r.value.instructions, "数字"); // trim される
  assert.equal(r.value.format, "png");
  assert.equal(r.value.imageBase64, VALID_B64);
});

test("validateBoxInput: data URL プレフィックスを剥がす", () => {
  const r = validateBoxInput({
    instructions: "x",
    imageBase64: "data:image/png;base64," + VALID_B64,
    format: "jpg",
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.imageBase64, VALID_B64);
  assert.equal(r.value.format, "jpg");
});

test("validateBoxInput: instructions 必須・空は 400", () => {
  assert.equal(validateBoxInput({ imageBase64: VALID_B64 }).status, 400);
  assert.equal(validateBoxInput({ instructions: "   ", imageBase64: VALID_B64 }).status, 400);
});

test("validateBoxInput: instructions 1000文字超は 400", () => {
  const r = validateBoxInput({ instructions: "あ".repeat(1001), imageBase64: VALID_B64 });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
});

test("validateBoxInput: imageBase64 必須・不正形式は 400", () => {
  assert.equal(validateBoxInput({ instructions: "x" }).status, 400);
  // 不正文字を含む
  assert.equal(validateBoxInput({ instructions: "x", imageBase64: "!!!" + VALID_B64 }).status, 400);
  // 短すぎる（100文字以下）
  assert.equal(validateBoxInput({ instructions: "x", imageBase64: "AAAA" }).status, 400);
});

test("validateBoxInput: format 不正は 400", () => {
  const r = validateBoxInput({ instructions: "x", imageBase64: VALID_B64, format: "gif" });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
});

test("validateTranslateInput: 正常系と空・超過", () => {
  const ok = validateTranslateInput({ text: "  左上の数字  " });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.text, "左上の数字");

  assert.equal(validateTranslateInput({ text: "" }).status, 400);
  assert.equal(validateTranslateInput({}).status, 400);
  assert.equal(validateTranslateInput({ text: "a".repeat(1001) }).status, 400);
});
